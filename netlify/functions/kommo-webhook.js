const crypto = require("crypto");

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "").trim().toLowerCase())
    .digest("hex");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          message: "Function works. Use POST to send lead data."
        })
      };
    }

    const body = JSON.parse(event.body || "{}");

    if (String(body.status_id) !== String(process.env.QUALIFIED_STATUS_ID)) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          skipped: true,
          reason: "Lead status is not qualified"
        })
      };
    }

    const payload = {
      data: [
        {
          event_name: "QualifiedLead",
          event_time: Math.floor(Date.now() / 1000),
          action_source: "system_generated",
          user_data: {
            em: body.email ? [sha256(body.email)] : [],
            ph: body.phone ? [sha256(body.phone)] : []
          },
          custom_data: {
            lead_id: body.lead_id || "test_lead",
            source: "netlify_function"
          }
        }
      ],
      access_token: process.env.META_ACCESS_TOKEN
    };

    const response = await fetch(
      `https://graph.facebook.com/v20.0/${process.env.META_PIXEL_ID}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );

    const result = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        sent_to_meta: true,
        meta: result
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: error.message
      })
    };
  }
};