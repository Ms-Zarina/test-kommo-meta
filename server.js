
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();

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

    if (sentEvents.has(eventKey)) {
      console.log("DUPLICATE EVENT SKIPPED:", eventKey);

      return res.json({
        ok: true,
        skipped: true,
        reason: "Duplicate event skipped",
        eventKey
      });
    }

    sentEvents.add(eventKey);

    console.log("START KOMMO ENRICHMENT:", { lead_id: lead.id });

    const enrichedLead = await getEnrichedKommoLead(lead.id);

    console.log("FINISH KOMMO ENRICHMENT:", { lead_id: lead.id });

    logEnrichedKommoLead(enrichedLead);
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

    const lead = await findKommoLeadByPhone(phone);

    if (!lead) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "No Kommo lead found by phone",
        phone
      });
    }

    let targetStatusId = null;

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


