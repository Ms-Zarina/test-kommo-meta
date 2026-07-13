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
  "- If the customer's message is a greeting or small talk (e.g. \"привет\", \"здравствуйте\", \"добрый день\", \"hi\", \"hello\", \"ahoj\", \"dobrý den\", \"hallo\", \"guten Tag\", \"привіт\", \"добрий день\", \"ok\", \"thanks\", \"спасибо\"), respond warmly and briefly. Do NOT tell the customer to wait for a specialist and do NOT dump procedure lists or prices.",
  "- Greet back in the customer's language, briefly introduce yourself as the ALTOS clinic assistant, and invite them to ask about procedures, prices or booking. Keep it to 1–2 short sentences; optionally one friendly emoji.",
  "- Example (Russian, adapt naturally to the customer's language): \"Здравствуйте! 👋 Это ассистент клиники ALTOS. Подскажите, какая процедура вас интересует — с удовольствием помогу с информацией и записью.\"",
  "- If the message is a greeting PLUS a real question, greet in one short line and then answer the question.",
  "",
  "LANGUAGE RULES",
  "- Detect the language of the customer's latest message.",
  "- Reply in the same language.",
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

// eslint-disable-next-line no-unused-vars -- userMessage is reserved for future
// per-message retrieval (FAQ search, Kommo lead lookup, intent-based context).
async function buildContext(userMessage) {
  const knowledgeBase = knowledgeProvider.loadKnowledgeBase();

  // Pricing overlay is best-effort: any failure must not break the AI.
  let pricingContext = "";
  try {
    pricingContext = await googleSheetsProvider.buildPricingContext();
  } catch (error) {
    console.error("GOOGLE_SHEETS_ERROR", { message: error.message });
  }

  const hasKnowledgeBase = hasValue(knowledgeBase);
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
