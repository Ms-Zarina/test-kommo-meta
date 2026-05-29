
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();

const ALTEGIO_SERVICE_MAP = {
  Kontrola: 5685890,
  "Laserová epilace - Brazilská epilace (třísla + intimní partie)": 5398153,
  "Laserová epilace - Podpaží": 5398144,
  "Laserová epilace - Dolní končetiny (stehna + kolena + lýtka + nárty + prsty)": 5398154,
  "Odstranění výrůstků (nepigmentových névů), bradavic CO2": 5510171,
  "9У Odstranění mimických vrásek 1 oblast": 5510085,
  "Konzultace s kosmetičkou": 5996480
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

function parseStatusIds(value) {
  return String(value || "")
    .split(",")
    .map((statusId) => statusId.trim())
    .filter(hasValue);
}

function getKommoCancelStatusIds() {
  return [
    process.env.CLOSED_STATUS_ID,
    process.env.CANCELLED_STATUS_ID,
    process.env.CANCEL_STATUS_ID,
    process.env.KOMMO_CLOSED_STATUS_ID,
    process.env.KOMMO_CANCEL_STATUS_ID,
    ...parseStatusIds(process.env.CLOSED_STATUS_IDS),
    ...parseStatusIds(process.env.CANCELLED_STATUS_IDS),
    ...parseStatusIds(process.env.CANCEL_STATUS_IDS),
    ...parseStatusIds(process.env.KOMMO_CANCEL_STATUS_IDS)
  ]
    .filter(hasValue)
    .map((statusId) => String(statusId));
}

function isKommoCancelStatus(statusId) {
  if (!hasValue(statusId)) {
    return false;
  }

  return getKommoCancelStatusIds().includes(String(statusId));
}

function getKommoNoAnswerStatusIds() {
  return [
    process.env.NO_ANSWER_STATUS_ID,
    process.env.KOMMO_NO_ANSWER_STATUS_ID,
    process.env.NEDOZVON_STATUS_ID,
    process.env.KOMMO_NEDOZVON_STATUS_ID,
    ...parseStatusIds(process.env.NO_ANSWER_STATUS_IDS),
    ...parseStatusIds(process.env.KOMMO_NO_ANSWER_STATUS_IDS),
    ...parseStatusIds(process.env.NEDOZVON_STATUS_IDS),
    ...parseStatusIds(process.env.KOMMO_NEDOZVON_STATUS_IDS)
  ]
    .filter(hasValue)
    .map((statusId) => String(statusId));
}

function isKommoNoAnswerStatus(statusId) {
  if (!hasValue(statusId)) {
    return false;
  }

  return getKommoNoAnswerStatusIds().includes(String(statusId));
}

function isKommoThinkingStatus(statusId) {
  return hasValue(statusId) &&
    String(statusId) === String(process.env.THINKING_STATUS_ID);
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

function getWebhookEventType(body) {
  if (body?.leads?.delete?.[0]) {
    return "delete";
  }

  if (body?.leads?.status?.[0]) {
    return "status";
  }

  if (body?.leads?.update?.[0]) {
    return "update";
  }

  return "unknown";
}

function getWebhookCustomFieldsDebug(lead) {
  const customFieldsValues = lead?.custom_fields_values || [];
  const customFields = lead?.custom_fields || [];

  return {
    lead_id: lead?.id,
    status_id: lead?.status_id,
    custom_fields_values_count: customFieldsValues.length,
    custom_fields_count: customFields.length,
    custom_fields_values: customFieldsValues.map((field) => ({
      field_id: field.field_id,
      field_name: field.field_name,
      field_code: field.field_code,
      field_type: field.field_type,
      values: field.values,
      raw: field
    })),
    custom_fields: customFields.map((field) => ({
      id: field.id,
      name: field.name,
      code: field.code,
      type: field.type,
      values: field.values,
      raw: field
    }))
  };
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

function mapKommoServicesToAltegioServiceIds(serviceName) {
  if (!hasValue(serviceName)) {
    return { names: [], serviceIds: [], missing: [] };
  }

  // Exact full-string match wins over comma splitting, because some
  // service names legitimately contain commas.
  const exactName = String(serviceName).trim();
  const exactServiceId = mapKommoServiceToAltegioServiceId(serviceName);

  if (exactServiceId) {
    console.log("ALTEGIO EXACT SERVICE MATCH", {
      raw_service: serviceName,
      service_name: exactName,
      service_id: exactServiceId
    });

    return { names: [exactName], serviceIds: [exactServiceId], missing: [] };
  }

  console.log("ALTEGIO FALLBACK MULTI SPLIT", {
    raw_service: serviceName
  });

  const names = String(serviceName)
    .split(",")
    .map((name) => name.trim())
    .filter(hasValue);

  const serviceIds = [];
  const missing = [];

  for (const name of names) {
    const serviceId = mapKommoServiceToAltegioServiceId(name);

    if (serviceId) {
      serviceIds.push(serviceId);
    } else {
      missing.push(name);
    }
  }

  return { names, serviceIds, missing };
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

  const serviceMapping = mapKommoServicesToAltegioServiceIds(serviceName);

  console.log("KOMMO SERVICE SPLIT DEBUG", {
    lead_id: enrichedLead?.id,
    raw_service: serviceName,
    service_names: serviceMapping.names,
    service_ids: serviceMapping.serviceIds,
    missing_services: serviceMapping.missing
  });

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
    serviceIds: serviceMapping.serviceIds,
    missingServices: serviceMapping.missing,
    serviceId: serviceMapping.missing.length
      ? null
      : serviceMapping.serviceIds[0] || null,
    kommoStaffId: Number(staffIdValue) || null,
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

function getDefaultAltegioSeanceLength() {
  return Number(process.env.ALTEGIO_DEFAULT_SEANCE_LENGTH || 900);
}

async function getAltegioServiceDuration({ companyId, serviceId, staffId }) {
  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const requestUrls = [
    `${apiUrl}/api/v1/company/${companyId}/services/${serviceId}`,
    `${apiUrl}/api/v1/services/${companyId}/${serviceId}`
  ];
  let duration = null;
  let source = null;
  let service = null;
  const attempts = [];

  for (const requestUrl of requestUrls) {
    try {
      const response = await axios.get(requestUrl, {
        headers: getAltegioApiHeaders()
      });
      const responseData = response.data?.data;
      const services = Array.isArray(responseData) ? responseData : [responseData];

      service = services.find((item) =>
        String(item?.id) === String(serviceId) ||
        String(item?.salon_service_id) === String(serviceId)
      ) || services.find(Boolean) || null;

      attempts.push({
        request_url: requestUrl,
        status: response.status,
        service_found: Boolean(service),
        service_id: service?.id,
        salon_service_id: service?.salon_service_id,
        duration: service?.duration,
        staff: service?.staff
      });

      const staffService = (service?.staff || []).find((item) =>
        String(item?.id) === String(staffId)
      );

      if (Number(staffService?.seance_length) > 0) {
        duration = Number(staffService.seance_length);
        source = "staff_seance_length";
        break;
      } else if (Number(service?.duration) > 0) {
        duration = Number(service.duration);
        source = "service_duration";
        break;
      }
    } catch (error) {
      attempts.push({
        request_url: requestUrl,
        status: error.response?.status,
        error: error.message,
        data: maskAltegioTokens(error.response?.data)
      });
      console.error("ALTEGIO SERVICE DURATION ERROR:", {
        request_url: requestUrl,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: maskAltegioTokens(error.response?.data),
        message: error.message
      });
    }
  }

  if (!duration) {
    duration = getDefaultAltegioSeanceLength();
    source = "fallback_env";
  }

  console.log("ALTEGIO SERVICE DURATION DEBUG", {
    company_id: companyId,
    service_id: serviceId,
    staff_id: staffId,
    attempts,
    duration,
    source,
    service: service
      ? {
          id: service.id,
          salon_service_id: service.salon_service_id,
          title: service.title,
          duration: service.duration,
          staff: service.staff
        }
      : null
  });

  return duration;
}

async function buildAltegioRecordPayload({ bookingData, includeClient }) {
  const serviceIds =
    Array.isArray(bookingData.serviceIds) && bookingData.serviceIds.length
      ? bookingData.serviceIds
      : bookingData.serviceId
        ? [bookingData.serviceId]
        : [];

  let seanceLength = 0;
  const durationDebug = [];

  for (const serviceId of serviceIds) {
    const duration = await getAltegioServiceDuration({
      companyId: bookingData.companyId,
      serviceId,
      staffId: bookingData.staffId
    });

    seanceLength += Number(duration) || 0;
    durationDebug.push({ service_id: serviceId, duration });
  }

  if (!seanceLength) {
    seanceLength = getDefaultAltegioSeanceLength();
  }

  console.log("ALTEGIO MULTI SERVICE IDS", {
    lead_id: bookingData.leadId,
    service_ids: serviceIds,
    durations: durationDebug,
    total_seance_length: seanceLength
  });

  const payload = {
    staff_id: bookingData.staffId,
    services: serviceIds.map((id) => ({ id })),
    seance_length: seanceLength,
    length: seanceLength,
    datetime: bookingData.datetime,
    save_if_busy: false,
    comment: `Created from Kommo lead ${bookingData.leadId}`,
    api_id: `kommo_lead_${bookingData.leadId}`
  };

  // Altegio requires a `client` object for BOTH create and update (PUT/POST).
  // Include it whenever we have a phone to attach.
  if (includeClient && hasValue(bookingData.phone)) {
    payload.client = {
      phone: bookingData.phone,
      name: bookingData.name
    };

    if (hasValue(bookingData.email)) {
      payload.client.email = bookingData.email;
    }
  }

  return payload;
}

async function getAltegioServiceStaffIds({ companyId, serviceId }) {
  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const requestUrl = `${apiUrl}/api/v1/company/${companyId}/services/${serviceId}`;

  try {
    const response = await axios.get(requestUrl, {
      headers: getAltegioApiHeaders()
    });
    const responseData = response.data?.data;
    const services = Array.isArray(responseData)
      ? responseData
      : [responseData];
    const service =
      services.find((item) =>
        String(item?.id) === String(serviceId) ||
        String(item?.salon_service_id) === String(serviceId)
      ) || services.find(Boolean) || null;
    const staff = Array.isArray(service?.staff) ? service.staff : [];

    return staff
      .map((item) => Number(item?.id))
      .filter((id) => Number.isFinite(id) && id > 0);
  } catch (error) {
    console.error("ALTEGIO SERVICE STAFF FETCH ERROR", {
      company_id: companyId,
      service_id: serviceId,
      status: error.response?.status,
      message: error.message,
      data: maskAltegioTokens(error.response?.data)
    });

    return [];
  }
}

async function resolveAltegioStaffSelection({
  companyId,
  serviceIds,
  kommoStaffId
}) {
  const perService = [];
  let candidates = null;

  for (const serviceId of serviceIds) {
    const staffIds = await getAltegioServiceStaffIds({ companyId, serviceId });

    perService.push({ service_id: serviceId, staff_ids: staffIds });

    if (candidates === null) {
      candidates = new Set(staffIds);
    } else {
      candidates = new Set(staffIds.filter((id) => candidates.has(id)));
    }
  }

  const candidateStaff = candidates ? Array.from(candidates) : [];
  const defaultStaffId = Number(process.env.ALTEGIO_DEFAULT_STAFF_ID) || null;

  let selectedStaffId = null;
  let source = null;

  if (kommoStaffId) {
    selectedStaffId = kommoStaffId;
    source = "kommo_field";
  } else if (defaultStaffId && candidateStaff.includes(defaultStaffId)) {
    selectedStaffId = defaultStaffId;
    source = "default_in_candidates";
  } else if (candidateStaff.length) {
    selectedStaffId = candidateStaff[0];
    source = "auto_first_candidate";
  } else {
    source = "no_candidate";
  }

  return { selectedStaffId, candidateStaff, perService, source };
}

async function applyAltegioStaffSelection(bookingData) {
  const serviceIds =
    Array.isArray(bookingData.serviceIds) && bookingData.serviceIds.length
      ? bookingData.serviceIds
      : bookingData.serviceId
        ? [bookingData.serviceId]
        : [];
  const selection = await resolveAltegioStaffSelection({
    companyId: bookingData.companyId,
    serviceIds,
    kommoStaffId: bookingData.kommoStaffId
  });

  console.log("ALTEGIO STAFF SELECTION DEBUG", {
    lead_id: bookingData.leadId,
    service_ids: serviceIds,
    kommo_staff_id: bookingData.kommoStaffId || null,
    selected_staff_id: selection.selectedStaffId,
    candidate_staff: selection.candidateStaff,
    per_service_staff: selection.perService,
    source: selection.source
  });

  if (!selection.selectedStaffId) {
    console.error("ALTEGIO STAFF MAPPING FAILED", {
      lead_id: bookingData.leadId,
      service_ids: serviceIds,
      candidate_staff: selection.candidateStaff
    });

    return false;
  }

  bookingData.staffId = selection.selectedStaffId;

  return true;
}

function extractLocalDateAndMinutes(value) {
  const text = String(value || "");
  const dateMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  const timeMatch = text.match(/[T ](\d{2}):(\d{2})/);

  if (!dateMatch || !timeMatch) {
    return null;
  }

  return {
    date: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
    minutes: Number(timeMatch[1]) * 60 + Number(timeMatch[2])
  };
}

async function checkAltegioSlotAvailability({
  companyId,
  staffId,
  datetime,
  seanceLength,
  excludeRecordId
}) {
  const selected = extractLocalDateAndMinutes(datetime);

  if (!selected) {
    return { checked: false, available: true, reason: "unparseable_datetime" };
  }

  const durationMin = Math.max(1, Math.ceil((Number(seanceLength) || 0) / 60));
  const selectedStart = selected.minutes;
  const selectedEnd = selectedStart + durationMin;
  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const requestUrl =
    `${apiUrl}/api/v1/records/${companyId}` +
    `?staff_id=${staffId}&start_date=${selected.date}&end_date=${selected.date}&count=200`;

  let records = [];

  try {
    const response = await axios.get(requestUrl, {
      headers: getAltegioApiHeaders()
    });
    const responseData = response.data?.data;
    records = Array.isArray(responseData) ? responseData : [];
  } catch (error) {
    console.error("ALTEGIO SLOT CHECK ERROR", {
      company_id: companyId,
      staff_id: staffId,
      date: selected.date,
      status: error.response?.status,
      message: error.message,
      data: maskAltegioTokens(error.response?.data)
    });

    // Fail open: let Altegio's save_if_busy guard be the final arbiter.
    return { checked: false, available: true, reason: "request_error", date: selected.date };
  }

  const conflicts = [];

  for (const record of records) {
    if (record?.deleted) {
      continue;
    }

    if (String(record?.staff_id) !== String(staffId)) {
      continue;
    }

    if (excludeRecordId && String(record?.id) === String(excludeRecordId)) {
      continue;
    }

    const recordInfo = extractLocalDateAndMinutes(record?.date || record?.datetime);

    if (!recordInfo || recordInfo.date !== selected.date) {
      continue;
    }

    const recordDurationMin = Math.max(
      1,
      Math.ceil(
        ((Number(record?.seance_length) || Number(record?.length) || 0) +
          (Number(record?.technical_break_duration) || 0)) / 60
      )
    );
    const recordStart = recordInfo.minutes;
    const recordEnd = recordStart + recordDurationMin;

    if (selectedStart < recordEnd && recordStart < selectedEnd) {
      conflicts.push({
        record_id: record?.id,
        datetime: record?.datetime || record?.date,
        start_min: recordStart,
        end_min: recordEnd
      });
    }
  }

  return {
    checked: true,
    available: conflicts.length === 0,
    date: selected.date,
    selected_start_min: selectedStart,
    selected_end_min: selectedEnd,
    duration_min: durationMin,
    record_count: records.length,
    conflicts
  };
}

async function ensureAltegioSlotAvailable({ bookingData, payload, excludeRecordId }) {
  const availability = await checkAltegioSlotAvailability({
    companyId: bookingData.companyId,
    staffId: bookingData.staffId,
    datetime: bookingData.datetime,
    seanceLength: payload.seance_length,
    excludeRecordId
  });

  console.log("ALTEGIO SLOT AVAILABILITY DEBUG", {
    lead_id: bookingData.leadId,
    record_id: bookingData.recordId || null,
    staff_id: bookingData.staffId,
    service_ids: payload.services?.map((service) => service.id),
    datetime: bookingData.datetime,
    seance_length: payload.seance_length,
    ...availability
  });

  if (availability.available) {
    return true;
  }

  await reportAltegioSlotUnavailable(bookingData, {
    source: "pre_check",
    payload,
    date: availability.date,
    conflicts: availability.conflicts
  });

  return false;
}

function isAltegioSlotConflict(error) {
  return (
    error?.response?.status === 409 ||
    error?.response?.data?.meta?.conflict === true
  );
}

const recentSlotUnavailableNotes = new Map();
// Short window: only collapse near-simultaneous duplicate deliveries, so a
// legitimate re-test of the same slot still gets the alternatives note.
const SLOT_UNAVAILABLE_NOTE_TTL_MS = 8000;

async function reportAltegioSlotUnavailable(bookingData, details = {}) {
  const { payload, ...logDetails } = details;

  // Idempotent: don't add the same "slot unavailable + alternatives" note (or
  // re-run the alternatives search) twice for the same lead+datetime.
  const noteKey = `${bookingData.leadId}|${bookingData.datetime}`;
  const now = Date.now();

  for (const [key, ts] of recentSlotUnavailableNotes) {
    if (now - ts > SLOT_UNAVAILABLE_NOTE_TTL_MS) {
      recentSlotUnavailableNotes.delete(key);
    }
  }

  const lastNoted = recentSlotUnavailableNotes.get(noteKey);

  if (
    hasValue(bookingData.leadId) &&
    lastNoted &&
    now - lastNoted < SLOT_UNAVAILABLE_NOTE_TTL_MS
  ) {
    console.log("ALTEGIO SLOT UNAVAILABLE - DUPLICATE NOTE SUPPRESSED", {
      lead_id: bookingData.leadId,
      datetime: bookingData.datetime,
      ...logDetails
    });
    return;
  }

  if (hasValue(bookingData.leadId)) {
    recentSlotUnavailableNotes.set(noteKey, now);
  }

  console.error("ALTEGIO SLOT UNAVAILABLE", {
    lead_id: bookingData.leadId,
    record_id: bookingData.recordId || null,
    staff_id: bookingData.staffId,
    datetime: bookingData.datetime,
    ...logDetails
  });

  let suggestions = [];

  if (payload) {
    try {
      const result = await suggestAltegioAlternativeSlots({ bookingData, payload });

      suggestions = result.slots;

      if (suggestions.length) {
        console.log("ALTEGIO ALTERNATIVE SLOTS FOUND", {
          lead_id: bookingData.leadId,
          count: suggestions.length,
          used_fallback_staff: result.usedFallbackStaff,
          slots: suggestions
        });
      } else {
        console.log("ALTEGIO NO ALTERNATIVE SLOTS FOUND", {
          lead_id: bookingData.leadId,
          staff_id: bookingData.staffId,
          datetime: bookingData.datetime
        });
      }
    } catch (error) {
      console.error("ALTEGIO ALTERNATIVE SLOTS ERROR", {
        lead_id: bookingData.leadId,
        message: error.message
      });
    }
  }

  try {
    await addKommoNoteForAltegioSlotUnavailable(bookingData, suggestions);
  } catch (error) {
    console.log("KOMMO SLOT UNAVAILABLE NOTE SKIPPED:", {
      lead_id: bookingData.leadId,
      message: error.message
    });
  }
}

const ALTEGIO_ALTERNATIVE_SLOT_STEP_MIN = 30;
const ALTEGIO_ALTERNATIVE_SEARCH_DAYS = 14;
const ALTEGIO_ALTERNATIVE_MAX_RESULTS = 5;

function addDaysToDateString(dateStr, days) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  date.setUTCDate(date.getUTCDate() + days);

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function parseHmToMinutes(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})/);

  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function minutesToHm(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

async function getAltegioStaffBusyIntervals({ companyId, staffId, date }) {
  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const requestUrl =
    `${apiUrl}/api/v1/records/${companyId}` +
    `?staff_id=${staffId}&start_date=${date}&end_date=${date}&count=200`;

  try {
    const response = await axios.get(requestUrl, {
      headers: getAltegioApiHeaders()
    });
    const records = Array.isArray(response.data?.data) ? response.data.data : [];
    const intervals = [];

    for (const record of records) {
      if (record?.deleted) {
        continue;
      }

      if (String(record?.staff_id) !== String(staffId)) {
        continue;
      }

      const info = extractLocalDateAndMinutes(record?.date || record?.datetime);

      if (!info || info.date !== date) {
        continue;
      }

      const durationMin = Math.max(
        1,
        Math.ceil(
          ((Number(record?.seance_length) || Number(record?.length) || 0) +
            (Number(record?.technical_break_duration) || 0)) / 60
        )
      );

      intervals.push({ start: info.minutes, end: info.minutes + durationMin });
    }

    return intervals;
  } catch (error) {
    console.error("ALTEGIO BUSY INTERVALS ERROR", {
      company_id: companyId,
      staff_id: staffId,
      date,
      status: error.response?.status,
      message: error.message
    });

    // null signals "unknown" so the caller skips this day instead of
    // suggesting a slot that might actually be taken.
    return null;
  }
}

async function findAltegioStaffOpenSlots({
  companyId,
  staffId,
  durationMin,
  fromDate,
  days,
  maxResults,
  nowDate,
  nowMinutes
}) {
  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const toDate = addDaysToDateString(fromDate, days);
  let schedule = [];

  try {
    const response = await axios.get(
      `${apiUrl}/api/v1/schedule/${companyId}/${staffId}/${fromDate}/${toDate}`,
      { headers: getAltegioApiHeaders() }
    );
    schedule = Array.isArray(response.data?.data) ? response.data.data : [];
  } catch (error) {
    console.error("ALTEGIO SCHEDULE ERROR", {
      company_id: companyId,
      staff_id: staffId,
      status: error.response?.status,
      message: error.message
    });

    return [];
  }

  const slots = [];

  for (const day of schedule) {
    if (slots.length >= maxResults) {
      break;
    }

    if (!day?.is_working || !Array.isArray(day?.slots) || !day.slots.length) {
      continue;
    }

    const busy = await getAltegioStaffBusyIntervals({
      companyId,
      staffId,
      date: day.date
    });

    if (busy === null) {
      continue;
    }

    for (const workingSlot of day.slots) {
      if (slots.length >= maxResults) {
        break;
      }

      const fromMin = parseHmToMinutes(workingSlot.from);
      const toMin = parseHmToMinutes(workingSlot.to);

      if (fromMin === null || toMin === null) {
        continue;
      }

      const minStart = day.date === nowDate ? Math.max(fromMin, nowMinutes) : fromMin;

      for (let start = fromMin; start + durationMin <= toMin; start += ALTEGIO_ALTERNATIVE_SLOT_STEP_MIN) {
        if (start < minStart) {
          continue;
        }

        const end = start + durationMin;
        const conflict = busy.some((interval) => start < interval.end && interval.start < end);

        if (!conflict) {
          slots.push({ date: day.date, time: minutesToHm(start), staff_id: staffId });

          if (slots.length >= maxResults) {
            break;
          }
        }
      }
    }
  }

  return slots;
}

async function suggestAltegioAlternativeSlots({ bookingData, payload }) {
  const serviceIds = (payload.services || [])
    .map((service) => service.id)
    .filter(Boolean);
  const durationMin = Math.max(1, Math.ceil((Number(payload.seance_length) || 0) / 60));
  const selectedStaffId = bookingData.staffId;
  const now = extractLocalDateAndMinutes(formatDateInPragueTime(new Date()));
  const fromDate = now?.date || extractLocalDateAndMinutes(bookingData.datetime)?.date;

  if (!fromDate || !selectedStaffId) {
    return { slots: [], usedFallbackStaff: false };
  }

  const searchArgs = {
    companyId: bookingData.companyId,
    durationMin,
    fromDate,
    days: ALTEGIO_ALTERNATIVE_SEARCH_DAYS,
    nowDate: now?.date || null,
    nowMinutes: now?.minutes || 0
  };

  let slots = await findAltegioStaffOpenSlots({
    ...searchArgs,
    staffId: selectedStaffId,
    maxResults: ALTEGIO_ALTERNATIVE_MAX_RESULTS
  });
  let usedFallbackStaff = false;

  if (slots.length === 0 && serviceIds.length) {
    const selection = await resolveAltegioStaffSelection({
      companyId: bookingData.companyId,
      serviceIds,
      kommoStaffId: null
    });
    const otherStaff = selection.candidateStaff.filter(
      (id) => String(id) !== String(selectedStaffId)
    );

    for (const staffId of otherStaff) {
      if (slots.length >= ALTEGIO_ALTERNATIVE_MAX_RESULTS) {
        break;
      }

      const staffSlots = await findAltegioStaffOpenSlots({
        ...searchArgs,
        staffId,
        maxResults: ALTEGIO_ALTERNATIVE_MAX_RESULTS - slots.length
      });

      slots = slots.concat(staffSlots);
    }

    usedFallbackStaff = slots.length > 0;
  }

  return { slots: slots.slice(0, ALTEGIO_ALTERNATIVE_MAX_RESULTS), usedFallbackStaff };
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
  const payload = await buildAltegioRecordPayload({
    bookingData,
    includeClient: true
  });

  console.log("BEFORE ALTEGIO AVAILABILITY CHECK", {
    lead_id: bookingData.leadId,
    flow: "create",
    record_id: bookingData.recordId || null,
    staff_id: bookingData.staffId,
    datetime: bookingData.datetime,
    service_ids: payload.services?.map((service) => service.id),
    seance_length: payload.seance_length
  });

  const slotAvailable = await ensureAltegioSlotAvailable({ bookingData, payload });

  if (!slotAvailable) {
    return { skipped: true, reason: "slot_unavailable" };
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
    if (isAltegioSlotConflict(error)) {
      await reportAltegioSlotUnavailable(bookingData, {
        source: "altegio_409",
        payload,
        data: maskAltegioTokens(error.response?.data)
      });

      return { skipped: true, reason: "slot_unavailable" };
    }

    console.error("ALTEGIO RESPONSE ERROR:", {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: maskAltegioTokens(error.response?.data),
      validation_errors: JSON.stringify(
        error.response?.data?.meta?.errors ?? error.response?.data?.errors ?? null
      ),
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

function isAltegioRecordUpToDate(record, payload) {
  const recordTime = extractLocalDateAndMinutes(record?.datetime);
  const payloadTime = extractLocalDateAndMinutes(payload?.datetime);
  const sameDatetime =
    recordTime &&
    payloadTime &&
    recordTime.date === payloadTime.date &&
    recordTime.minutes === payloadTime.minutes;

  const recordServices = (record?.services || [])
    .map((service) => String(service.id))
    .sort();
  const payloadServices = (payload?.services || [])
    .map((service) => String(service.id))
    .sort();
  const sameServices =
    recordServices.length === payloadServices.length &&
    recordServices.every((id, index) => id === payloadServices[index]);

  const sameStaff = String(record?.staff_id) === String(payload?.staff_id);

  return Boolean(sameDatetime && sameServices && sameStaff);
}

async function updateAltegioRecordFromKommo({ bookingData }) {
  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const requestUrl = `${apiUrl}/api/v1/record/${bookingData.companyId}/${bookingData.recordId}`;
  // Altegio's record update (PUT) also requires the client object, otherwise
  // it returns 422. Include it just like create.
  const payload = await buildAltegioRecordPayload({
    bookingData,
    includeClient: true
  });

  // LOOP PROTECTION: a Kommo<->Altegio webhook ping-pong keeps re-sending the
  // same datetime/services/staff. Skip the PUT (and the Kommo note) when the
  // Altegio record already matches, so the sync settles after one real change.
  try {
    const current = await axios.get(requestUrl, {
      headers: getAltegioApiHeaders()
    });
    const currentRecord = current.data?.data;
    const upToDate = currentRecord
      ? isAltegioRecordUpToDate(currentRecord, payload)
      : false;

    console.log("CURRENT ALTEGIO RECORD SNAPSHOT", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId,
      datetime: currentRecord?.datetime || null,
      service_ids: (currentRecord?.services || []).map((service) => service.id),
      staff_id: currentRecord?.staff_id || null
    });
    console.log("DESIRED KOMMO BOOKING SNAPSHOT", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId,
      datetime: payload.datetime,
      service_ids: payload.services?.map((service) => service.id),
      staff_id: payload.staff_id
    });
    console.log("CHANGE DETECTION RESULT", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId,
      up_to_date: upToDate,
      will_update: !upToDate
    });

    if (currentRecord && upToDate) {
      console.log("ALTEGIO UPDATE SKIPPED - NO CHANGES", {
        lead_id: bookingData.leadId,
        record_id: bookingData.recordId,
        kommo_datetime: payload.datetime,
        altegio_datetime: currentRecord.datetime,
        service_ids: payload.services?.map((service) => service.id),
        staff_id: payload.staff_id
      });

      return {
        unchanged: true,
        recordId: bookingData.recordId,
        visitId: currentRecord.visit_id || bookingData.visitId || null,
        record: currentRecord
      };
    }
  } catch (error) {
    console.log("ALTEGIO UPDATE CHANGE-CHECK SKIPPED", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId,
      status: error.response?.status,
      message: error.message
    });
  }

  console.log("BEFORE ALTEGIO AVAILABILITY CHECK", {
    lead_id: bookingData.leadId,
    flow: "update",
    record_id: bookingData.recordId || null,
    staff_id: bookingData.staffId,
    datetime: bookingData.datetime,
    service_ids: payload.services?.map((service) => service.id),
    seance_length: payload.seance_length
  });

  const slotAvailable = await ensureAltegioSlotAvailable({
    bookingData,
    payload,
    excludeRecordId: bookingData.recordId
  });

  if (!slotAvailable) {
    return { skipped: true, reason: "slot_unavailable" };
  }

  const requestConfig = {
    headers: getAltegioApiHeaders()
  };

  console.log("ALTEGIO UPDATE REQUEST", {
    url: requestUrl,
    datetime: payload.datetime,
    service_ids: payload.services?.map((service) => service.id),
    staff_id: payload.staff_id,
    seance_length: payload.seance_length
  });

  let response;

  try {
    response = await axios.put(requestUrl, payload, requestConfig);
  } catch (error) {
    if (isAltegioSlotConflict(error)) {
      await reportAltegioSlotUnavailable(bookingData, {
        source: "altegio_409",
        payload,
        data: maskAltegioTokens(error.response?.data)
      });

      return { skipped: true, reason: "slot_unavailable" };
    }

    console.error("ALTEGIO RECORD UPDATE ERROR:", {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: maskAltegioTokens(error.response?.data),
      validation_errors: JSON.stringify(
        error.response?.data?.meta?.errors ?? error.response?.data?.errors ?? null
      ),
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

  console.log("ALTEGIO UPDATE RESPONSE", {
    status: response.status,
    record_id: record?.id || bookingData.recordId,
    visit_id: record?.visit_id || bookingData.visitId || null
  });

  console.log("ALTEGIO RECORD UPDATE FROM KOMMO", {
    lead_id: bookingData.leadId,
    record_id: bookingData.recordId,
    visit_id: record?.visit_id || bookingData.visitId || null,
    datetime: bookingData.datetime,
    service_id: bookingData.serviceId,
    staff_id: bookingData.staffId,
    seance_length: payload.seance_length
  });

  return {
    recordId: record?.id || bookingData.recordId,
    visitId: record?.visit_id || bookingData.visitId || null,
    record
  };
}

function getKommoAltegioRecordId(entity) {
  return getKommoCustomFieldValue(
    entity,
    [
      ...KOMMO_ALTEGIO_FIELDS.recordId,
      process.env.KOMMO_ALTEGIO_RECORD_FIELD_ID
    ]
  );
}

function getKommoAltegioCompanyId(entity) {
  const companyId = getKommoCustomFieldValue(
    entity,
    KOMMO_ALTEGIO_FIELDS.companyId
  );

  return Number(companyId || process.env.ALTEGIO_COMPANY_ID) || null;
}

// Hard safety flag. Defaults to TRUE: Kommo events must never delete or
// cancel-write Altegio records. Only an explicit DISABLE_ALTEGIO_DELETE=false
// re-enables any write in the cancel/delete path.
function isAltegioDeleteDisabled() {
  return (
    String(process.env.DISABLE_ALTEGIO_DELETE || "true").trim().toLowerCase() !==
    "false"
  );
}

async function cancelAltegioRecordFromKommo({
  leadId,
  recordId,
  companyId,
  reason
}) {
  // SAFETY: Altegio record deletion/cancellation from Kommo is disabled. This
  // function NEVER performs a DELETE. With DISABLE_ALTEGIO_DELETE (default
  // true) it returns immediately, before any Altegio API call.
  console.log("ALTEGIO DELETE DISABLED", {
    lead_id: leadId,
    record_id: recordId || null,
    company_id: companyId || null,
    reason,
    delete_disabled: isAltegioDeleteDisabled(),
    note: "Altegio record deletion from Kommo is disabled; record kept."
  });

  return {
    skipped: true,
    deleted: false,
    recordKept: true,
    reason: "altegio_delete_disabled"
  };
}

// Best-effort, non-destructive cancellation: marks the Altegio record as
// "did not come" (attendance: -1), which Altegio treats as cancelled. NEVER
// deletes. Only attempts the update when it is safe to do so (the record has
// services and is not update-blocked); otherwise the record is left untouched
// and the caller falls back to keeping it.
async function moveAltegioRecordToCancelled({ companyId, recordId, leadId }) {
  // HARD SAFETY GATE: with DISABLE_ALTEGIO_DELETE (default true), make NO
  // Altegio API call at all - no GET, no PUT, no DELETE. The record is left
  // completely untouched and the caller keeps it.
  if (isAltegioDeleteDisabled()) {
    console.log("ALTEGIO DELETE DISABLED", {
      lead_id: leadId,
      record_id: recordId || null,
      company_id: companyId || null,
      flag: "DISABLE_ALTEGIO_DELETE",
      detail: "Cancel/delete writes to Altegio are disabled; no API call made."
    });

    return { moved: false, reason: "delete_disabled_flag" };
  }

  if (!companyId || !recordId) {
    return { moved: false, reason: "missing_ids" };
  }

  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const recordUrl = `${apiUrl}/api/v1/record/${companyId}/${recordId}`;
  let record = null;

  try {
    const response = await axios.get(recordUrl, {
      headers: getAltegioApiHeaders()
    });
    record = response.data?.data;
  } catch (error) {
    if (error.response?.status === 404) {
      console.log("ALTEGIO RECORD ALREADY MISSING", {
        lead_id: leadId,
        record_id: recordId,
        company_id: companyId
      });

      return { moved: false, reason: "record_missing" };
    }

    console.error("ALTEGIO CANCEL FETCH ERROR", {
      lead_id: leadId,
      record_id: recordId,
      company_id: companyId,
      status: error.response?.status,
      message: error.message
    });

    return { moved: false, reason: "fetch_failed" };
  }

  if (!record || record.deleted) {
    return { moved: false, reason: "record_missing" };
  }

  if (Number(record.attendance) === -1) {
    return { moved: true, reason: "already_cancelled" };
  }

  const services = Array.isArray(record.services) ? record.services : [];

  // Altegio record update requires a service and rejects locked records.
  // These admin-managed/block records cannot be status-updated safely.
  if (!services.length || record.is_update_blocked) {
    return {
      moved: false,
      reason: !services.length ? "no_services" : "update_blocked"
    };
  }

  const baseComment = String(record.comment || "").trim();
  const cancelTag = "Cancelled via Kommo (attendance -1) - not deleted";
  const payload = {
    staff_id: record.staff_id,
    services: services.map((service) => ({
      id: service.id,
      amount: service.amount,
      cost: service.cost
    })),
    datetime: record.datetime,
    seance_length: record.seance_length,
    attendance: -1,
    save_if_busy: true,
    comment: baseComment ? `${baseComment} | ${cancelTag}` : cancelTag
  };

  if (record.client?.id) {
    payload.client = { id: record.client.id };
  } else if (hasValue(record.client?.phone)) {
    payload.client = {
      phone: record.client.phone,
      name: record.client.name || "Altegio Client"
    };
  }

  try {
    await axios.put(recordUrl, payload, { headers: getAltegioApiHeaders() });

    return { moved: true, reason: "attendance_set_cancelled" };
  } catch (error) {
    console.error("ALTEGIO CANCEL STATUS UPDATE ERROR", {
      lead_id: leadId,
      record_id: recordId,
      company_id: companyId,
      status: error.response?.status,
      message: error.message,
      data: maskAltegioTokens(error.response?.data)
    });

    return { moved: false, reason: "update_failed" };
  }
}

// Single safe entry point for Kommo cancel/closed/deleted events. NEVER
// deletes an Altegio record. Tries to move it to cancelled status; otherwise
// keeps it. Adds a Kommo note (unless the lead itself was deleted).
async function handleKommoCancelKeepAltegio({
  leadId,
  recordId,
  companyId,
  statusId,
  isDeleteEvent,
  reason
}) {
  const result = await moveAltegioRecordToCancelled({
    companyId,
    recordId,
    leadId
  });

  let noteFn = null;

  if (result.moved) {
    console.log("ALTEGIO RECORD MOVED TO CANCELLED", {
      lead_id: leadId,
      record_id: recordId || null,
      company_id: companyId || null,
      status_id: statusId || null,
      reason: result.reason
    });
    noteFn = addKommoNoteForAltegioRecordCancelled;
  } else {
    console.log("KOMMO CANCEL ROUTE - ALTEGIO RECORD KEPT", {
      lead_id: leadId,
      record_id: recordId || null,
      company_id: companyId || null,
      status_id: statusId || null,
      reason: result.reason,
      detail: "Altegio status update not applied - record preserved, not deleted"
    });
    console.log("ALTEGIO DELETE DISABLED", {
      lead_id: leadId,
      record_id: recordId || null,
      company_id: companyId || null
    });
    noteFn = addKommoNoteForAltegioRecordKept;
  }

  if (!isDeleteEvent && hasValue(leadId)) {
    try {
      await noteFn(leadId);
    } catch (error) {
      console.log("KOMMO CANCEL NOTE SKIPPED:", {
        lead_id: leadId,
        record_id: recordId || null,
        message: error.message
      });
    }
  }

  return {
    altegioDeleted: false,
    movedToCancelled: result.moved,
    recordKept: true,
    recordId: recordId || null,
    companyId: companyId || null,
    reason: result.reason
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

let kommoLeadCustomFieldsCache = null;

async function getKommoLeadCustomFields() {
  if (kommoLeadCustomFieldsCache) {
    return kommoLeadCustomFieldsCache;
  }

  const response = await axios.get(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/custom_fields`,
    {
      params: {
        limit: 250
      },
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        Accept: "application/json"
      }
    }
  );

  kommoLeadCustomFieldsCache = response.data?._embedded?.custom_fields || [];
  return kommoLeadCustomFieldsCache;
}

async function resolveKommoLeadFieldId(entity, fieldNames, envFieldId) {
  const entityFieldId = getKommoFieldId(entity, fieldNames, envFieldId);

  if (entityFieldId) {
    return Number(entityFieldId);
  }

  const requestedFields = (Array.isArray(fieldNames) ? fieldNames : [fieldNames])
    .filter(hasValue)
    .map((field) => String(field).trim().toLowerCase());
  const fields = await getKommoLeadCustomFields();
  const matchedField = fields.find((field) => {
    const aliases = [field.id, field.field_id, field.name, field.code]
      .filter(hasValue)
      .map((alias) => String(alias).trim().toLowerCase());

    return aliases.some((alias) => requestedFields.includes(alias));
  });

  return matchedField?.id || matchedField?.field_id || null;
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
            "Altegio record created from Kommo",
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

async function addKommoNoteForAltegioRecordUpdated(leadId, recordId, visitId) {
  await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/notes`,
    [
      {
        entity_id: Number(leadId),
        note_type: "common",
        params: {
          text: [
            "Source: Kommo",
            "Altegio record updated from Kommo",
            `Altegio Record ID: ${recordId || "Not specified"}`,
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

async function addKommoNoteForAltegioBookingSkipped(leadId, missing, missingServices) {
  const lines = [
    "Source: Kommo",
    "Altegio record was NOT created/updated - missing required data."
  ];

  if (Array.isArray(missing) && missing.length) {
    lines.push(`Missing: ${missing.join(", ")}`);
  }

  if (Array.isArray(missingServices) && missingServices.length) {
    lines.push(`Unrecognized service(s): ${missingServices.join(", ")}`);
  }

  await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/notes`,
    [
      {
        entity_id: Number(leadId),
        note_type: "common",
        params: {
          text: lines.join("\n")
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

async function addKommoNoteForAltegioRecordKept(leadId) {
  await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/notes`,
    [
      {
        entity_id: Number(leadId),
        note_type: "common",
        params: {
          text: [
            "Source: Kommo",
            "Kommo marked as cancelled. Altegio record was NOT changed."
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

async function addKommoNoteForAltegioRecordCancelled(leadId) {
  await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/notes`,
    [
      {
        entity_id: Number(leadId),
        note_type: "common",
        params: {
          text: [
            "Source: Kommo",
            "Altegio record was moved to cancelled status, not deleted."
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

async function addKommoNoteForAltegioSlotUnavailable(bookingData, suggestions = []) {
  const lines = [
    "Source: Kommo",
    "Selected Altegio slot unavailable.",
    `Requested: ${bookingData.datetime || "Not specified"}, Staff ID: ${bookingData.staffId || "Not specified"}`
  ];

  if (suggestions.length) {
    lines.push("Available alternatives:");
    suggestions.forEach((slot, index) => {
      lines.push(`${index + 1}) ${slot.date} ${slot.time}, Staff ID: ${slot.staff_id}`);
    });
  }

  await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/notes`,
    [
      {
        entity_id: Number(bookingData.leadId),
        note_type: "common",
        params: {
          text: lines.join("\n")
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

async function syncKommoCancelToAltegio(lead, { isDeleteEvent, reason }) {
  const leadId = lead?.id;
  let enrichedLead = null;

  if (isDeleteEvent) {
    console.log("KOMMO LEAD DELETED", {
      lead_id: leadId,
      status_id: lead?.status_id
    });
  }

  try {
    if (hasValue(leadId)) {
      enrichedLead = await getEnrichedKommoLead(leadId);
    }
  } catch (error) {
    console.log("KOMMO CANCEL ENRICHMENT SKIPPED:", {
      lead_id: leadId,
      status: error.response?.status,
      message: error.message
    });
  }

  const recordId =
    getKommoAltegioRecordId(enrichedLead) ||
    getKommoAltegioRecordId(lead);
  const companyId =
    getKommoAltegioCompanyId(enrichedLead) ||
    getKommoAltegioCompanyId(lead);

  // SAFETY: never delete the Altegio record. Best-effort move to cancelled,
  // otherwise keep it. (Lead-deleted events skip the Kommo note internally.)
  const result = await handleKommoCancelKeepAltegio({
    leadId,
    recordId,
    companyId,
    statusId: lead?.status_id,
    isDeleteEvent,
    reason
  });

  return {
    cancelled: false,
    skipped: true,
    ...result
  };
}

async function syncKommoExistingRecordUpdateToAltegio(
  enrichedLead,
  contact,
  reason
) {
  const bookingData = extractKommoBookingData(enrichedLead, contact);

  console.log("KOMMO EXISTING RECORD UPDATE DEBUG", {
    lead_id: bookingData.leadId,
    record_id: bookingData.recordId,
    datetime: bookingData.datetime,
    service: bookingData.serviceName,
    service_id: bookingData.serviceId,
    staff_id: bookingData.staffId,
    company_id: bookingData.companyId,
    reason
  });

  if (!hasValue(bookingData.recordId)) {
    console.log("EXISTING RECORD UPDATE SKIPPED - NO RECORD ID", {
      lead_id: bookingData.leadId,
      reason
    });

    return {
      updated: false,
      skipped: true,
      reason: "No existing Altegio record ID"
    };
  }

  const missing = [];

  if (!hasValue(bookingData.datetime)) {
    missing.push("datetime");
  }

  if (!bookingData.serviceId) {
    missing.push("service_mapping");

    if (bookingData.missingServices?.length) {
      console.error("ALTEGIO SERVICE MAPPING FAILED", {
        lead_id: bookingData.leadId,
        raw_service: bookingData.serviceName,
        missing_services: bookingData.missingServices
      });
    }
  }

  if (!bookingData.companyId) {
    missing.push("company_id");
  }

  if (!bookingData.staffId) {
    missing.push("staff_id");
  }

  if (missing.length) {
    console.log("EXISTING RECORD UPDATE SKIPPED - MISSING REQUIRED DATA", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId,
      missing,
      service: bookingData.serviceName,
      reason
    });

    return {
      updated: false,
      skipped: true,
      reason: "Missing required data",
      missing
    };
  }

  const staffSelected = await applyAltegioStaffSelection(bookingData);

  if (!staffSelected) {
    console.log("EXISTING RECORD UPDATE SKIPPED - NO STAFF FOR SERVICES", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId,
      service_ids: bookingData.serviceIds,
      reason
    });

    return {
      updated: false,
      skipped: true,
      reason: "No staff provides selected services"
    };
  }

  console.log("EXISTING RECORD UPDATE START", {
    lead_id: bookingData.leadId,
    record_id: bookingData.recordId,
    company_id: bookingData.companyId,
    datetime: bookingData.datetime,
    service: bookingData.serviceName,
    service_id: bookingData.serviceId,
    staff_id: bookingData.staffId,
    reason
  });

  const updatedRecord = await updateAltegioRecordFromKommo({ bookingData });

  if (updatedRecord?.skipped) {
    return {
      updated: false,
      skipped: true,
      reason: updatedRecord.reason || "slot_unavailable"
    };
  }

  return {
    updated: true,
    recordId: updatedRecord.recordId,
    visitId: updatedRecord.visitId,
    companyId: bookingData.companyId
  };
}

async function routeKommoToAltegio({
  enrichedLead,
  contact,
  webhookEventType,
  webhookLead,
  statusId
}) {
  const bookingData = extractKommoBookingData(enrichedLead, contact);
  const isBookingStatus =
    String(statusId) === String(process.env.BOOKING_STATUS_ID);
  const isThinkingStatus = isKommoThinkingStatus(statusId);
  const isNoAnswerStatus = isKommoNoAnswerStatus(statusId);
  const isCancelStatus = !isNoAnswerStatus && isKommoCancelStatus(statusId);
  const route = isBookingStatus
    ? "booking"
    : isThinkingStatus
        ? "thinking"
        : isNoAnswerStatus
          ? "no_answer"
          : isCancelStatus
            ? "cancel"
            : "no_altegio_action";

  console.log("KOMMO TO ALTEGIO ROUTER START", {
    lead_id: enrichedLead?.id || webhookLead?.id,
    webhook_event_type: webhookEventType,
    webhook_status_id: webhookLead?.status_id,
    effective_status_id: statusId,
    record_id: bookingData.recordId,
    has_record_id: hasValue(bookingData.recordId),
    datetime: bookingData.datetime,
    has_datetime: hasValue(bookingData.datetime),
    service: bookingData.serviceName,
    service_id: bookingData.serviceId,
    has_service: hasValue(bookingData.serviceName),
    phone: bookingData.phone,
    has_phone: hasValue(bookingData.phone),
    staff_id: bookingData.staffId,
    company_id: bookingData.companyId
  });

  console.log("KOMMO STATUS ROUTE", {
    lead_id: enrichedLead?.id || webhookLead?.id,
    status_id: statusId,
    route,
    booking_status_id: process.env.BOOKING_STATUS_ID,
    thinking_status_id: process.env.THINKING_STATUS_ID,
    no_answer_status_ids: getKommoNoAnswerStatusIds(),
    cancel_status_ids: getKommoCancelStatusIds()
  });

  if (isBookingStatus) {
    if (hasValue(bookingData.recordId)) {
      console.log("KOMMO TO ALTEGIO UPDATE START", {
        lead_id: bookingData.leadId,
        record_id: bookingData.recordId,
        status_id: statusId,
        datetime: bookingData.datetime,
        service: bookingData.serviceName,
        service_id: bookingData.serviceId
      });
    }

    await syncKommoBookingToAltegio(enrichedLead, contact);

    return {
      route,
      synced: true,
      recordId: bookingData.recordId || null
    };
  }

  if (isThinkingStatus || isNoAnswerStatus) {
    if (isNoAnswerStatus) {
      console.log("KOMMO NO ANSWER - ALTEGIO RECORD KEPT", {
        lead_id: bookingData.leadId,
        status_id: statusId,
        record_id: bookingData.recordId || null
      });
    }

    console.log("KOMMO STATUS DOES NOT REQUIRE ALTEGIO CREATE", {
      lead_id: bookingData.leadId,
      status_id: statusId,
      route,
      record_id: bookingData.recordId || null
    });
    console.log("ALTEGIO STATUS SYNC SKIPPED", {
      lead_id: bookingData.leadId,
      status_id: statusId,
      route,
      reason: "Status does not create or update Altegio appointment"
    });

    return {
      route,
      synced: false,
      skipped: true,
      reason: "Status does not require Altegio create"
    };
  }

  if (isCancelStatus) {
    // SAFETY: cancel/closed Kommo statuses must NEVER delete the Altegio
    // record. Best-effort move to cancelled status; otherwise keep it.
    const cancelResult = await handleKommoCancelKeepAltegio({
      leadId: bookingData.leadId,
      recordId: bookingData.recordId,
      companyId: bookingData.companyId,
      statusId,
      isDeleteEvent: false,
      reason: `Kommo lead moved to cancelled status ${statusId}`
    });

    return {
      route,
      synced: false,
      skipped: true,
      ...cancelResult
    };
  }

  console.log("ALTEGIO STATUS SYNC SKIPPED", {
    lead_id: bookingData.leadId,
    status_id: statusId,
    route,
    reason: "No Kommo to Altegio route for status"
  });

  return {
    route,
    synced: false,
    skipped: true,
    reason: "No Kommo to Altegio route for status"
  };
}

// Short-TTL dedup so duplicate/near-simultaneous Kommo webhooks for the same
// booking intent don't trigger the Altegio create/update twice.
const recentAltegioBookingSyncs = new Map();
// Short window: only collapses near-simultaneous duplicate webhook deliveries.
// The Kommo<->Altegio echo loop is handled separately by change-detection, so
// this must stay small to never block a legitimate re-edit of the booking.
const ALTEGIO_BOOKING_SYNC_DEDUP_MS = 5000;

function shouldSkipDuplicateAltegioBookingSync(signature) {
  const now = Date.now();

  for (const [key, timestamp] of recentAltegioBookingSyncs) {
    if (now - timestamp > ALTEGIO_BOOKING_SYNC_DEDUP_MS) {
      recentAltegioBookingSyncs.delete(key);
    }
  }

  const last = recentAltegioBookingSyncs.get(signature);

  if (last && now - last < ALTEGIO_BOOKING_SYNC_DEDUP_MS) {
    return true;
  }

  // Set synchronously (before any await) so concurrent webhooks can't both pass.
  recentAltegioBookingSyncs.set(signature, now);
  return false;
}

async function syncKommoBookingToAltegio(enrichedLead, contact) {
  const bookingData = extractKommoBookingData(enrichedLead, contact);

  const dedupSignature = [
    bookingData.leadId,
    bookingData.recordId || "new",
    bookingData.datetime || "",
    (bookingData.serviceIds || []).join(","),
    bookingData.staffId || ""
  ].join("|");

  console.log("DEDUP SIGNATURE DEBUG", {
    lead_id: bookingData.leadId,
    record_id: bookingData.recordId || null,
    datetime: bookingData.datetime,
    service_ids: bookingData.serviceIds,
    staff_id: bookingData.staffId,
    signature: dedupSignature,
    dedup_window_ms: ALTEGIO_BOOKING_SYNC_DEDUP_MS
  });

  if (
    hasValue(bookingData.leadId) &&
    shouldSkipDuplicateAltegioBookingSync(dedupSignature)
  ) {
    console.log("ALTEGIO SYNC SKIPPED - DUPLICATE WEBHOOK", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId || null,
      signature: dedupSignature
    });
    return;
  }

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

  const missing = [];

  if (!hasValue(bookingData.recordId) && !hasValue(bookingData.phone)) {
    missing.push("phone");
  }

  if (!hasValue(bookingData.datetime)) {
    missing.push("datetime");
  }

  if (!bookingData.serviceId) {
    missing.push("service_mapping");

    if (bookingData.missingServices?.length) {
      console.error("ALTEGIO SERVICE MAPPING FAILED", {
        lead_id: bookingData.leadId,
        raw_service: bookingData.serviceName,
        missing_services: bookingData.missingServices
      });
    }
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

    if (hasValue(bookingData.leadId)) {
      try {
        await addKommoNoteForAltegioBookingSkipped(
          bookingData.leadId,
          missing,
          bookingData.missingServices
        );
      } catch (error) {
        console.log("KOMMO SKIPPED NOTE FAILED:", {
          lead_id: bookingData.leadId,
          message: error.message
        });
      }
    }

    return;
  }

  const staffSelected = await applyAltegioStaffSelection(bookingData);

  if (!staffSelected) {
    console.log("ALTEGIO CREATE/UPDATE SKIPPED - NO STAFF FOR SERVICES", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId || null,
      service_ids: bookingData.serviceIds
    });
    return;
  }

  if (hasValue(bookingData.recordId)) {
    console.log("EXISTING RECORD UPDATE START", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId,
      company_id: bookingData.companyId,
      datetime: bookingData.datetime,
      service: bookingData.serviceName,
      staff_id: bookingData.staffId
    });

    const updateResult = await updateAltegioRecordFromKommo({ bookingData });

    // Only note a genuine, applied update. Skip the note when the slot was
    // unavailable (skipped - its own note was added) or when nothing changed
    // (unchanged - avoids note spam from the webhook ping-pong).
    if (!updateResult?.skipped && !updateResult?.unchanged) {
      try {
        await addKommoNoteForAltegioRecordUpdated(
          bookingData.leadId,
          updateResult?.recordId || bookingData.recordId,
          updateResult?.visitId || bookingData.visitId
        );
      } catch (error) {
        console.log("KOMMO UPDATE NOTE FAILED:", {
          lead_id: bookingData.leadId,
          record_id: bookingData.recordId,
          message: error.message
        });
      }
    }

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

  const createdRecord = await createAltegioRecordFromKommo({ bookingData });

  if (createdRecord?.skipped) {
    return;
  }

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
    const webhookEventType = getWebhookEventType(req.body);
    const lead =
      req.body?.leads?.status?.[0] ||
      req.body?.leads?.update?.[0] ||
      req.body?.leads?.delete?.[0];
    const isDeleteEvent = webhookEventType === "delete";

    if (!lead) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "No lead data in webhook"
      });
    }

    console.log("WEBHOOK EVENT TYPE", {
      type: webhookEventType,
      lead_id: lead.id,
      status_id: lead.status_id
    });
    console.log(
      "UPDATED CUSTOM FIELDS",
      JSON.stringify(getWebhookCustomFieldsDebug(lead), null, 2)
    );

    if (isDeleteEvent) {
      console.log("KOMMO EVENT DEBUG:", {
        lead_id: lead.id,
        status_id: lead.status_id,
        eventName: null,
        isDeleteEvent,
        isCancelStatus: false,
        trackedStatuses: {
          THINKING_STATUS_ID: process.env.THINKING_STATUS_ID,
          BOOKING_STATUS_ID: process.env.BOOKING_STATUS_ID,
          SUCCESSFULLY_STATUS_ID: process.env.SUCCESSFULLY_STATUS_ID,
          CLOSED_STATUS_ID: process.env.CLOSED_STATUS_ID,
          CANCELLED_STATUS_ID: process.env.CANCELLED_STATUS_ID,
          CANCEL_STATUS_IDS: getKommoCancelStatusIds()
        }
      });

      const cancelResult = await syncKommoCancelToAltegio(lead, {
        isDeleteEvent,
        reason: "Kommo lead deleted"
      });

      return res.json({
        ok: true,
        kommo_to_altegio_cancel: true,
        lead_id: lead.id,
        status_id: lead.status_id,
        ...cancelResult
      });
    }

    console.log("START KOMMO ENRICHMENT:", { lead_id: lead.id });

    const enrichedLead = await getEnrichedKommoLead(lead.id);

    console.log("FINISH KOMMO ENRICHMENT:", { lead_id: lead.id });

    logEnrichedKommoLead(enrichedLead);
    logKommoLeadCustomFieldsDebug(enrichedLead);
    const contactId = enrichedLead?._embedded?.contacts?.[0]?.id;
    let contactData = null;

    if (contactId) {
      contactData = await getContactById(contactId);
    }

    const effectiveStatusId = lead.status_id || enrichedLead?.status_id;
    const eventName = getMetaEventNameByStatus(effectiveStatusId);
    const isNoAnswerStatus = isKommoNoAnswerStatus(effectiveStatusId);
    const isCancelStatus =
      !isNoAnswerStatus && isKommoCancelStatus(effectiveStatusId);

    console.log("KOMMO EVENT DEBUG:", {
      lead_id: lead.id,
      webhook_status_id: lead.status_id,
      enriched_status_id: enrichedLead?.status_id,
      status_id: effectiveStatusId,
      eventName,
      isDeleteEvent,
      isNoAnswerStatus,
      isCancelStatus,
      trackedStatuses: {
        THINKING_STATUS_ID: process.env.THINKING_STATUS_ID,
        BOOKING_STATUS_ID: process.env.BOOKING_STATUS_ID,
        SUCCESSFULLY_STATUS_ID: process.env.SUCCESSFULLY_STATUS_ID,
        NO_ANSWER_STATUS_IDS: getKommoNoAnswerStatusIds(),
        CLOSED_STATUS_ID: process.env.CLOSED_STATUS_ID,
        CANCELLED_STATUS_ID: process.env.CANCELLED_STATUS_ID,
        CANCEL_STATUS_IDS: getKommoCancelStatusIds()
      }
    });

    let kommoToAltegioResult = null;

    try {
      kommoToAltegioResult = await routeKommoToAltegio({
        enrichedLead,
        contact: contactData,
        webhookEventType,
        webhookLead: lead,
        statusId: effectiveStatusId
      });
    } catch (error) {
      console.error("KOMMO TO ALTEGIO ERROR:", {
        message: error.message,
        lead_id: lead.id,
        status_id: effectiveStatusId,
        status: error.response?.status,
        data: maskAltegioTokens(error.response?.data)
      });
      throw error;
    }

    if (!eventName) {
      return res.json({
        ok: true,
        lead_id: lead.id,
        status_id: effectiveStatusId,
        kommo_to_altegio: kommoToAltegioResult,
        meta: {
          skipped: true,
          reason: "Status not tracked for Meta"
        }
      });
    }

    const eventKey = `${lead.id}_${effectiveStatusId}_${eventName}`;

    console.log("KOMMO EVENT KEY:", eventKey);

    const isDuplicateEvent = sentEvents.has(eventKey);

    if (isDuplicateEvent) {
      console.log("META DUPLICATE SKIPPED ONLY", {
        eventKey,
        lead_id: lead.id,
        status_id: effectiveStatusId,
        kommo_to_altegio: kommoToAltegioResult
      });

      return res.json({
        ok: true,
        lead_id: lead.id,
        status_id: effectiveStatusId,
        eventName,
        kommo_to_altegio: kommoToAltegioResult,
        meta: {
          skipped: true,
          reason: "Duplicate Meta event skipped",
          eventKey
        }
      });
    }

    sentEvents.add(eventKey);

    const { email, phone } = extractEmailAndPhone(contactData || {});
    const {
      fbp,
      fbc,
      source: attributionSource
    } = getMetaAttribution(enrichedLead, contactData);

    if (!email && !phone) {
      return res.json({
        ok: true,
        lead_id: lead.id,
        status_id: effectiveStatusId,
        eventName,
        contact_id: contactId,
        kommo_to_altegio: kommoToAltegioResult,
        meta: {
          skipped: true,
          reason: "No email or phone in contact"
        }
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
      status_id: effectiveStatusId,
      eventName,
      kommo_to_altegio: kommoToAltegioResult,
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

async function findKommoLeadByAltegioRecord({ recordId, visitId }) {
  const identifiers = [
    {
      type: "record_id",
      value: recordId,
      fieldNames: [
        ...KOMMO_ALTEGIO_FIELDS.recordId,
        process.env.KOMMO_ALTEGIO_RECORD_FIELD_ID
      ]
    },
    {
      type: "visit_id",
      value: visitId,
      fieldNames: [
        ...KOMMO_ALTEGIO_FIELDS.visitId,
        process.env.KOMMO_ALTEGIO_VISIT_FIELD_ID
      ]
    }
  ].filter((identifier) => hasValue(identifier.value));

  for (const identifier of identifiers) {
    const response = await axios.get(
      `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads`,
      {
        params: {
          query: String(identifier.value),
          with: "contacts",
          limit: 10
        },
        headers: {
          Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
          Accept: "application/json"
        }
      }
    );
    const leads = response.data?._embedded?.leads || [];

    for (const lead of leads) {
      const enrichedLead = await getEnrichedKommoLead(lead.id);
      const fieldValue = getKommoCustomFieldValue(
        enrichedLead,
        identifier.fieldNames
      );

      if (String(fieldValue) === String(identifier.value)) {
        console.log("DUPLICATE PREVENTED BY RECORD ID", {
          lead_id: enrichedLead.id,
          record_id: recordId,
          visit_id: visitId,
          matched_by: identifier.type,
          matched_value: identifier.value
        });

        return enrichedLead;
      }
    }
  }

  return null;
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

function getAltegioRecordId(data) {
  return data?.id || data?.record_id;
}

function getAltegioVisitId(data) {
  return data?.visit_id;
}

function parsePragueOffsetMinutes(date) {
  const match = formatDateInPragueTime(date).match(/([+-])(\d{2}):(\d{2})$/);

  if (!match) {
    return 0;
  }

  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function parseAltegioDatetimeForKommo(value) {
  if (!hasValue(value)) {
    return null;
  }

  const textValue = String(value).trim();

  if (/^\d{10}$/.test(textValue)) {
    return Number(textValue);
  }

  if (/^\d{13}$/.test(textValue)) {
    return Math.floor(Number(textValue) / 1000);
  }

  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(textValue)) {
    const parsedTime = Date.parse(textValue);
    return Number.isNaN(parsedTime) ? null : Math.floor(parsedTime / 1000);
  }

  const match = textValue.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/
  );

  if (!match) {
    const parsedTime = Date.parse(textValue);
    return Number.isNaN(parsedTime) ? null : Math.floor(parsedTime / 1000);
  }

  const localUtcTime = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  );
  const pragueOffsetMinutes = parsePragueOffsetMinutes(new Date(localUtcTime));

  return Math.floor((localUtcTime - pragueOffsetMinutes * 60000) / 1000);
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

  // Best-effort note: must NEVER block the Kommo status update that follows.
  try {
    await addKommoLeadNoteFromAltegio(lead.id, data);
  } catch (error) {
    console.log("ALTEGIO SOURCE NOTE SKIPPED:", {
      lead_id: lead.id,
      message: error.message
    });
  }
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

async function updateKommoLeadFromAltegio({
  lead,
  data,
  statusId,
  value
}) {
  let enrichedLead = lead;

  try {
    enrichedLead = await getEnrichedKommoLead(lead.id);
  } catch (error) {
    console.error("KOMMO LEAD ENRICH FOR ALTEGIO UPDATE ERROR:", {
      message: error.message,
      lead_id: lead.id
    });
  }

  const recordId = getAltegioRecordId(data);
  const visitId = getAltegioVisitId(data);
  const datetime = getAltegioBookingDatetime(data);
  const datetimeValue = parseAltegioDatetimeForKommo(datetime);
  const serviceName = getAltegioServiceName(data);
  const customFieldsValues = [];
  const datetimeFieldId = await resolveKommoLeadFieldId(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.datetime,
    process.env.KOMMO_ALTEGIO_DATETIME_FIELD_ID
  );
  const serviceFieldId = await resolveKommoLeadFieldId(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.service,
    process.env.KOMMO_ALTEGIO_SERVICE_FIELD_ID
  );
  const recordFieldId = await resolveKommoLeadFieldId(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.recordId,
    process.env.KOMMO_ALTEGIO_RECORD_FIELD_ID
  );
  const visitFieldId = await resolveKommoLeadFieldId(
    enrichedLead,
    KOMMO_ALTEGIO_FIELDS.visitId,
    process.env.KOMMO_ALTEGIO_VISIT_FIELD_ID
  );

  if (datetimeFieldId && datetimeValue) {
    customFieldsValues.push({
      field_id: Number(datetimeFieldId),
      values: [{ value: datetimeValue }]
    });
  }

  if (serviceFieldId && hasValue(serviceName)) {
    customFieldsValues.push({
      field_id: Number(serviceFieldId),
      values: [{ value: serviceName }]
    });
  }

  if (recordFieldId && hasValue(recordId)) {
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

  const payload = {};

  if (statusId) {
    payload.status_id = Number(statusId);
  }

  if (Number.isFinite(value)) {
    payload.price = Math.round(value);
  }

  if (customFieldsValues.length) {
    payload.custom_fields_values = customFieldsValues;
  }

  if (!Object.keys(payload).length) {
    console.log("KOMMO LEAD UPDATED TIME FROM ALTEGIO", {
      lead_id: lead.id,
      skipped: true,
      reason: "No Kommo fields resolved for Altegio update",
      record_id: recordId,
      visit_id: visitId,
      datetime,
      service: serviceName
    });
    return null;
  }

  const response = await axios.patch(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/${lead.id}`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    }
  );

  console.log("KOMMO LEAD UPDATED TIME FROM ALTEGIO", {
    lead_id: lead.id,
    status_id: statusId || null,
    datetime,
    datetime_value: datetimeValue,
    service: serviceName,
    record_id: recordId,
    visit_id: visitId,
    price: Number.isFinite(value) ? Math.round(value) : null,
    updated_field_ids: customFieldsValues.map((field) => field.field_id)
  });

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
    const { resource, status, data } = req.body;

    console.log("ALTEGIO WEBHOOK:", JSON.stringify({
      resource,
      status,
      record: {
        id: data?.id,
        datetime: data?.datetime,
        attendance: data?.attendance,
        visit_attendance: data?.visit_attendance,
        confirmed: data?.confirmed,
        deleted: data?.deleted,
        staff_id: data?.staff_id,
        services: (data?.services || []).map((service) => service.id),
        client_phone: data?.client?.phone
      }
    }));

    if (resource !== "record") {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "Not a record event"
      });
    }

    const recordId = getAltegioRecordId(data);
    const visitId = getAltegioVisitId(data);
    const phone = data?.client?.phone;

    if (!phone && !recordId && !visitId) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "No client phone or Altegio record identifiers in Altegio record"
      });
    }

    const clientName =
      data?.client?.display_name ||
      data?.client?.name ||
      "Altegio Client";
    const email = data?.client?.email || null;
    const serviceName = getAltegioServiceName(data);
    const bookingDatetime = getAltegioBookingDatetime(data);
    const altegioValue = getValidPurchaseValue(data);
    const budgetValue = getAltegioRecordValue(data);

    console.log("PURCHASE VALUE DEBUG:", {
      services: data?.services?.map((service) => ({
        title: service.title,
        cost_to_pay: service.cost_to_pay,
        cost: service.cost,
        amount: service.amount
      })),
      calculatedValue: altegioValue
    });

    const leadByRecord = await findKommoLeadByAltegioRecord({
      recordId,
      visitId
    });
    const lead = leadByRecord || (phone
      ? await findKommoLeadByPhone(phone)
      : null);

    if (!lead) {
      const isBookingCreated =
        status === "create" ||
        data?.confirmed === 1;

      if (!isBookingCreated) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: "No Kommo lead found by record ID or phone",
          phone,
          record_id: recordId,
          visit_id: visitId
        });
      }

      if (!phone) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: "No client phone for Kommo contact creation",
          record_id: recordId,
          visit_id: visitId
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

    // attendance/visit_attendance describe whether the client showed up, which
    // only makes sense once the appointment time has passed. A FUTURE booking
    // with attendance -1 is stale/erroneous data and must NOT be treated as a
    // no-show (otherwise an active booking is mis-mapped to "Отмена").
    const recordMs = Date.parse(data?.datetime || "");
    const recordIsPast = Number.isFinite(recordMs) && recordMs < Date.now();

    if (status === "create" || data?.confirmed === 1) {
      targetStatusId = process.env.BOOKING_STATUS_ID;
    }

    if (data?.attendance === 1 || data?.visit_attendance === 1) {
      targetStatusId = process.env.SUCCESSFULLY_STATUS_ID;
    }

    if (
      (data?.attendance === -1 || data?.visit_attendance === -1) &&
      recordIsPast
    ) {
      // Altegio cancelled/no-show -> Kommo "Отмена". Prefer a dedicated cancel
      // status if configured; fall back to CLOSED_STATUS_ID (existing behavior).
      targetStatusId =
        process.env.CANCELLED_STATUS_ID ||
        process.env.CANCEL_STATUS_ID ||
        process.env.CLOSED_STATUS_ID;
    } else if (
      (data?.attendance === -1 || data?.visit_attendance === -1) &&
      !recordIsPast &&
      !targetStatusId
    ) {
      // Future booking with a stale -1 and not otherwise confirmed: keep it as
      // a booking rather than cancelling it.
      targetStatusId = process.env.BOOKING_STATUS_ID;
    }

    if (!targetStatusId) {
      const updatedLeadWithoutStatus = await updateKommoLeadFromAltegio({
        lead,
        data,
        statusId: null,
        value: budgetValue
      });

      return res.status(200).json({
        ok: true,
        synced: true,
        status_updated: false,
        reason: "No matching status rule; updated Altegio fields only",
        lead_id: lead.id,
        altegio_status: status,
        attendance: data?.attendance,
        visit_attendance: data?.visit_attendance,
        kommo: updatedLeadWithoutStatus
      });
    }

    if (String(targetStatusId) === String(process.env.BOOKING_STATUS_ID)) {
      // Non-blocking: a note/source-marking failure must not prevent the
      // Kommo status update below.
      try {
        await markKommoLeadAsSourcedFromAltegio(lead, data);
      } catch (error) {
        console.error("ALTEGIO MARK SOURCED ERROR (status update continues):", {
          lead_id: lead.id,
          message: error.message
        });
      }
    }

    console.log("ALTEGIO -> KOMMO STATUS UPDATE", {
      lead_id: lead.id,
      altegio_status: status,
      attendance: data?.attendance,
      visit_attendance: data?.visit_attendance,
      confirmed: data?.confirmed,
      record_is_past: recordIsPast,
      target_status_id: targetStatusId
    });

    const updatedLead = await updateKommoLeadFromAltegio({
      lead,
      data,
      statusId: targetStatusId,
      value: budgetValue
    });

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


