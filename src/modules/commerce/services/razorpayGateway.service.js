const axios = require("axios");
const { HttpError } = require("@shared/utils/httpError");
function createRazorpayGateway({ request = (config) => axios.request(config) } = {}) {
  async function call(config) {
    try {
      const response = await request({ ...config, timeout: 15000, signal: AbortSignal.timeout(20000),
        maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, maxBodyLength: 32768,
        validateStatus: (status) => status >= 200 && status < 300 });
      return response.data;
    } catch (error) {
      // Axios errors include request credentials and response bodies. Never propagate them.
      const status = error?.response?.status;
      const authenticationRejected = status === 401 || status === 403 || (status === 400
        && /^Authentication failed\.?$/i.test(String(error?.response?.data?.error?.description || "").trim()));
      const failure = new HttpError(authenticationRejected ? 422 : 502,
        authenticationRejected ? "Razorpay credentials were rejected." : "Razorpay request failed. Retry or reconnect as indicated.");
      failure.authenticationRejected = authenticationRejected;
      throw failure;
    }
  }
  async function probe(authentication) {
    const config = authentication.authType === "api_keys"
      ? { auth: { username: authentication.keyId, password: authentication.keySecret } }
      : { headers: { Authorization: `Bearer ${authentication.accessToken}` } };
    const data = await call({ method: "GET", url: "https://api.razorpay.com/v1/payments", params: { count: 1 }, ...config });
    if (data?.entity !== "collection" || !Array.isArray(data.items) || data.count !== data.items.length || data.items.length > 1)
      throw new HttpError(502, "Razorpay credential verification returned an invalid response.");
    // Only verifies access: neither payment data nor an inferred merchant ID is returned.
  }
  function exchange(config, code, environment) {
    return call({ method: "POST", url: "https://auth.razorpay.com/token", data: {
      client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri,
      grant_type: "authorization_code", code, mode: environment } });
  }
  function refresh(config, refreshToken) {
    return call({ method: "POST", url: "https://auth.razorpay.com/token", data: {
      client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken } });
  }
  function resource(authentication, method, path, data, params) {
    const credentials = authentication.authType === "api_keys"
      ? { auth: { username: authentication.keyId, password: authentication.keySecret } }
      : { headers: { Authorization: `Bearer ${authentication.accessToken}` } };
    return call({ method, url: `https://api.razorpay.com/v1/${path}`, data, params, ...credentials });
  }
  function id(value, prefix) {
    if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,80}$`).test(value))
      throw new HttpError(502, "Invalid Razorpay resource identifier.");
    return value;
  }
  const createLink = (auth, data) => resource(auth, "POST", "payment_links", data);
  const fetchLink = (auth, value) => resource(auth, "GET", `payment_links/${id(value, "plink")}`);
  const cancelLink = (auth, value) => resource(auth, "POST", `payment_links/${id(value, "plink")}/cancel`, {});
  const findLink = (auth, reference) => {
    if (typeof reference !== "string" || !/^[a-zA-Z0-9_-]{1,35}$/.test(reference)) throw new HttpError(502, "Invalid checkout reference.");
    return resource(auth, "GET", "payment_links", undefined, { reference_id: reference });
  };
  const fetchPayment = (auth, value) => resource(auth, "GET", `payments/${id(value, "pay")}`);
  const findLinkForPayment = (auth, value) => resource(auth, "GET", "payment_links", undefined, { payment_id: id(value, "pay") });
  const fetchOrder = (auth, value) => resource(auth, "GET", `orders/${id(value, "order")}`);
  const fetchRefund = (auth, value) => resource(auth, "GET", `refunds/${id(value, "rfnd")}`);
  const fetchRefunds = (auth, value, skip = 0) => {
    if (!Number.isSafeInteger(skip) || skip < 0) throw new HttpError(502, "Invalid refund cursor.");
    return resource(auth, "GET", `payments/${id(value, "pay")}/refunds`, undefined, { count: 25, skip });
  };
  return { probe, exchange, refresh, createLink, fetchLink, cancelLink, findLink, findLinkForPayment, fetchPayment, fetchOrder, fetchRefund, fetchRefunds };
}
module.exports = { createRazorpayGateway, ...createRazorpayGateway() };
