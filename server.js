
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

app.use(express.urlencoded({ extended: true }));

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "").trim().toLowerCase())
    .digest("hex");
}

async function sendMetaEvent({ eventName, email, phone, leadId }) {
  const url = `https://graph.facebook.com/v20.0/${process.env.META_PIXEL_ID}/events`;

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: "system_generated",
        user_data: {
          em: email ? [sha256(email)] : [],
          ph: phone ? [sha256(phone)] : []
        },
        custom_data: {
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


async function getLeadWithContacts(leadId) {
  const response = await axios.get(
    `https://${process.env.KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/${leadId}?with=contacts`,
    {
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

  for (const field of fields) {
    if (field.field_code === "EMAIL") {
      email = field.values?.[0]?.value || null;
    }

    if (field.field_code === "PHONE") {
      phone = field.values?.[0]?.value || null;
    }
  }

  return { email, phone };
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

   // TEMP TEST: status filter disabled
    console.log("Incoming lead:", {
      lead_id,
      status_id,
      email,
      phone
    });


    //"status_id": "78215435" успешно реализован
    // "status_id": "142" thinking

    //"status_id": "78215435",
    //"status_id": "78215439",
    const metaResult = await sendMetaEvent({
      eventName, 
      email,
      phone,
      leadId: lead_id
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
  //   console.log("KOMMO ENV CHECK:", {
  //   subdomain: process.env.KOMMO_SUBDOMAIN,
  //   tokenExists: !!process.env.KOMMO_ACCESS_TOKEN,
  //   tokenStart: process.env.KOMMO_ACCESS_TOKEN?.slice(0, 10),
  //   tokenLength: process.env.KOMMO_ACCESS_TOKEN?.length
  // });
    console.log("KOMMO WEBHOOK:");
    console.log(JSON.stringify(req.body, null, 2));

    const STATUS_EVENT_MAP = {
      "ДУМАЕТ_ID": "Lead",
      "ЗАПИСАН_ID": "QualifiedLead",
      "УСПЕШНО_РЕАЛИЗОВАН_ID": "Purchase"
    };

    const lead = req.body?.leads?.status?.[0] || req.body?.leads?.update?.[0];

    if (!lead) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "No lead data in webhook"
      });
    }

    const eventName = STATUS_EVENT_MAP[String(lead.status_id)];

      if (!eventName) {
        return res.json({
          ok: true,
          skipped: true,
          reason: "Status not tracked",
          status_id: lead.status_id
        });
      } {
      return res.json({
        ok: true,
        skipped: true,
        reason: "Lead status is not target status",
        lead_id: lead.id,
        status_id: lead.status_id
      });
    }

    // if (String(lead.status_id) !== String(process.env.SUCCESSFULLY_STATUS_ID)) {
    //   return res.json({
    //     ok: true,
    //     skipped: true,
    //     reason: "Lead status is not target status",
    //     lead_id: lead.id,
    //     status_id: lead.status_id
    //   });
    // }

    // if (String(lead.status_id) !== String(process.env.THINKING_STATUS_ID)) {
    //   return res.json({
    //     ok: true,
    //     skipped: true,
    //     reason: "Lead status is not target status",
    //     lead_id: lead.id,
    //     status_id: lead.status_id
    //   });
    // }


    const eventKey = `${lead.id}_${lead.status_id}`;

    if (sentEvents.has(eventKey)) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "Duplicate event skipped",
        eventKey
      });
    }

    sentEvents.add(eventKey);

    const leadData = await getLeadWithContacts(lead.id);

// console.log("LEAD DATA:");
console.log(JSON.stringify(leadData, null, 2));

const contactId = leadData?._embedded?.contacts?.[0]?.id;

if (!contactId) {
  return res.json({
    ok: true,
    skipped: true,
    reason: "No contact linked to lead",
    lead_id: lead.id
  });
}

const contactData = await getContactById(contactId);

// console.log("CONTACT DATA:");
console.log(JSON.stringify(contactData, null, 2));

const { email, phone } = extractEmailAndPhone(contactData);

if (!email && !phone) {
  return res.json({
    ok: true,
    skipped: true,
    reason: "No email or phone in contact",
    lead_id: lead.id,
    contact_id: contactId
  });
}

const metaResult = await sendMetaEvent({
  eventName,
  email,
  phone,
  leadId: lead.id
});

    console.log("META RESULT:");
    console.log(JSON.stringify(metaResult, null, 2));

    return res.json({
      ok: true,
      sent_to_meta: true,
      lead_id: lead.id,
      status_id: lead.status_id,
      meta: metaResult
    });
  } catch (error) {
    console.error("KOMMO ERROR:", error.message);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});




app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});


