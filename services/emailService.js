const axios = require("axios");
const { appBrandName } = require("../config/env");

const brevoApiKey = process.env.BREVO_API_KEY || "";
const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL || "";
const brevoSenderName = process.env.BREVO_SENDER_NAME || appBrandName || "Waspakamify";

async function sendEmail({ toEmail, toName, subject, htmlContent, textContent }) {
  if (!brevoApiKey || !brevoSenderEmail) {
    return {
      sent: false,
      skipped: true,
      reason: "BREVO_API_KEY or BREVO_SENDER_EMAIL is not configured",
    };
  }

  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: { email: brevoSenderEmail, name: brevoSenderName },
      to: [{ email: String(toEmail).trim(), name: toName || "" }],
      subject,
      htmlContent,
      textContent: textContent || "",
    },
    {
      headers: {
        "Content-Type": "application/json",
        "api-key": brevoApiKey,
      },
      timeout: 20000,
    }
  );

  return { sent: true, skipped: false };
}

module.exports = { sendEmail };
