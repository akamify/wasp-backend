const axios = require("axios");
const { HttpError } = require("@shared/utils/httpError");
function createMetaCommerceMessages({ request = (input) => axios.request(input) } = {}) {
  async function send({ accessToken, phoneNumberId, graphApiVersion, to, interactive }) {
    if (!/^v\d+\.\d+$/.test(graphApiVersion || "") || !/^\d{1,30}$/.test(phoneNumberId || "")) throw new HttpError(409, "WhatsApp connection version or phone is unavailable.");
    try {
      const result = await request({ method: "POST", url: `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
        headers: { Authorization: `Bearer ${accessToken}` }, data: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive },
        timeout: 20000, signal: AbortSignal.timeout(25000), maxRedirects: 0, maxContentLength: 1024 * 1024, maxBodyLength: 32768 });
      if (typeof result.data?.messages?.[0]?.id !== "string" || !result.data.messages[0].id.startsWith("wamid.") || result.data.messages[0].id.length > 512) throw new Error("missing message id");
      return result.data;
    } catch { throw new HttpError(502, "WhatsApp Commerce delivery could not be confirmed. Check the inbox before sending again."); }
  }
  return { send };
}
module.exports = { createMetaCommerceMessages, ...createMetaCommerceMessages() };
