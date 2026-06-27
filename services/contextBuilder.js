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
  "Answer ONLY using information from the knowledge base.",
  "If the answer is not covered there, do not invent it — ask the user to wait for a specialist.",
  "Reply in the same language the user wrote in. Keep replies short and friendly, suitable for Instagram Direct.",
  "Never invent prices, services or medical advice that is not in the knowledge base."
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
