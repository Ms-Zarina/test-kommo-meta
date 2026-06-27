/**
 * AI provider.
 *
 * Provider-agnostic reply generation. Today it calls Claude (Anthropic). To
 * switch to OpenRouter / OpenAI, replace ONLY the request block below — the
 * contract stays the same:
 *
 *     generateReply({ context, userMessage }) -> { text, source }
 *
 * so server.js, the context builder and the pipeline never change.
 *
 * Knows nothing about Instagram or where the context came from. It only needs
 * `context.systemPrompt` (the assembled prompt) and `context.hasKnowledgeBase`
 * (whether there is anything to answer from).
 */

const axios = require("axios");

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const FALLBACK_MESSAGE =
  "Спасибо за сообщение. Наш специалист скоро свяжется с вами.";

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

async function generateReply({ context = {}, userMessage } = {}) {
  // No usable context (e.g. empty knowledge base) → safe fallback, no model call.
  if (!context.hasKnowledgeBase) {
    return { text: FALLBACK_MESSAGE, source: "fallback_no_knowledge_base" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!hasValue(apiKey)) {
    console.warn("ANTHROPIC_API_KEY_MISSING");
    return { text: FALLBACK_MESSAGE, source: "fallback_no_api_key" };
  }

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: context.systemPrompt,
        messages: [{ role: "user", content: String(userMessage || "") }]
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        timeout: 20000
      }
    );

    const text = (response.data?.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!hasValue(text)) {
      return { text: FALLBACK_MESSAGE, source: "fallback_empty_reply" };
    }

    console.log("AI_REPLY_GENERATED", {
      model: ANTHROPIC_MODEL,
      userTextLength: String(userMessage || "").length,
      replyLength: text.length
    });
    return { text, source: "ai" };
  } catch (error) {
    console.error("AI_REPLY_ERROR", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    return { text: FALLBACK_MESSAGE, source: "fallback_ai_error" };
  }
}

module.exports = { generateReply, FALLBACK_MESSAGE };
