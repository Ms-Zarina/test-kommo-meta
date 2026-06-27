/**
 * Google Sheets dynamic pricing provider.
 *
 * Second source of knowledge for the Instagram AI assistant. The stable
 * knowledge_base.md describes the clinic; this provider overlays the
 * *current* prices and promotions from a Google Sheet.
 *
 * Design notes:
 *  - Sheets are read via the PUBLIC CSV export (gviz endpoint) with `axios` —
 *    no Service Account, no API key, no `googleapis` SDK. This works under the
 *    `iam.disableServiceAccountKeyCreation` org policy. The spreadsheet must be
 *    shared as "Anyone with the link → Viewer". Only GOOGLE_SHEETS_ID is needed.
 *  - All data is cached in memory for 5 minutes. Google is never read per
 *    message.
 *  - Every failure mode is non-fatal: on any error the provider falls back to
 *    "no pricing data" and the AI keeps working from knowledge_base.md alone.
 *
 * Expected sheets / columns:
 *  services_prices: service_id, service_name, active, discount_price, currency,
 *                   valid_from, valid_to, note
 *  promotions:      promo_id, service_id, promo_name, discount_type,
 *                   discount_value, promo_price_czk, promo_price_eur,
 *                   gift_description, start_date, end_date, is_active,
 *                   priority, conditions, channel, cta_text, admin_comment
 *  metadata:        reserved / service sheet (not loaded here)
 */

const axios = require("axios");

const SHEETS = {
  services: "services_prices",
  promotions: "promotions"
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache = {
  services: [],
  promotions: [],
  updatedAt: null, // epoch ms of last (successful or fallback) refresh
  source: "none", // "google_sheets" | "fallback" | "none"
  error: null
};

let refreshing = null; // de-dupes concurrent refreshes

// ── small local helpers (intentionally not importing from server.js) ────────

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function isTruthy(value) {
  const s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "да" || s === "active";
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function normalizeDate(value) {
  if (!hasValue(value)) return null;
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

function isWithinWindow(from, to, today) {
  const f = normalizeDate(from);
  const t = normalizeDate(to);
  if (f && today < f) return false;
  if (t && today > t) return false;
  return true;
}

function isEnabled() {
  return hasValue(process.env.GOOGLE_SHEETS_ID);
}

// ── Google Sheets public CSV transport ──────────────────────────────────────

// Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped "" quotes
// and newlines inside quotes. Returns an array of rows (arrays of cells).
function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  const src = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Fetch one sheet via the public CSV export. The spreadsheet must be shared as
// "Anyone with the link → Viewer". Returns parsed rows (array of arrays).
async function fetchSheet(sheetName) {
  const id = process.env.GOOGLE_SHEETS_ID;
  const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

  const response = await axios.get(url, {
    timeout: 15000,
    responseType: "text",
    // Keep the body as a raw string — never let axios try to JSON-parse it.
    transformResponse: (data) => data
  });

  return parseCsv(response.data);
}

function rowsToObjects(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return [];
  }

  const headers = values[0].map((h) => String(h || "").trim());

  return values
    .slice(1)
    .filter((row) => Array.isArray(row) && row.some((cell) => hasValue(cell)))
    .map((row) => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] !== undefined ? row[i] : "";
      });
      return obj;
    });
}

// ── cache lifecycle ─────────────────────────────────────────────────────────

function isFresh() {
  return cache.updatedAt !== null && Date.now() - cache.updatedAt < CACHE_TTL_MS;
}

async function refreshCache() {
  if (refreshing) {
    return refreshing;
  }

  refreshing = (async () => {
    if (!isEnabled()) {
      console.warn("GOOGLE_SHEETS_ENV_MISSING", {
        hasId: hasValue(process.env.GOOGLE_SHEETS_ID)
      });
      cache = {
        services: [],
        promotions: [],
        updatedAt: Date.now(),
        source: "fallback",
        error: "env_missing"
      };
      return cache;
    }

    try {
      console.log("GOOGLE_SHEETS_CONNECTED", {
        sheetId: process.env.GOOGLE_SHEETS_ID
      });

      const [servicesRows, promotionsRows] = await Promise.all([
        fetchSheet(SHEETS.services),
        fetchSheet(SHEETS.promotions)
      ]);

      const services = rowsToObjects(servicesRows);
      const promotions = rowsToObjects(promotionsRows);

      console.log("SERVICES_LOADED", { count: services.length });
      console.log("PROMOTIONS_LOADED", { count: promotions.length });
      console.log("GOOGLE_SHEETS_LOADED", {
        services: services.length,
        promotions: promotions.length
      });

      cache = {
        services,
        promotions,
        updatedAt: Date.now(),
        source: "google_sheets",
        error: null
      };

      console.log("PRICING_CACHE_UPDATED", {
        updatedAt: new Date(cache.updatedAt).toISOString(),
        source: cache.source,
        services: services.length,
        promotions: promotions.length
      });

      return cache;
    } catch (error) {
      console.error("GOOGLE_SHEETS_ERROR", {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      // Fallback: keep the last good data if we have any, otherwise empty.
      // Stamp updatedAt so we do not hammer Google on every message while it
      // is down; the next attempt happens after the TTL.
      cache = {
        services: cache.services || [],
        promotions: cache.promotions || [],
        updatedAt: Date.now(),
        source: "fallback",
        error: error.message
      };

      return cache;
    }
  })();

  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

async function ensureFresh() {
  if (isFresh()) {
    console.log("PRICING_CACHE_USED", {
      ageMs: Date.now() - cache.updatedAt,
      source: cache.source
    });
    return;
  }
  await refreshCache();
}

// ── public API ──────────────────────────────────────────────────────────────

async function loadServices() {
  await ensureFresh();
  return cache.services;
}

async function loadPromotions() {
  await ensureFresh();
  return cache.promotions;
}

// This bot's channel. A promotion applies if its channel is ALL or "instagram".
const PROMO_CHANNEL = "instagram";

function findService(services, serviceId) {
  return services.find(
    (s) => String(s.service_id).trim() === String(serviceId).trim()
  );
}

// services_prices: a row is offered unless is_active is explicitly false.
// Blank/missing → active (per GOOGLE_SHEETS_DYNAMIC_DATA_SPEC.md). The legacy
// "active" column name is still honoured for backward compatibility.
function isServiceActive(service) {
  if (!service) return false;
  const raw = hasValue(service.is_active)
    ? service.is_active
    : hasValue(service.active)
      ? service.active
      : ""; // blank → active
  if (String(raw).trim() === "") return true;
  return isTruthy(raw);
}

// Optional EMERGENCY price override from services_prices. Normally empty — the
// base price lives in knowledge_base.md. Supports the real schema
// (base_price_czk/eur) and the legacy one (discount_price + currency).
function serviceOverridePrice(service) {
  if (hasValue(service.base_price_czk)) {
    return { price: String(service.base_price_czk).trim(), currency: "CZK" };
  }
  if (hasValue(service.base_price_eur)) {
    return { price: String(service.base_price_eur).trim(), currency: "EUR" };
  }
  if (hasValue(service.discount_price)) {
    return {
      price: String(service.discount_price).trim(),
      currency: service.currency || "CZK"
    };
  }
  return null;
}

// promotions.service_id may be an exact id, "ALL", or "CATEGORY:<name>".
function promoMatchesService(promo, service) {
  const target = String(promo.service_id || "").trim();
  if (!target) return false;
  if (target.toUpperCase() === "ALL") return true;
  if (target.toUpperCase().startsWith("CATEGORY:")) {
    const cat = target.slice(target.indexOf(":") + 1).trim().toLowerCase();
    return (
      hasValue(service.category) &&
      String(service.category).trim().toLowerCase() === cat
    );
  }
  return target === String(service.service_id).trim();
}

// Active = is_active true AND today within [start_date, end_date] AND the
// channel is ALL or this bot's channel.
function isPromoActive(promo, today) {
  if (!isTruthy(promo.is_active)) return false;
  if (!isWithinWindow(promo.start_date, promo.end_date, today)) return false;
  const ch = String(promo.channel || "ALL").trim().toUpperCase();
  return ch === "ALL" || ch === PROMO_CHANNEL.toUpperCase();
}

function bestActivePromotion(promotions, service, today) {
  return promotions
    .filter((p) => isPromoActive(p, today) && promoMatchesService(p, service))
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))[0] || null;
}

function promotionPrice(promo) {
  if (hasValue(promo.promo_price_czk)) {
    return { price: String(promo.promo_price_czk).trim(), currency: "CZK" };
  }
  if (hasValue(promo.promo_price_eur)) {
    return { price: String(promo.promo_price_eur).trim(), currency: "EUR" };
  }
  return null;
}

async function getActivePromotion(serviceId) {
  const [services, promotions] = await Promise.all([
    loadServices(),
    loadPromotions()
  ]);
  const service = findService(services, serviceId) || { service_id: serviceId };
  return bestActivePromotion(promotions, service, todayStr());
}

/**
 * Resolve the live pricing situation for ONE service (pure, no I/O).
 * price_type is one of:
 *   - "inactive"        service switched off → do not offer
 *   - "promotion"       an active promo price applies (authoritative)
 *   - "override"        an emergency price override in services_prices applies
 *   - "knowledge_base"  no Sheets price → the base price from the KB stands
 */
function resolveServicePricing(service, promotions, today) {
  const serviceId = String(service.service_id || "").trim();
  const serviceName = service.service_name || serviceId;
  const base = { service_id: serviceId, service_name: serviceName };

  if (!isServiceActive(service)) {
    return { ...base, price_type: "inactive", is_promotion: false, price: null, currency: null, source: "inactive" };
  }

  const promo = bestActivePromotion(promotions, service, today);
  if (promo) {
    const p = promotionPrice(promo);
    if (p) {
      return {
        ...base,
        price_type: "promotion",
        is_promotion: true,
        price: p.price,
        currency: p.currency,
        source: "promotion",
        promo_name: promo.promo_name || null,
        valid_until: normalizeDate(promo.end_date),
        gift: hasValue(promo.gift_description) ? promo.gift_description : null
      };
    }
  }

  const override = serviceOverridePrice(service);
  if (override) {
    return { ...base, price_type: "override", is_promotion: false, price: override.price, currency: override.currency, source: "override" };
  }

  return { ...base, price_type: "knowledge_base", is_promotion: false, price: null, currency: null, source: "knowledge_base" };
}

/** Resolved pricing for every service — used by the overlay and /debug/prices. */
async function getResolvedPricing() {
  const today = todayStr();
  const [services, promotions] = await Promise.all([
    loadServices(),
    loadPromotions()
  ]);
  return services.map((service) => resolveServicePricing(service, promotions, today));
}

/**
 * Price for one service. Priority: promotion → override → null (KB price).
 * Inactive services return null so the bot won't offer them.
 */
async function getCurrentPrice(serviceId) {
  const today = todayStr();
  const [services, promotions] = await Promise.all([
    loadServices(),
    loadPromotions()
  ]);

  const service = findService(services, serviceId);
  if (!service) return null;

  const r = resolveServicePricing(service, promotions, today);
  if (r.price_type === "promotion" || r.price_type === "override") {
    return {
      serviceId: r.service_id,
      serviceName: r.service_name,
      price: r.price,
      currency: r.currency,
      source: r.source,
      promoName: r.promo_name || null,
      validUntil: r.valid_until || null,
      gift: r.gift || null
    };
  }

  return null; // inactive or knowledge_base → no Sheets price
}

/**
 * Build the pricing OVERLAY block for the AI prompt. Each line states the
 * price TYPE (promotion / override / inactive) so the model phrases the answer
 * correctly. Services whose price still lives in the knowledge base are omitted
 * (the KB price stands). Returns "" when there is nothing to overlay.
 */
async function buildPricingContext() {
  const resolved = await getResolvedPricing();
  const lines = [];

  for (const r of resolved) {
    const tag = `[service_id=${r.service_id}]`;

    if (r.price_type === "promotion") {
      let line =
        `- ${r.service_name} ${tag} — PROMOTION price: ${r.price} ${r.currency}` +
        (r.valid_until ? `, valid until ${r.valid_until}` : "") +
        `. price_type=promotion. This is the CURRENT price; also tell the client the regular base price from the knowledge base.`;
      if (r.gift) line += ` Gift: ${r.gift}.`;
      lines.push(line);
    } else if (r.price_type === "override") {
      lines.push(
        `- ${r.service_name} ${tag} — UPDATED price: ${r.price} ${r.currency}. price_type=override. This is the CURRENT price (NOT a promotion).`
      );
    } else if (r.price_type === "inactive") {
      lines.push(
        `- ${r.service_name} ${tag} — UNAVAILABLE. price_type=inactive. Do not offer or book this service.`
      );
    }
    // knowledge_base → omitted; the KB price applies.
  }

  if (!lines.length) {
    console.log("PRICING_CONTEXT_BUILT", { lines: 0, source: cache.source });
    return "";
  }

  const block = [
    "PRICING OVERLAY — live data from Google Sheets, AUTHORITATIVE over the knowledge base for the services listed here. For any service NOT listed, use the price from the knowledge base.",
    ...lines
  ].join("\n");

  console.log("PRICING_CONTEXT_BUILT", { lines: lines.length, source: cache.source });
  return block;
}

function getCacheStatus() {
  const ageMs = cache.updatedAt ? Date.now() - cache.updatedAt : null;
  return {
    source: cache.source,
    updated_at: cache.updatedAt ? new Date(cache.updatedAt).toISOString() : null,
    cache: cache.updatedAt === null ? "empty" : isFresh() ? "fresh" : "stale",
    ttl_ms: CACHE_TTL_MS,
    error: cache.error,
    services_count: cache.services.length,
    promotions_count: cache.promotions.length
  };
}

module.exports = {
  isEnabled,
  loadServices,
  loadPromotions,
  getCurrentPrice,
  getActivePromotion,
  getResolvedPricing,
  refreshCache,
  buildPricingContext,
  getCacheStatus
};
