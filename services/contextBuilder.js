/**
 * Context builder.
 *
 * The single place that assembles everything the AI needs to answer. Today it
 * merges:
 *   - knowledge_base.md          (knowledgeProvider)
 *   - live prices/promotions     (googleSheetsProvider)
 *
 * Future sources plug in HERE and nowhere else — server.js and aiProvider stay
 * untouched when we add:
 *   - Altegio availability / schedule
 *   - Kommo lead state
 *   - FAQ
 *   - documents
 *
 * server.js no longer knows where context comes from; it just calls:
 *
 *     const context = await buildContext(userMessage);
 *
 * Returns { systemPrompt, hasKnowledgeBase, hasPricing }.
 */

const knowledgeProvider = require("./knowledgeProvider");
const googleSheetsProvider = require("./googleSheetsProvider");

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

// Behavioural instructions for the assistant. Kept with the context because
// they frame how the context below must be used.
const PROMPT_INSTRUCTIONS = [
  "You are the Instagram Direct assistant for the clinic described in the knowledge base below.",
  "Use the KNOWLEDGE BASE for descriptions: what a procedure is, who it suits, contraindications, preparation, aftercare, duration, and the base price.",
  "For clinic / medical / pricing questions not covered by the available information, do not invent anything — offer to pass the request to a specialist.",
  "Keep replies friendly and natural, suitable for Instagram Direct.",
  "",
  "GREETING & SMALL TALK",
  "- Greet and introduce yourself as the ALTOS clinic assistant ONLY when the customer's message is itself a greeting or small talk (e.g. \"привет\", \"здравствуйте\", \"hi\", \"hello\", \"ahoj\", \"dobrý den\", \"hallo\", \"guten Tag\", \"привіт\", \"ok\", \"thanks\", \"спасибо\"). Keep it to ONE short sentence plus an invitation to ask; optionally one emoji.",
  "- For any OTHER message (a real question or request), answer DIRECTLY. Do NOT open with a greeting like \"Здравствуйте\"/\"Hello\", do NOT re-introduce yourself or the clinic, and do NOT repeat a greeting — assume the customer already knows who you are. Greet at most once, and only in reply to the customer's own greeting.",
  "- Never tell the customer to wait for a specialist just because they greeted; do NOT dump procedure lists or prices inside a greeting.",
  "- If a message is a greeting PLUS a real question, give a brief one-line greeting and then answer the question.",
  "",
  "LANGUAGE RULES",
  "- Detect the language of the customer's latest message.",
  "- Reply in the same language.",
  "- CRITICAL: the knowledge base and pricing data are written in Russian, but you MUST answer in the CUSTOMER'S language — NOT Russian. Translate everything (descriptions, prices, promotions) into their language. English message → the ENTIRE reply in English; Czech → Czech; German → German; Ukrainian → Ukrainian. Never reply in Russian to a non-Russian message.",
  "- Produce a natural native-level response, not a literal translation.",
  "- Preserve the meaning, pricing, promotions and medical safety information.",
  "- Never mention that the response was translated.",
  "- If the message mixes languages, use the dominant language.",
  "- If the language cannot be determined (e.g. \"ok\", \"hi\", \"цена?\"), use the customer's previous language if available; otherwise use English.",
  "- Do NOT use any external or automatic translation service — you produce the wording yourself, in context.",
  "- Translate procedure names and medical terminology correctly into the target language; do NOT transliterate them.",
  "- Per-language tone: Russian — like a warm clinic administrator; English — natural British/international English; Czech — natural conversational Czech, never machine-translated; German — natural German; Ukrainian — natural Ukrainian.",
  "",
  "PRICING RULES (strict):",
  "- Never invent prices. Use only the information provided to you.",
  "- NEVER reveal internal data sources. The KNOWLEDGE BASE and the PRICING OVERLAY are INTERNAL only. Never say \"из Google таблицы\", \"по базе знаний\", \"таблица\", \"база данных\", \"из системы\" or anything that hints where the data comes from. The client must never learn about internal sources.",
  "- price_type=promotion → present it naturally as an active promotion: show the PROMOTIONAL price FIRST, then the regular price WITHOUT the promotion. Use a friendly format, for example:",
  "      ✨ Сейчас действует акция:",
  "      💚 Акционная цена — <promo_price>",
  "      Обычная цена без акции — <regular_price>",
  "  A no-emoji variant is also fine when the tone calls for it: \"Сейчас действует специальное предложение. Акционная цена: <promo_price>. Обычная цена без акции: <regular_price>.\" Here <promo_price> is the current promotional price and <regular_price> is that service's normal price (its base price).",
  "- price_type=override → the price was simply updated (NOT a promotion). State it plainly, WITHOUT the word \"акция\" and WITHOUT a second/old price, e.g.: \"Актуальная стоимость процедуры — <price>.\"",
  "- No promotion and no override (service not in the overlay) → state only the single current price, naturally, without the word \"акция\" and without any second price.",
  "- price_type=inactive → do not offer or book the service. Reply: \"Сейчас эту услугу лучше уточнить у администратора — доступность может меняться. Я могу передать ваш запрос специалисту.\"",
  "- When a promotion is active, always show the promotional price first and make clear it is акционная; never hide that it is promotional."
];

// Max characters of the knowledge base to inject per request. The free
// OpenRouter tier caps the prompt at a LOW, VARIABLE limit (seen 17327, then
// 9583 tokens). We keep the FULL base in knowledge_base.md and send only the
// sections relevant to the current question, capped to this budget.
// 13000 Cyrillic chars ≈ ~5.5k tokens; with instructions + pricing overlay the
// whole prompt stays ~6.5k tokens, under the current free-tier limit.
// Tune without a code deploy via the MAX_KB_CHARS env var if the limit changes.
const MAX_KB_CHARS = Number(process.env.MAX_KB_CHARS) || 13000;

// Split the markdown knowledge base into sections by heading (#, ##, ...).
function splitKnowledgeSections(md) {
  const sections = [];
  let current = { title: "(intro)", lines: [] };
  for (const line of String(md).split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      if (current.lines.length) sections.push(current);
      current = {
        title: line.replace(/^#{1,6}\s*/, "").replace(/\*+/g, "").trim(),
        lines: [line]
      };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) sections.push(current);
  return sections.map((s) => ({ title: s.title, text: s.lines.join("\n") }));
}

// Normalize text for keyword matching: lowercase, unify the CO₂/CO² subscript
// with the ASCII "CO2" users type, and drop markdown markers.
function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[₂²]/g, "2")
    .replace(/[*#]/g, " ");
}

// Pick the knowledge-base sections most relevant to the user's message, always
// keeping the general-info section, and stay within MAX_KB_CHARS. If the whole
// base already fits, it is returned unchanged (no information lost).
function selectRelevantKnowledge(md, userMessage) {
  const full = String(md || "");
  if (full.length <= MAX_KB_CHARS) {
    return full;
  }

  const sections = splitKnowledgeSections(full);
  const terms = normalizeForMatch(userMessage)
    .split(/[^a-zа-яё0-9]+/i)
    .filter((w) => w.length >= 3);

  // Count term hits in the body; a hit in the heading is a much stronger
  // signal, so it is weighted heavily.
  const scoreOf = (section) => {
    if (!terms.length) return 0;
    const body = normalizeForMatch(section.text);
    const title = normalizeForMatch(section.title);
    let s = 0;
    for (const t of terms) {
      let idx = body.indexOf(t);
      while (idx !== -1) {
        s += 1;
        idx = body.indexOf(t, idx + t.length);
      }
      if (title.includes(t)) s += 8;
    }
    return s;
  };
  const scores = sections.map((section) => scoreOf(section));

  // Always include the general clinic info (contacts, hours, booking, rules).
  let coreIdx = sections.findIndex((s) => /ОБЩАЯ ИНФОРМАЦ/i.test(s.title));
  if (coreIdx < 0) coreIdx = 0;

  const chosen = new Set([coreIdx]);
  let size = sections[coreIdx].text.length;

  // Add the highest-scoring relevant sections until the budget is reached.
  const byScore = sections
    .map((_, i) => i)
    .sort((a, b) => scores[b] - scores[a] || a - b);
  for (const i of byScore) {
    if (chosen.has(i) || scores[i] === 0) continue;
    if (size + sections[i].text.length > MAX_KB_CHARS) continue;
    chosen.add(i);
    size += sections[i].text.length;
  }

  // Nothing matched (e.g. greeting / generic) → fill by document order.
  if (chosen.size === 1) {
    for (let i = 0; i < sections.length; i += 1) {
      if (chosen.has(i)) continue;
      if (size + sections[i].text.length > MAX_KB_CHARS) break;
      chosen.add(i);
      size += sections[i].text.length;
    }
  }

  const picked = [...chosen]
    .sort((a, b) => a - b)
    .map((i) => sections[i].text)
    .join("\n\n");

  console.log("KNOWLEDGE_SELECTED", {
    totalSections: sections.length,
    pickedSections: chosen.size,
    chars: picked.length,
    budgetChars: MAX_KB_CHARS
  });
  return picked;
}

async function buildContext(userMessage) {
  const fullKnowledgeBase = knowledgeProvider.loadKnowledgeBase();
  const hasKnowledgeBase = hasValue(fullKnowledgeBase);

  // Inject only the relevant sections to keep the prompt within the model's
  // input-token limit. hasKnowledgeBase is based on the FULL base.
  const knowledgeBase = hasKnowledgeBase
    ? selectRelevantKnowledge(fullKnowledgeBase, userMessage)
    : "";

  // Pricing overlay is best-effort: any failure must not break the AI.
  let pricingContext = "";
  try {
    pricingContext = await googleSheetsProvider.buildPricingContext();
  } catch (error) {
    console.error("GOOGLE_SHEETS_ERROR", { message: error.message });
  }
  const hasPricing = hasValue(pricingContext);

  // Assemble the system prompt: instructions + knowledge base + (optional)
  // pricing overlay. New sources are appended here as additional blocks.
  let systemPrompt = [
    PROMPT_INSTRUCTIONS.join("\n"),
    "",
    "=== KNOWLEDGE BASE ===",
    knowledgeBase || ""
  ].join("\n");

  if (hasPricing) {
    systemPrompt +=
      "\n\n=== CURRENT PRICES & PROMOTIONS (Google Sheets) ===\n" + pricingContext;
  }

  console.log("AI_CONTEXT_BUILT", {
    hasKnowledgeBase,
    knowledgeBaseLength: knowledgeBase ? knowledgeBase.length : 0,
    hasPricing
  });

  return { systemPrompt, hasKnowledgeBase, hasPricing };
}

module.exports = { buildContext };
