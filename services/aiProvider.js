/**
 * AI provider.
 *
 * Provider-agnostic reply generation. Supports two backends with the SAME
 * contract, so server.js, the context builder and the pipeline never change:
 *
 *     generateReply({ context, userMessage }) -> { text, source }
 *
 *   - anthropic   → https://api.anthropic.com/v1/messages   (key: ANTHROPIC_API_KEY)
 *   - openrouter  → https://openrouter.ai/api/v1/chat/completions (key: OPENROUTER_API_KEY)
 *
 * Provider selection:
 *   - AI_PROVIDER=anthropic | openrouter  (explicit), OR
 *   - auto: if OPENROUTER_API_KEY is set → openrouter, else → anthropic.
 *
 * Knows nothing about Instagram or where the context came from. It only needs
 * `context.systemPrompt` (the assembled prompt) and `context.hasKnowledgeBase`
 * (whether there is anything to answer from).
 */

const axios = require("axios");

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet";
const FALLBACK_MESSAGE =
  "Спасибо за сообщение. Наш специалист скоро свяжется с вами.";

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

// anthropic | openrouter. Explicit AI_PROVIDER wins; otherwise auto-detect from
// whichever key is present (OpenRouter takes precedence when both exist).
function resolveProvider() {
  const explicit = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (explicit === "openrouter" || explicit === "anthropic") {
    return explicit;
  }
  // Auto-detect: prefer the direct Anthropic API when its key is present
  // (no prompt-token cap), fall back to OpenRouter, default to Anthropic.
  if (hasValue(process.env.ANTHROPIC_API_KEY)) {
    return "anthropic";
  }
  if (hasValue(process.env.OPENROUTER_API_KEY)) {
    return "openrouter";
  }
  return "anthropic";
}

async function generateViaAnthropic(context, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!hasValue(apiKey)) {
    console.warn("ANTHROPIC_API_KEY_MISSING");
    return { text: FALLBACK_MESSAGE, source: "fallback_no_api_key" };
  }

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

  return { text, model: ANTHROPIC_MODEL };
}

async function generateViaOpenRouter(context, userMessage) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!hasValue(apiKey)) {
    console.warn("OPENROUTER_API_KEY_MISSING");
    return { text: FALLBACK_MESSAGE, source: "fallback_no_api_key" };
  }

  // OpenAI-compatible Chat Completions schema: system + user messages.
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: OPENROUTER_MODEL,
      max_tokens: 1024,
      messages: [
        { role: "system", content: String(context.systemPrompt || "") },
        { role: "user", content: String(userMessage || "") }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      timeout: 20000
    }
  );

  const text = String(response.data?.choices?.[0]?.message?.content || "").trim();
  return { text, model: OPENROUTER_MODEL };
}

async function generateReply({ context = {}, userMessage } = {}) {
  // No usable context (e.g. empty knowledge base) → safe fallback, no model call.
  if (!context.hasKnowledgeBase) {
    return { text: FALLBACK_MESSAGE, source: "fallback_no_knowledge_base" };
  }

  // TEMPORARY diagnostic — never prints the keys themselves, only presence/length.
  console.log("AI ENV CHECK", {
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
    anthropicLength: process.env.ANTHROPIC_API_KEY?.length || 0,
    openRouterLength: process.env.OPENROUTER_API_KEY?.length || 0,
    provider: process.env.AI_PROVIDER || null,
    model: process.env.ANTHROPIC_MODEL || process.env.OPENROUTER_MODEL || null
  });

  const provider = resolveProvider();

  try {
    const result =
      provider === "openrouter"
        ? await generateViaOpenRouter(context, userMessage)
        : await generateViaAnthropic(context, userMessage);

    // A provider helper may short-circuit to a fallback (e.g. missing key).
    if (result.source) {
      return result;
    }

    if (!hasValue(result.text)) {
      return { text: FALLBACK_MESSAGE, source: "fallback_empty_reply" };
    }

    console.log("AI_REPLY_GENERATED", {
      provider,
      model: result.model,
      userTextLength: String(userMessage || "").length,
      replyLength: result.text.length
    });
    return { text: result.text, source: "ai" };
  } catch (error) {
    console.error("AI_REPLY_ERROR", {
      provider,
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    // TEMPORARY: expose the upstream error so /debug/ai can show the real cause.
    return {
      text: FALLBACK_MESSAGE,
      source: "fallback_ai_error",
      error: {
        provider,
        model: provider === "openrouter" ? OPENROUTER_MODEL : ANTHROPIC_MODEL,
        status: error.response?.status || null,
        message: error.message,
        detail: error.response?.data || null
      }
    };
  }
}

module.exports = { generateReply, FALLBACK_MESSAGE };
