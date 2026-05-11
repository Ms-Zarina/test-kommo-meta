const express = require("express");
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

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Kommo → Meta backend is running"
  });
});

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

    const metaResult = await sendMetaEvent({
      eventName: "QualifiedLead",
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
    console.log("KOMMO WEBHOOK:");
    console.log(JSON.stringify(req.body, null, 2));

    res.json({
      ok: true
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

    if (String(lead.status_id) !== String(process.env.QUALIFIED_STATUS_ID)) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "Lead status is not target status",
        lead_id: lead.id,
        status_id: lead.status_id
      });
    }

    const metaResult = await sendMetaEvent({
      eventName: "QualifiedLead",
      email: "test@example.com",
      phone: "420777777777",
      leadId: lead.id
    });

    res.json({
      ok: true,
      sent_to_meta: true,
      lead_id: lead.id,
      status_id: lead.status_id,
      meta: metaResult
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

const metaResult = await sendMetaEvent({
  eventName: "QualifiedLead",
  email: "test@example.com",
  phone: "420777777777",
  leadId: lead.id
});

console.log("META RESULT:", metaResult);

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});


