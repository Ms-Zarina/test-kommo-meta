
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();

const ALTEGIO_SERVICE_MAP = {
  Kontrola: 5685890
};

const KOMMO_ALTEGIO_FIELDS = {
  recordId: ["ID Record, Altegio", "Altegio Record ID"],
  visitId: ["ID Visit, Altegio", "Altegio Visit ID"],
  datetime: ["Date and time", "Date and Time", "Datetime", "DATE_AND_TIME", "DATETIME"],
  service: ["Service", "SERVICE"],
  staffId: ["Employee, Altegio"],
  companyId: ["ID Company, Altegio"]
};

function getMetaEventNameByStatus(statusId) {
  const map = {
    [String(process.env.THINKING_STATUS_ID)]: "Lead",
    [String(process.env.BOOKING_STATUS_ID)]: "QualifiedLead",
    [String(process.env.SUCCESSFULLY_STATUS_ID)]: "Purchase"
  };

  return map[String(statusId)] || null;
}

app.use(cors());
app.use(express.json());

app.use(express.urlencoded({ extended: true }));

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "").trim().toLowerCase())
    .digest("hex");
}

function hasValue(value) {
  return value !== null &&
    value !== undefined &&
    String(value).trim() !== "";
}

async function sendMetaEvent({
  eventName,
  email,
  phone,
  leadId,
  value = 1,
  ip,
  userAgent,
  fbp,
  fbc
}) {
  const url = `https://graph.facebook.com/v20.0/${process.env.META_PIXEL_ID}/events`;
  const userData = {};

  if (hasValue(email)) {
    userData.em = [sha256(email)];
  }

  if (hasValue(phone)) {
    userData.ph = [sha256(phone)];
  }

  if (hasValue(leadId)) {
    userData.external_id = [sha256(String(leadId))];
  }

  if (hasValue(ip)) {
    userData.client_ip_address = ip;
  }

  if (hasValue(userAgent)) {
    userData.client_user_agent = userAgent;
  }

  if (hasValue(fbp)) {
    userData.fbp = fbp;
  }

  if (hasValue(fbc)) {
    userData.fbc = fbc;
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: "system_generated",
        user_data: userData,
        custom_data: {
          currency: "CZK",
          value: Number(value) || 1,
          lead_id: leadId || "test_lead",
          source: "backend_test"
        }
      }
    ],
    // test_event_code: process.env.META_TEST_EVENT_CODE,
    access_token: process.env.META_ACCESS_TOKEN
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(result));
  }

  return result;
}


async function getEnrichedKommoLead(leadId) {
  const response = await axios.get(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/${leadId}`,
    {
      params: {
        with: "contacts,tags"
      },
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        Accept: "application/json"
      }
    }
  );

  return response.data;
}

async function getContactById(contactId) {
  const response = await axios.get(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/contacts/${contactId}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        Accept: "application/json"
      }
    }
  );

  return response.data;
}

function extractEmailAndPhone(contact) {
  const fields = contact.custom_fields_values || [];

  let email = null;
  let phone = null;
  let fbp = null;
  let fbc = null;

  for (const field of fields) {
    if (field.field_code === "EMAIL") {
      email = field.values?.[0]?.value || null;
    }

    if (field.field_code === "PHONE") {
      phone = field.values?.[0]?.value || null;
    }

    const fieldNames = [field.field_code, field.field_name]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase().replace(/^_/, ""));

    if (fieldNames.includes("fbp")) {
      fbp = field.values?.[0]?.value || null;
    }

    if (fieldNames.includes("fbc")) {
      fbc = field.values?.[0]?.value || null;
    }
  }

  return { email, phone, fbp, fbc };
}

function extractFbcFromLeadTags(...leads) {
  for (const lead of leads) {
    const tags = [
      ...(Array.isArray(lead?.tags) ? lead.tags : []),
      ...(Array.isArray(lead?._embedded?.tags) ? lead._embedded.tags : [])
    ];

    for (const tag of tags) {
      const value = typeof tag === "string"
        ? tag
        : tag?.name || tag?.value;

      if (!hasValue(value)) {
        continue;
      }

      const trimmedValue = String(value).trim();
      const normalizedValue = trimmedValue.toLowerCase();

      if (
        normalizedValue.startsWith("fb") ||
        normalizedValue.startsWith("fbclid") ||
        normalizedValue.startsWith("fbc")
      ) {
        return normalizedValue.startsWith("fb.")
          ? trimmedValue
          : `fb.1.${Date.now()}.${trimmedValue}`;
      }
    }
  }

  return null;
}

function getMetaAttribution(enrichedLead, contact) {
  const leadFields = extractEmailAndPhone(enrichedLead || {});
  const contactFields = extractEmailAndPhone(contact || {});
  const fbp = leadFields.fbp || contactFields.fbp || null;
  const customFieldFbc = leadFields.fbc || contactFields.fbc || null;
  const tagFbc = customFieldFbc
    ? null
    : extractFbcFromLeadTags(enrichedLead);

  return {
    fbp,
    fbc: customFieldFbc || tagFbc,
    source: customFieldFbc
      ? "custom_field"
      : tagFbc
        ? "tag"
        : fbp
          ? "custom_field"
          : null
  };
}

function logEnrichedKommoLead(lead) {
  console.log("ENRICHED KOMMO LEAD", {
    lead_id: lead?.id,
    tags: lead?.tags || lead?._embedded?.tags || [],
    custom_fields: (lead?.custom_fields_values || []).map((field) => ({
      field_id: field.field_id,
      field_name: field.field_name,
      field_code: field.field_code
    })),
    contacts: lead?._embedded?.contacts || []
  });
}

function logKommoLeadCustomFieldsDebug(lead) {
  const customFields = lead?.custom_fields_values || [];

  console.log(
    "RAW KOMMO ENRICHED LEAD:",
    JSON.stringify(lead || null, null, 2)
  );
  console.log(
    "KOMMO CUSTOM FIELDS DEBUG:",
    JSON.stringify(
      {
        lead_id: lead?.id,
        has_custom_fields_values: Array.isArray(lead?.custom_fields_values),
        custom_fields_count: customFields.length,
        custom_fields: customFields.map((field) => ({
          field_id: field.field_id,
          field_name: field.field_name,
          field_code: field.field_code,
          field_type: field.field_type,
          values: field.values,
          raw_values: (field.values || []).map((value) => ({
            value: value?.value,
            enum_id: value?.enum_id,
            enum_code: value?.enum_code,
            value_type: typeof value?.value,
            raw: value
          })),
          raw: field
        })),
        embedded_keys: Object.keys(lead?._embedded || {}),
        embedded_contacts: lead?._embedded?.contacts || []
      },
      null,
      2
    )
  );
}

function getKommoCustomField(entity, namesOrIds) {
  const requestedFields = (Array.isArray(namesOrIds) ? namesOrIds : [namesOrIds])
    .filter(hasValue)
    .map((field) => String(field).trim());
  const fields = entity?.custom_fields_values || [];

  const fieldNameMatch = fields.find((field) =>
    requestedFields.some((requestedField) => field.field_name === requestedField)
  );

  if (fieldNameMatch) {
    return fieldNameMatch;
  }

  const fieldCodeMatch = fields.find((field) =>
    requestedFields.some((requestedField) => field.field_code === requestedField)
  );

  if (fieldCodeMatch) {
    return fieldCodeMatch;
  }

  const normalizedRequestedFields = requestedFields
    .map((field) => field.toLowerCase());

  return fields.find((field) => {
    const aliases = [field.field_id, field.field_name, field.field_code]
      .filter(hasValue)
      .map((alias) => String(alias).trim().toLowerCase());

    return aliases.some((alias) => normalizedRequestedFields.includes(alias));
  }) || null;
}

function getKommoCustomFieldValue(entity, namesOrIds) {
  return getKommoCustomField(entity, namesOrIds)?.values?.[0]?.value ?? null;
}

function getKommoCustomFieldMatchDebug(entity, namesOrIds) {
  const requestedFields = (Array.isArray(namesOrIds) ? namesOrIds : [namesOrIds])
    .filter(hasValue)
    .map((field) => String(field).trim());
  const normalizedRequestedFields = requestedFields
    .map((field) => field.toLowerCase());
  const fields = entity?.custom_fields_values || [];
  const matchedField = getKommoCustomField(entity, namesOrIds);

  return {
    requested_fields: requestedFields,
    custom_fields_count: fields.length,
    matched: matchedField
      ? {
          field_id: matchedField.field_id,
          field_name: matchedField.field_name,
          field_code: matchedField.field_code,
          field_type: matchedField.field_type,
          values: matchedField.values
        }
      : null,
    candidates: fields.map((field) => {
      const aliases = [field.field_id, field.field_name, field.field_code]
        .filter(hasValue)
        .map((alias) => String(alias).trim());
      const normalizedAliases = aliases
        .map((alias) => alias.toLowerCase());

      return {
        field_id: field.field_id,
        field_name: field.field_name,
        field_code: field.field_code,
        field_type: field.field_type,
        values: field.values,
        aliases,
        exact_field_name_match: requestedFields.includes(field.field_name),
        exact_field_code_match: requestedFields.includes(field.field_code),
        normalized_alias_match: normalizedAliases
          .some((alias) => normalizedRequestedFields.includes(alias))
      };
    })
  };
}

function formatDateInPragueTime(date) {
  const timeZone = "Europe/Prague";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const localTimeAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((localTimeAsUtc - date.getTime()) / 60000);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60))
    .padStart(2, "0");
  const offsetRemainderMinutes = String(absoluteOffsetMinutes % 60)
    .padStart(2, "0");

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offsetSign}${offsetHours}:${offsetRemainderMinutes}`;
}

function normalizeAltegioDatetime(value) {
  if (!hasValue(value)) {
    return null;
  }

  const textValue = String(value).trim();

  if (/^\d{10}$/.test(textValue)) {
    return formatDateInPragueTime(new Date(Number(textValue) * 1000));
  }

  if (/^\d{13}$/.test(textValue)) {
    return formatDateInPragueTime(new Date(Number(textValue)));
  }

  return textValue;
}

function mapKommoServiceToAltegioServiceId(serviceName) {
  if (!hasValue(serviceName)) {
    return null;
  }

  const normalizedName = String(serviceName).trim().toLowerCase();
  const match = Object.entries(ALTEGIO_SERVICE_MAP)
    .find(([name]) => name.toLowerCase() === normalizedName);

  return match ? match[1] : null;
}

function extractKommoBookingData(enrichedLead, contact) {
  const { email, phone } = extractEmailAndPhone(contact || {});
  const clientName = contact?.name || "Kommo Client";
  const datetimeField = getKommoCustomField(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.datetime
  );
  const serviceField = getKommoCustomField(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.service
  );
  const rawDatetime = datetimeField?.values?.[0]?.value ?? null;
  const datetime = normalizeAltegioDatetime(rawDatetime);
  const serviceName = serviceField?.values?.[0]?.value ?? null;
  const companyIdValue = getKommoCustomFieldValue(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.companyId
  );
  const staffIdValue = getKommoCustomFieldValue(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.staffId
  );

  console.log("KOMMO BOOKING EXTRACTED VALUES", {
    lead_id: enrichedLead?.id,
    datetime_field: datetimeField
      ? {
          field_name: datetimeField.field_name,
          field_code: datetimeField.field_code,
          value: rawDatetime
        }
      : null,
    service_field: serviceField
      ? {
          field_name: serviceField.field_name,
          field_code: serviceField.field_code,
          value: serviceName
        }
      : null,
    datetime,
    service: serviceName
  });
  console.log(
    "KOMMO BOOKING FIELD MATCH DEBUG:",
    JSON.stringify(
      {
        lead_id: enrichedLead?.id,
        datetime_match: getKommoCustomFieldMatchDebug(
          enrichedLead,
          KOMMO_ALTEGIO_FIELDS.datetime
        ),
        service_match: getKommoCustomFieldMatchDebug(
          enrichedLead,
          KOMMO_ALTEGIO_FIELDS.service
        )
      },
      null,
      2
    )
  );

  return {
    leadId: enrichedLead?.id,
    recordId: getKommoCustomFieldValue(
      enrichedLead,
      [
        ...KOMMO_ALTEGIO_FIELDS.recordId,
        process.env.KOMMO_ALTEGIO_RECORD_FIELD_ID
      ]
    ),
    visitId: getKommoCustomFieldValue(
      enrichedLead,
      [
        ...KOMMO_ALTEGIO_FIELDS.visitId,
        process.env.KOMMO_ALTEGIO_VISIT_FIELD_ID
      ]
    ),
    phone,
    name: clientName,
    email,
    datetime,
    serviceName,
    serviceId: mapKommoServiceToAltegioServiceId(serviceName),
    staffId: Number(staffIdValue || process.env.ALTEGIO_DEFAULT_STAFF_ID) || null,
    companyId: Number(companyIdValue || process.env.ALTEGIO_COMPANY_ID) || null
  };
}

function getAltegioApiHeaders() {
  return {
    Authorization: `Bearer ${process.env.ALTEGIO_PARTNER_TOKEN}, User ${process.env.ALTEGIO_USER_TOKEN}`,
    Accept: "application/vnd.api.v2+json",
    "Content-Type": "application/json"
  };
}

function maskSecret(value) {
  if (!hasValue(value)) {
    return "<missing>";
  }

  const secret = String(value);

  if (secret.length <= 6) {
    return `${secret.slice(0, 1)}***${secret.slice(-1)}`;
  }

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function maskAltegioTokens(value) {
  const tokens = [
    process.env.ALTEGIO_PARTNER_TOKEN,
    process.env.ALTEGIO_USER_TOKEN
  ].filter(hasValue);

  if (typeof value === "string") {
    return tokens.reduce(
      (maskedValue, token) =>
        maskedValue.replaceAll(String(token), maskSecret(token)),
      value
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskAltegioTokens(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        maskAltegioTokens(item)
      ])
    );
  }

  return value;
}

async function createAltegioRecordFromKommo({ bookingData }) {
  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const requestUrl = `${apiUrl}/api/v1/records/${bookingData.companyId}`;
  const seanceLength = Number(process.env.ALTEGIO_DEFAULT_SEANCE_LENGTH || 900);
  const payload = {
    staff_id: bookingData.staffId,
    services: [{ id: bookingData.serviceId }],
    seance_length: seanceLength,
    length: seanceLength,
    client: {
      phone: bookingData.phone,
      name: bookingData.name
    },
    datetime: bookingData.datetime,
    save_if_busy: false,
    comment: `Created from Kommo lead ${bookingData.leadId}`,
    api_id: `kommo_lead_${bookingData.leadId}`
  };

  if (hasValue(bookingData.email)) {
    payload.client.email = bookingData.email;
  }

  console.log(
    "ALTEGIO CREATE PAYLOAD:",
    JSON.stringify(payload, null, 2)
  );

  const requestConfig = {
    headers: getAltegioApiHeaders()
  };

  console.log("ALTEGIO REQUEST URL:", requestUrl);
  console.log(
    "ALTEGIO REQUEST HEADERS:",
    maskAltegioTokens(requestConfig.headers)
  );
  console.log("ALTEGIO AXIOS AUTH CONFIG:", {
    method: "POST",
    url: requestUrl,
    ...maskAltegioTokens(requestConfig),
    authorization_format: "Bearer <PARTNER_TOKEN>, User <USER_TOKEN>"
  });

  let response;

  try {
    response = await axios.post(requestUrl, payload, requestConfig);
  } catch (error) {
    console.error("ALTEGIO RESPONSE ERROR:", {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: maskAltegioTokens(error.response?.data),
      headers: maskAltegioTokens(error.response?.headers)
    });
    console.log(
      "ALTEGIO RESPONSE ERROR FULL:",
      JSON.stringify(error.response?.data, null, 2)
    );
    throw error;
  }

  const responseData = response.data?.data;
  const record = Array.isArray(responseData) ? responseData[0] : responseData;

  if (!record?.id) {
    throw new Error("Altegio record creation returned no record ID");
  }

  return {
    recordId: record.id,
    visitId: record.visit_id || null,
    record
  };
}

async function getKommoLeadNotes(leadId) {
  const response = await axios.get(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/${leadId}/notes`,
    {
      params: {
        limit: 50
      },
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        Accept: "application/json"
      }
    }
  );

  return response.data?._embedded?.notes || [];
}

function hasAltegioSourceNote(notes) {
  return notes.some((note) => {
    const text = note?.params?.text || note?.text || "";
    return String(text).toLowerCase().includes("source: altegio");
  });
}

function getKommoFieldId(entity, fieldNames, envFieldId) {
  const configuredId = Number(envFieldId);

  if (Number.isInteger(configuredId) && configuredId > 0) {
    return configuredId;
  }

  return getKommoCustomField(entity, fieldNames)?.field_id || null;
}

async function saveAltegioRecordIdToKommoLead(
  leadId,
  recordId,
  visitId,
  enrichedLead
) {
  const recordFieldId = getKommoFieldId(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.recordId,
    process.env.KOMMO_ALTEGIO_RECORD_FIELD_ID
  );
  const visitFieldId = getKommoFieldId(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.visitId,
    process.env.KOMMO_ALTEGIO_VISIT_FIELD_ID
  );
  const customFieldsValues = [];

  if (recordFieldId) {
    customFieldsValues.push({
      field_id: Number(recordFieldId),
      values: [{ value: String(recordId) }]
    });
  }

  if (visitFieldId && hasValue(visitId)) {
    customFieldsValues.push({
      field_id: Number(visitFieldId),
      values: [{ value: String(visitId) }]
    });
  }

  if (!customFieldsValues.length) {
    console.log("ALTEGIO RECORD ID SAVE SKIPPED - FIELD NOT CONFIGURED", {
      lead_id: leadId,
      record_id: recordId,
      visit_id: visitId
    });
    return false;
  }

  await axios.patch(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/${leadId}`,
    {
      custom_fields_values: customFieldsValues
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    }
  );

  return true;
}

async function addKommoNoteForAltegioRecord(leadId, recordId, visitId) {
  await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/notes`,
    [
      {
        entity_id: Number(leadId),
        note_type: "common",
        params: {
          text: [
            "Source: Kommo",
            `Altegio Record ID: ${recordId}`,
            `Altegio Visit ID: ${visitId || "Not specified"}`
          ].join("\n")
        }
      }
    ],
    {
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    }
  );
}

async function syncKommoBookingToAltegio(enrichedLead, contact) {
  const bookingData = extractKommoBookingData(enrichedLead, contact);

  console.log("KOMMO TO ALTEGIO DEBUG", {
    lead_id: bookingData.leadId,
    record_id: bookingData.recordId,
    phone: bookingData.phone,
    datetime: bookingData.datetime,
    service: bookingData.serviceName,
    service_id: bookingData.serviceId,
    staff_id: bookingData.staffId,
    company_id: bookingData.companyId
  });

  if (hasValue(bookingData.recordId)) {
    console.log("ALTEGIO CREATE SKIPPED - RECORD ALREADY EXISTS", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId
    });
    return;
  }

  const notes = await getKommoLeadNotes(bookingData.leadId);

  if (hasAltegioSourceNote(notes)) {
    console.log("ALTEGIO CREATE SKIPPED - RECORD ALREADY EXISTS", {
      lead_id: bookingData.leadId,
      reason: "Source: Altegio note found"
    });
    return;
  }

  const missing = [];

  if (!hasValue(bookingData.phone)) {
    missing.push("phone");
  }

  if (!hasValue(bookingData.datetime)) {
    missing.push("datetime");
  }

  if (!bookingData.serviceId) {
    missing.push("service_mapping");
  }

  if (!bookingData.companyId) {
    missing.push("company_id");
  }

  if (!bookingData.staffId) {
    missing.push("staff_id");
  }

  if (missing.length) {
    console.log("ALTEGIO CREATE SKIPPED - MISSING REQUIRED DATA", {
      lead_id: bookingData.leadId,
      missing,
      service: bookingData.serviceName
    });
    return;
  }

  const createdRecord = await createAltegioRecordFromKommo({ bookingData });

  await saveAltegioRecordIdToKommoLead(
    bookingData.leadId,
    createdRecord.recordId,
    createdRecord.visitId,
    enrichedLead
  );
  await addKommoNoteForAltegioRecord(
    bookingData.leadId,
    createdRecord.recordId,
    createdRecord.visitId
  );

  console.log("ALTEGIO RECORD CREATED FROM KOMMO", {
    lead_id: bookingData.leadId,
    record_id: createdRecord.recordId,
    visit_id: createdRecord.visitId
  });
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Kommo → Meta backend is running"
  });
});

const sentEvents = new Set();
app.post("/webhook/test-lead", async (req, res) => {
  try {
    const { lead_id, status_id, email, phone } = req.body;

    if (!email && !phone) {
      return res.status(400).json({
        ok: false,
        error: "email or phone is required"
      });
    }

    const eventName = getMetaEventNameByStatus(status_id);

    if (!eventName) {
      return res.status(400).json({
        ok: false,
        error: "Unknown status"
      });
    }

    console.log("Incoming lead:", {
      lead_id,
      status_id,
      eventName,
      email,
      phone
    });

    if (eventName === "Purchase") {
      return res.json({
        ok: true,
        skipped: true,
        reason: "Purchase is sent from Altegio with real value",
        lead_id,
        status_id
      });
    }

    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress;

    const userAgent =
      req.headers["user-agent"];

    const metaResult = await sendMetaEvent({
      eventName,
      email,
      phone,
      leadId: lead_id,
      ip,
      userAgent
    });

    res.json({
      ok: true,
      sent_to_meta: true,
      meta: metaResult
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});


app.post("/webhook/kommo", async (req, res) => {
  try {
    console.log("KOMMO WEBHOOK:");
    console.log(JSON.stringify(req.body, null, 2));

    const lead =
      req.body?.leads?.status?.[0] ||
      req.body?.leads?.update?.[0];

    if (!lead) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "No lead data in webhook"
      });
    }

    const eventName = getMetaEventNameByStatus(lead.status_id);

    console.log("KOMMO EVENT DEBUG:", {
      lead_id: lead.id,
      status_id: lead.status_id,
      eventName,
      trackedStatuses: {
        THINKING_STATUS_ID: process.env.THINKING_STATUS_ID,
        BOOKING_STATUS_ID: process.env.BOOKING_STATUS_ID,
        SUCCESSFULLY_STATUS_ID: process.env.SUCCESSFULLY_STATUS_ID
      }
    });

    if (!eventName) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "Status not tracked",
        lead_id: lead.id,
        status_id: lead.status_id
      });
    }

    const eventKey = `${lead.id}_${lead.status_id}_${eventName}`;

    console.log("KOMMO EVENT KEY:", eventKey);

    const isDuplicateEvent = sentEvents.has(eventKey);
    const isBookingStatus =
      String(lead.status_id) === String(process.env.BOOKING_STATUS_ID);

    if (isDuplicateEvent) {
      console.log("DUPLICATE EVENT SKIPPED:", eventKey);

      if (!isBookingStatus) {
        return res.json({
          ok: true,
          skipped: true,
          reason: "Duplicate event skipped",
          eventKey
        });
      }
    } else {
      sentEvents.add(eventKey);
    }

    console.log("START KOMMO ENRICHMENT:", { lead_id: lead.id });

    const enrichedLead = await getEnrichedKommoLead(lead.id);

    console.log("FINISH KOMMO ENRICHMENT:", { lead_id: lead.id });

    logEnrichedKommoLead(enrichedLead);
    logKommoLeadCustomFieldsDebug(enrichedLead);
    const contactId = enrichedLead?._embedded?.contacts?.[0]?.id;

    if (!contactId) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "No contact linked to lead",
        lead_id: lead.id
      });
    }

    const contactData = await getContactById(contactId);
    const { email, phone } = extractEmailAndPhone(contactData);
    const {
      fbp,
      fbc,
      source: attributionSource
    } = getMetaAttribution(enrichedLead, contactData);

    if (isBookingStatus) {
      try {
        await syncKommoBookingToAltegio(enrichedLead, contactData);
      } catch (error) {
        console.error("KOMMO TO ALTEGIO ERROR:", {
          message: error.message,
          lead_id: lead.id
        });
      }
    }

    if (isDuplicateEvent) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "Duplicate event skipped",
        eventKey
      });
    }

    if (!email && !phone) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "No email or phone in contact",
        lead_id: lead.id,
        contact_id: contactId
      });
    }

    if (fbp || fbc) {
      console.log("EXTRACTED META ATTRIBUTION", {
        fbp,
        fbc,
        source: attributionSource
      });
    }

    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress;

    const userAgent =
      req.headers["user-agent"];

    const metaResult = await sendMetaEvent({
      eventName,
      email,
      phone,
      leadId: lead.id,
      ip,
      userAgent,
      fbp,
      fbc
    });

    console.log("META RESULT:");
    console.log(JSON.stringify(metaResult, null, 2));

    return res.json({
      ok: true,
      sent_to_meta: true,
      lead_id: lead.id,
      status_id: lead.status_id,
      eventName,
      meta: metaResult
    });
  } catch (error) {
    console.error("KOMMO ERROR:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/meta/webhook", (req, res) => {
  const verifyToken = process.env.META_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    console.log("META WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/meta/webhook", async (req, res) => {
  console.log("META LEAD WEBHOOK:");
  console.log(JSON.stringify(req.body, null, 2));

  return res.status(200).json({ ok: true });
});

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

async function findKommoLeadByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);

  const response = await axios.get(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads`,
    {
      params: {
        query: normalizedPhone,
        with: "contacts"
      },
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        Accept: "application/json"
      }
    }
  );

  const leads = response.data?._embedded?.leads || [];
  return leads[0] || null;
}

async function findKommoContactByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);

  const response = await axios.get(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/contacts`,
    {
      params: {
        query: normalizedPhone
      },
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        Accept: "application/json"
      }
    }
  );

  const contacts = response.data?._embedded?.contacts || [];
  return contacts[0] || null;
}

async function createKommoContact({ name, phone, email }) {
  const customFields = [
    {
      field_code: "PHONE",
      values: [{ value: phone }]
    }
  ];

  if (email) {
    customFields.push({
      field_code: "EMAIL",
      values: [{ value: email }]
    });
  }

  const response = await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/contacts`,
    [
      {
        name,
        custom_fields_values: customFields
      }
    ],
    {
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    }
  );

  const contact = response.data?._embedded?.contacts?.[0];

  if (!contact?.id) {
    throw new Error("Kommo contact creation returned no contact ID");
  }

  return contact;
}

function getAltegioServiceName(data) {
  const serviceNames = (data?.services || [])
    .map((service) => service.title || service.name)
    .filter(hasValue);

  return serviceNames.join(", ") || "Not specified";
}

function getAltegioBookingDatetime(data) {
  return data?.datetime ||
    data?.date_time ||
    data?.start_datetime ||
    data?.start_date ||
    data?.date ||
    "Not specified";
}

async function addKommoLeadNoteFromAltegio(leadId, data) {
  const noteText = [
    "Source: Altegio",
    `Service: ${getAltegioServiceName(data)}`,
    `Booking datetime: ${getAltegioBookingDatetime(data)}`,
    `Record ID: ${data?.id || data?.record_id || "Not specified"}`,
    `Visit ID: ${data?.visit_id || "Not specified"}`
  ].join("\n");

  await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/notes`,
    [
      {
        entity_id: Number(leadId),
        note_type: "common",
        params: {
          text: noteText
        }
      }
    ],
    {
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    }
  );
}

async function createKommoLeadFromAltegio({ data, contactId, value, statusId }) {
  const pipelineId = Number(process.env.KOMMO_PIPELINE_ID);
  const numericStatusId = Number(statusId);

  if (!Number.isInteger(pipelineId) || !Number.isInteger(numericStatusId)) {
    throw new Error("KOMMO_PIPELINE_ID and BOOKING_STATUS_ID are required for lead creation");
  }

  const clientName =
    data?.client?.display_name ||
    data?.client?.name ||
    "Altegio Client";
  const price = value > 0 ? Math.round(value) : 0;
  const customFieldsValues = [];
  const recordFieldId = Number(process.env.KOMMO_ALTEGIO_RECORD_FIELD_ID);
  const visitFieldId = Number(process.env.KOMMO_ALTEGIO_VISIT_FIELD_ID);

  if (Number.isInteger(recordFieldId) && recordFieldId > 0 && hasValue(data?.id || data?.record_id)) {
    customFieldsValues.push({
      field_id: recordFieldId,
      values: [{ value: String(data?.id || data?.record_id) }]
    });
  }

  if (Number.isInteger(visitFieldId) && visitFieldId > 0 && hasValue(data?.visit_id)) {
    customFieldsValues.push({
      field_id: visitFieldId,
      values: [{ value: String(data.visit_id) }]
    });
  }

  const response = await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads`,
    [
      {
        name: `Altegio booking - ${clientName}`,
        status_id: numericStatusId,
        pipeline_id: pipelineId,
        price,
        ...(customFieldsValues.length
          ? { custom_fields_values: customFieldsValues }
          : {}),
        _embedded: {
          contacts: [{ id: Number(contactId) }]
        }
      }
    ],
    {
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    }
  );

  const lead = response.data?._embedded?.leads?.[0];

  if (!lead?.id) {
    throw new Error("Kommo lead creation returned no lead ID");
  }

  await addKommoLeadNoteFromAltegio(lead.id, data);

  return lead;
}

async function markKommoLeadAsSourcedFromAltegio(lead, data) {
  const recordId = data?.id || data?.record_id;

  if (!hasValue(recordId)) {
    return;
  }

  let enrichedLead = lead;

  try {
    enrichedLead = await getEnrichedKommoLead(lead.id);
    await saveAltegioRecordIdToKommoLead(
      lead.id,
      recordId,
      data?.visit_id,
      enrichedLead
    );
  } catch (error) {
    console.error("ALTEGIO KOMMO RECORD ID SAVE ERROR:", {
      message: error.message,
      lead_id: lead.id,
      record_id: recordId
    });
  }

  await addKommoLeadNoteFromAltegio(lead.id, data);
}

async function updateKommoLeadStatus(leadId, statusId) {
  const response = await axios.patch(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/${leadId}`,
    {
      status_id: Number(statusId)
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    }
  );

  return response.data;
}

function getAltegioRecordValue(data) {
  const services = data?.services || [];

  const total = services.reduce((sum, service) => {
    const rawPrice = hasValue(service.cost_to_pay)
      ? service.cost_to_pay
      : service.cost;
    const price = Number(rawPrice ?? 0);
    const amount = service.amount === null || service.amount === undefined
      ? 1
      : Number(service.amount);

    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return sum;
    }

    return sum + price * amount;
  }, 0);

  return total;
}

function getValidPurchaseValue(data) {
  const value = getAltegioRecordValue(data);

  if (value > 0) {
    return value;
  }

  if (process.env.ALLOW_TEST_PURCHASE_FALLBACK === "true") {
    return 1;
  }

  return null;
}

app.post("/altegio/webhook", async (req, res) => {
  try {
    console.log("ALTEGIO WEBHOOK:");
    console.log(JSON.stringify(req.body, null, 2));

    const { resource, status, data } = req.body;

    if (resource !== "record") {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "Not a record event"
      });
    }

    const phone = data?.client?.phone;

    if (!phone) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "No client phone in Altegio record"
      });
    }

    const clientName =
      data?.client?.display_name ||
      data?.client?.name ||
      "Altegio Client";
    const email = data?.client?.email || null;
    const serviceName = getAltegioServiceName(data);
    const bookingDatetime = getAltegioBookingDatetime(data);
    const recordId = data?.id || data?.record_id;
    const visitId = data?.visit_id;
    const altegioValue = getValidPurchaseValue(data);

    console.log("PURCHASE VALUE DEBUG:", {
      services: data?.services?.map((service) => ({
        title: service.title,
        cost_to_pay: service.cost_to_pay,
        cost: service.cost,
        amount: service.amount
      })),
      calculatedValue: altegioValue
    });

    const lead = await findKommoLeadByPhone(phone);

    if (!lead) {
      const isBookingCreated =
        status === "create" ||
        data?.confirmed === 1;

      if (!isBookingCreated) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: "No Kommo lead found by phone",
          phone
        });
      }

      const existingContact = await findKommoContactByPhone(phone);
      const contact = existingContact || await createKommoContact({
        name: clientName,
        phone,
        email
      });
      const createdLead = await createKommoLeadFromAltegio({
        data,
        contactId: contact.id,
        value: altegioValue,
        statusId: process.env.BOOKING_STATUS_ID
      });

      console.log("KOMMO LEAD CREATED FROM ALTEGIO", {
        lead_id: createdLead.id,
        contact_id: contact.id,
        phone,
        clientName,
        service: serviceName,
        datetime: bookingDatetime,
        record_id: recordId,
        visit_id: visitId,
        value: altegioValue
      });

      return res.status(200).json({
        ok: true,
        created: true,
        lead_id: createdLead.id,
        contact_id: contact.id,
        targetStatusId: process.env.BOOKING_STATUS_ID,
        kommo: createdLead
      });
    }

    let targetStatusId = null;

    if (status === "create" || data?.confirmed === 1) {
      targetStatusId = process.env.BOOKING_STATUS_ID;
    }

    if (data?.attendance === 1 || data?.visit_attendance === 1) {
      targetStatusId = process.env.SUCCESSFULLY_STATUS_ID;
    }

    if (data?.attendance === -1 || data?.visit_attendance === -1) {
      targetStatusId = process.env.CLOSED_STATUS_ID;
    }

    if (!targetStatusId) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "No matching status rule",
        altegio_status: status,
        attendance: data?.attendance,
        visit_attendance: data?.visit_attendance
      });

      if (data?.attendance === -1 || data?.visit_attendance === -1) {
        targetStatusId = process.env.CLOSED_STATUS_ID;
      }
    }

    if (String(targetStatusId) === String(process.env.BOOKING_STATUS_ID)) {
      await markKommoLeadAsSourcedFromAltegio(lead, data);
    }

    const updatedLead = await updateKommoLeadStatus(lead.id, targetStatusId);

    if (String(targetStatusId) === String(process.env.SUCCESSFULLY_STATUS_ID)) {
      if (!altegioValue) {
        console.log("PURCHASE SKIPPED - INVALID VALUE", {
          lead_id: lead.id,
          services: data?.services || []
        });
      } else {
        let enrichedLead = lead;
        let contactData = null;

        try {
          enrichedLead = await getEnrichedKommoLead(lead.id);
          logEnrichedKommoLead(enrichedLead);
        } catch (error) {
          console.error("ALTEGIO META MATCH DATA ERROR:", {
            message: error.message,
            lead_id: lead.id
          });
        }

        const contactId =
          enrichedLead?._embedded?.contacts?.[0]?.id ||
          lead?._embedded?.contacts?.[0]?.id;

        try {
          if (contactId) {
            contactData = await getContactById(contactId);
          }
        } catch (error) {
          console.error("ALTEGIO META MATCH DATA ERROR:", {
            message: error.message,
            contact_id: contactId
          });
        }

        const {
          fbp,
          fbc,
          source: attributionSource
        } = getMetaAttribution(enrichedLead, contactData);

        if (fbp || fbc) {
          console.log("EXTRACTED META ATTRIBUTION", {
            fbp,
            fbc,
            source: attributionSource
          });
        }

        const ip =
          req.headers["x-forwarded-for"] ||
          req.socket.remoteAddress;

        const userAgent =
          req.headers["user-agent"];

        const metaResult = await sendMetaEvent({
          eventName: "Purchase",
          email: data?.client?.email,
          phone: data?.client?.phone,
          leadId: lead.id,
          value: altegioValue,
          ip,
          userAgent,
          fbp,
          fbc
        });

        console.log("META PURCHASE FROM ALTEGIO:");
        console.log(JSON.stringify({
          lead_id: lead.id,
          value: altegioValue,
          meta: metaResult
        }, null, 2));
      }
    }

    console.log("KOMMO LEAD UPDATED FROM ALTEGIO:");
    console.log(JSON.stringify({
      lead_id: lead.id,
      phone,
      targetStatusId,
      altegioValue,
      altegio_record_id: data?.id,
      altegio_visit_id: data?.visit_id
    }, null, 2));

    return res.status(200).json({
      ok: true,
      synced: true,
      lead_id: lead.id,
      targetStatusId,
      kommo: updatedLead
    });
  } catch (error) {
    console.error("ALTEGIO SYNC ERROR:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});


app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});


