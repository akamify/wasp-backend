const { HttpError } = require("@shared/utils/httpError");
const { createMetaClient, authHeaders, getMetaGraphVersion } = require("@modules/meta/services/metaGraph.service");
const { configurationName } = require("../domain/nativePayments");
const id = (value) => { if (!/^\d{1,30}$/.test(value || "")) throw new HttpError(409, "Invalid native WhatsApp asset."); return value; };
function createNativeClient(credentials, { client } = {}) {
  const version = getMetaGraphVersion(credentials.graphApiVersion);
  if (!/^v\d+\.\d+$/.test(version) || !credentials.accessToken) throw new HttpError(409, "WhatsApp authorization is unavailable.");
  const http = client || createMetaClient({ graphApiVersion: version, timeout: 15000 });
  async function get(path) {
    try { return (await http.get(path, { headers: authHeaders(credentials.accessToken), signal: AbortSignal.timeout(20000),
      maxRedirects: 0, maxContentLength: 2 * 1024 * 1024 })).data; }
    catch { throw new HttpError(503, "Native payment verification is unavailable. Check the original WhatsApp and merchant connection."); }
  }
  return {
    configuration: (name) => get(`/${id(credentials.wabaId)}/payment_configuration/${encodeURIComponent(configurationName(name))}`),
    lookup: (name, reference) => {
      if (!/^[A-Za-z0-9_.-]{1,35}$/.test(reference || "")) throw new HttpError(409, "Invalid native payment reference.");
      return get(`/${id(credentials.phoneNumberId)}/payments/${encodeURIComponent(configurationName(name))}/${encodeURIComponent(reference)}`);
    },
  };
}
module.exports = { createNativeClient };
