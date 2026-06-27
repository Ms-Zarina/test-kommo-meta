/**
 * Knowledge provider.
 *
 * Sole responsibility: read knowledge_base.md from the project root, cache it,
 * and degrade gracefully when it is missing. Knows nothing about Instagram,
 * Google Sheets or the AI model.
 */

const fs = require("fs");
const path = require("path");

// Module lives in services/ → the knowledge base is one level up, in the root.
const KNOWLEDGE_BASE_PATH = path.join(__dirname, "..", "knowledge_base.md");

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

// Cache only successful loads. On Render a new knowledge_base.md ships with a
// redeploy (fresh process), so a long-lived in-memory cache is safe.
let cache = null;

function loadKnowledgeBase() {
  if (cache !== null) {
    return cache;
  }

  try {
    const content = fs.readFileSync(KNOWLEDGE_BASE_PATH, "utf8");
    cache = content;
    console.log("KNOWLEDGE_BASE_LOADED", {
      path: KNOWLEDGE_BASE_PATH,
      length: content.length
    });
    return content;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn("KNOWLEDGE_BASE_MISSING", { path: KNOWLEDGE_BASE_PATH });
      return null;
    }

    console.error("KNOWLEDGE_BASE_LOAD_ERROR", { message: error.message });
    return null;
  }
}

// Presence + size only — never the full text (used by /debug/knowledge).
function getStatus() {
  const knowledgeBase = loadKnowledgeBase();
  return {
    loaded: hasValue(knowledgeBase),
    length: knowledgeBase ? knowledgeBase.length : 0
  };
}

module.exports = { loadKnowledgeBase, getStatus };
