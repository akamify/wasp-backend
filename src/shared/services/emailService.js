const axios = require("axios");
const { appBrandName } = require("@core/config/env");

const brevoApiKey = process.env.BREVO_API_KEY || "";
const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL || "";
const brevoSenderName = process.env.BREVO_SENDER_NAME || appBrandName || "DigitalWhasp";

async function sendEmail({ toEmail, toName, subject, htmlContent, textContent }) {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (!brevoApiKey || !brevoSenderEmail) {
    if (!isProd) {
      // eslint-disable-next-line no-console
      console.warn("Email skipped (Brevo not configured).", {
        toEmail: String(toEmail || "").trim(),
        subject: String(subject || ""),
      });
    }
    return {
      sent: false,
      skipped: true,
      reason: "BREVO_API_KEY or BREVO_SENDER_EMAIL is not configured",
    };
  }

  try {
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
  } catch (err) {
    const providerMessage =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err?.message ||
      "Brevo request failed";

    if (!isProd) {
      // eslint-disable-next-line no-console
      console.error("Email send failed (Brevo).", {
        toEmail: String(toEmail || "").trim(),
        subject: String(subject || ""),
        providerMessage,
      });
    }

    return {
      sent: false,
      skipped: false,
      failed: true,
      reason: "Brevo email send failed",
      providerMessage,
    };
  }
}

module.exports = { sendEmail };
