
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
  "9У Odstranění mimických vrásek 1 oblast": 5510085
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

  if (includeClient) {
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

async function reportAltegioSlotUnavailable(bookingData, details) {
  console.error("ALTEGIO SLOT UNAVAILABLE", {
    lead_id: bookingData.leadId,
    record_id: bookingData.recordId || null,
    staff_id: bookingData.staffId,
    datetime: bookingData.datetime,
    ...details
  });

  try {
    await addKommoNoteForAltegioSlotUnavailable(bookingData);
  } catch (error) {
    console.log("KOMMO SLOT UNAVAILABLE NOTE SKIPPED:", {
      lead_id: bookingData.leadId,
      message: error.message
    });
  }
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
        data: maskAltegioTokens(error.response?.data)
      });

      return { skipped: true, reason: "slot_unavailable" };
    }

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

async function updateAltegioRecordFromKommo({ bookingData }) {
  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const requestUrl = `${apiUrl}/api/v1/record/${bookingData.companyId}/${bookingData.recordId}`;
  const payload = await buildAltegioRecordPayload({
    bookingData,
    includeClient: false
  });

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

  console.log("ALTEGIO UPDATE REQUEST URL:", requestUrl);
  console.log(
    "EXISTING RECORD UPDATE PAYLOAD",
    JSON.stringify(payload, null, 2)
  );

  let response;

  try {
    response = await axios.put(requestUrl, payload, requestConfig);
  } catch (error) {
    if (isAltegioSlotConflict(error)) {
      await reportAltegioSlotUnavailable(bookingData, {
        source: "altegio_409",
        data: maskAltegioTokens(error.response?.data)
      });

      return { skipped: true, reason: "slot_unavailable" };
    }

    console.error("ALTEGIO RECORD UPDATE ERROR:", {
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

  console.log(
    "ALTEGIO UPDATE RESPONSE",
    JSON.stringify(
      {
        status: response.status,
        data: response.data
      },
      null,
      2
    )
  );

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

async function cancelAltegioRecordFromKommo({
  leadId,
  recordId,
  companyId,
  reason
}) {
  const apiUrl = (process.env.ALTEGIO_API_URL || "https://api.alteg.io")
    .replace(/\/$/, "");
  const requestUrl = `${apiUrl}/api/v1/record/${companyId}/${recordId}`;
  const requestConfig = {
    headers: getAltegioApiHeaders()
  };

  console.log("ALTEGIO CANCEL REQUEST URL:", requestUrl);
  console.log(
    "ALTEGIO CANCEL REQUEST HEADERS:",
    maskAltegioTokens(requestConfig.headers)
  );

  try {
    const response = await axios.delete(requestUrl, requestConfig);

    console.log("ALTEGIO RECORD CANCELLED FROM KOMMO", {
      lead_id: leadId,
      record_id: recordId,
      company_id: companyId,
      reason,
      status: response.status
    });

    return response;
  } catch (error) {
    if (error.response?.status === 404) {
      console.log("ALTEGIO RECORD ALREADY MISSING", {
        lead_id: leadId,
        record_id: recordId,
        company_id: companyId,
        reason
      });

      return { skipped: true, alreadyMissing: true, status: 404 };
    }

    console.error("ALTEGIO RECORD CANCEL ERROR:", {
      lead_id: leadId,
      record_id: recordId,
      company_id: companyId,
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

async function addKommoNoteForAltegioCancel(leadId, recordId, reason) {
  await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/notes`,
    [
      {
        entity_id: Number(leadId),
        note_type: "common",
        params: {
          text: [
            "Source: Kommo",
            "Action: Altegio record cancelled",
            `Altegio Record ID: ${recordId}`,
            `Reason: ${reason}`
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

async function addKommoNoteForAltegioSlotUnavailable(bookingData) {
  await axios.post(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/notes`,
    [
      {
        entity_id: Number(bookingData.leadId),
        note_type: "common",
        params: {
          text: [
            "Source: Kommo",
            "Selected Altegio slot unavailable",
            `Datetime: ${bookingData.datetime || "Not specified"}`,
            `Staff ID: ${bookingData.staffId || "Not specified"}`
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

  if (!hasValue(recordId)) {
    console.log("ALTEGIO CANCEL SKIPPED - NO RECORD ID", {
      lead_id: leadId,
      reason
    });

    return {
      cancelled: false,
      skipped: true,
      reason: "No Altegio record ID"
    };
  }

  if (!companyId) {
    console.log("ALTEGIO CANCEL SKIPPED - MISSING COMPANY ID", {
      lead_id: leadId,
      record_id: recordId,
      reason
    });

    return {
      cancelled: false,
      skipped: true,
      reason: "No Altegio company ID"
    };
  }

  await cancelAltegioRecordFromKommo({
    leadId,
    recordId,
    companyId,
    reason
  });

  if (!isDeleteEvent) {
    try {
      await addKommoNoteForAltegioCancel(leadId, recordId, reason);
    } catch (error) {
      console.log("KOMMO CANCEL NOTE SKIPPED:", {
        lead_id: leadId,
        record_id: recordId,
        message: error.message
      });
    }
  }

  return {
    cancelled: true,
    recordId,
    companyId
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
    if (!hasValue(bookingData.recordId)) {
      console.log("ALTEGIO CANCEL SKIPPED - NO RECORD ID", {
        lead_id: bookingData.leadId,
        status_id: statusId
      });

      return {
        route,
        synced: false,
        skipped: true,
        reason: "No existing Altegio record ID"
      };
    }

    if (!bookingData.companyId) {
      console.log("ALTEGIO CANCEL SKIPPED - MISSING COMPANY ID", {
        lead_id: bookingData.leadId,
        record_id: bookingData.recordId,
        status_id: statusId
      });

      return {
        route,
        synced: false,
        skipped: true,
        reason: "No Altegio company ID"
      };
    }

    await cancelAltegioRecordFromKommo({
      leadId: bookingData.leadId,
      recordId: bookingData.recordId,
      companyId: bookingData.companyId,
      reason: `Kommo lead moved to cancelled status ${statusId}`
    });

    try {
      await addKommoNoteForAltegioCancel(
        bookingData.leadId,
        bookingData.recordId,
        `Kommo lead moved to cancelled status ${statusId}`
      );
    } catch (error) {
      console.log("KOMMO CANCEL NOTE SKIPPED:", {
        lead_id: bookingData.leadId,
        record_id: bookingData.recordId,
        message: error.message
      });
    }

    return {
      route,
      synced: true,
      recordId: bookingData.recordId
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
    console.log("KOMMO TO ALTEGIO UPDATE START", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId,
      datetime: bookingData.datetime,
      service: bookingData.serviceName,
      service_id: bookingData.serviceId,
      staff_id: bookingData.staffId,
      company_id: bookingData.companyId
    });
    console.log("EXISTING RECORD UPDATE START", {
      lead_id: bookingData.leadId,
      record_id: bookingData.recordId,
      company_id: bookingData.companyId,
      datetime: bookingData.datetime,
      service: bookingData.serviceName,
      service_id: bookingData.serviceId,
      staff_id: bookingData.staffId
    });
    await updateAltegioRecordFromKommo({ bookingData });
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
    console.log("KOMMO WEBHOOK:");
    console.log(JSON.stringify(req.body, null, 2));

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
      await markKommoLeadAsSourcedFromAltegio(lead, data);
    }

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


