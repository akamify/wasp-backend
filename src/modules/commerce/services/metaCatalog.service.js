const { HttpError } = require("@shared/utils/httpError");
const { createMetaClient, authHeaders, getMetaGraphVersion } = require("@modules/meta/services/metaGraph.service");
const { MAX_BATCH, remoteProductData } = require("../domain/catalog");

const REMOTE_FIELDS = "id,retailer_id,custom_label_3,custom_label_4,review_status,visibility";
function graphId(value) {
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new HttpError(400, "Invalid Meta asset identifier.");
  return value;
}
function providerError(error, ambiguous = false, context = {}) {
  if (error instanceof HttpError) return error;
  const code = Number(error?.response?.data?.error?.code || error?.error?.code || 0);
  const status = Number(error?.response?.status || error?.status || 0);
  const retryable = !status || status === 429 || status >= 500 || [1, 2, 4, 17, 32, 613].includes(code);
  let statusCode = retryable ? 503 : 422;
  let message = code === 190 ? "WhatsApp authorization expired. Reconnect WhatsApp."
    : retryable ? "Meta is temporarily unavailable. Catalog sync will retry."
    : "Meta rejected the catalog operation. Check asset permissions and product requirements.";
  if (code !== 190 && !retryable && context.operation === "read_catalog_products") {
    statusCode = 403;
    message = "Meta can load the selected catalog but cannot read its products. Confirm catalog management access and the catalog's Meta product type.";
  } else if (code !== 190 && !retryable && context.operation === "read_catalog_object") {
    statusCode = 403;
    message = "Meta cannot load this catalog object with the current authorization. Confirm the Catalog ID and authorize this exact catalog.";
  } else if (code !== 190 && !retryable && context.operation === "link_catalog") {
    statusCode = 409;
    message = "Meta could not link this catalog to the active WhatsApp account. Confirm that both assets belong to the same Business Portfolio and the connected Meta user has full control of both.";
  }
  const remote = error?.response?.data?.error || error?.error || {};
  const details = { providerCode: code || undefined };
  if (Number.isSafeInteger(remote.error_subcode)) details.providerSubcode = remote.error_subcode;
  if (typeof remote.fbtrace_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(remote.fbtrace_id)) details.providerTraceId = remote.fbtrace_id;
  if (context.operation) details.operation = context.operation;
  if (typeof context.graphApiVersion === "string" && /^v\d+\.\d+$/.test(context.graphApiVersion)) {
    details.graphApiVersion = context.graphApiVersion;
  }
  // Never echo the raw provider response, headers or arbitrary message text.
  // Classify recognized diagnostics into fixed, non-sensitive explanations.
  const reason = String(remote.message || "");
  const fields = ["name", "vertical", "catalog_id", "owner_business_info", "business", "fields", "access_token"];
  const field = fields.find((value) => new RegExp(`\\b${value}\\b`, "i").test(reason));
  if (/nonexisting field|non-existing field|unknown field/i.test(reason)) details.providerReason = "unsupported_field";
  else if (/unsupported (get|post|delete) request|does not exist|cannot be loaded/i.test(reason)) details.providerReason = "object_unavailable_or_operation_unsupported";
  else if (/permission|not authorized|access denied/i.test(reason)) details.providerReason = "permission_denied";
  else if (/required|missing/i.test(reason)) details.providerReason = "missing_parameter";
  else if (/invalid parameter|must be|invalid value/i.test(reason) || code === 100) details.providerReason = "invalid_parameter";
  if (field) details.providerField = field;
  const safe = new HttpError(statusCode, message, details);
  safe.retryable = retryable;
  safe.ambiguous = ambiguous && (!status || status >= 500);
  const retryAfter = Number(error?.response?.headers?.["retry-after"] || 0);
  safe.retryAfterMs = Number.isFinite(retryAfter) ? Math.max(0, Math.min(retryAfter * 1000, 3600000)) : 0;
  return safe;
}
function createCatalogClient(credentials, { client, signal = AbortSignal.timeout(90000) } = {}) {
  const version = getMetaGraphVersion(credentials.graphApiVersion);
  if (!/^v\d+\.\d+$/.test(version)) throw new HttpError(409, "WhatsApp Graph API version is invalid.");
  if (!credentials.accessToken) throw new HttpError(409, "WhatsApp authorization is missing.");
  const http = client || createMetaClient({ graphApiVersion: version, timeout: 15000 });
  const options = { headers: authHeaders(credentials.accessToken), signal, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024 };
  function operation(path, method, params) {
    if (path.endsWith("/owned_product_catalogs")) return method === "POST" ? "create_catalog" : "read_owned_catalogs";
    if (path.endsWith("/product_catalogs")) return method === "POST" ? "link_catalog" : "read_linked_catalogs";
    if (params?.fields === "id,owner_business_info") return "read_business_owner";
    if (/^\/\d{1,30}$/.test(path) && method === "GET") return "read_catalog_object";
    if (path.endsWith("/whatsapp_commerce_settings")) return "commerce_settings";
    if (path.endsWith("/products")) return "read_catalog_products";
    return "catalog_details_or_products";
  }
  async function get(path, params = {}) {
    try { return (await http.get(path, { ...options, params })).data; }
    catch (error) { throw providerError(error, false, { operation: operation(path, "GET", params), graphApiVersion: version }); }
  }
  async function post(path, body, params) {
    try { return (await http.post(path, body, { ...options, params })).data; }
    catch (error) { throw providerError(error, true, { operation: operation(path, "POST", params), graphApiVersion: version }); }
  }
  async function linkedCatalogs(after) {
    const data = await get(`/${graphId(credentials.wabaId)}/product_catalogs`,
      { fields: "id,name", limit: 50, ...(after ? { after } : {}) });
    if (!Array.isArray(data?.data)) throw new HttpError(502, "Meta returned an invalid catalog list.");
    return { catalogs: data.data.map((item) => ({ id: graphId(item.id), name: String(item.name || "").slice(0, 150) })),
      cursor: data.paging?.next ? data.paging?.cursors?.after || null : null };
  }
  async function ownerBusiness() {
    const data = await get(`/${graphId(credentials.wabaId)}`, { fields: "id,owner_business_info" });
    const id = data?.owner_business_info?.id;
    if (data?.id !== credentials.wabaId || typeof id !== "string" || !/^\d{1,30}$/.test(id)) {
      throw new HttpError(409, "Cannot verify the WhatsApp business owner. Reconnect with business and catalog management access.");
    }
    return { id, name: String(data.owner_business_info.name || "").slice(0, 150) };
  }
  async function createOwnedCatalog(businessId, name) {
    const result = await post(`/${graphId(businessId)}/owned_product_catalogs`, new URLSearchParams({ name, vertical: "commerce" }));
    if (typeof result?.id !== "string" || !/^\d{1,30}$/.test(result.id)) {
      const error = new HttpError(502, "Meta did not return a catalog ID. Check Commerce Manager before retrying.");
      error.ambiguous = true;
      throw error;
    }
    return result.id;
  }
  async function verifyOwner(catalogId, businessId) {
    const expectedCatalogId = graphId(catalogId);
    const ownerId = graphId(businessId);
    let after;
    for (let page = 0; page < 10; page++) {
      const result = await get(`/${ownerId}/owned_product_catalogs`,
        { fields: "id,vertical", limit: 50, ...(after ? { after } : {}) });
      if (!Array.isArray(result?.data)) throw new HttpError(502, "Meta returned an invalid owned catalog list.");
      const catalog = result.data.find((item) => String(item?.id || "") === expectedCatalogId);
      if (catalog) {
        if (catalog.vertical && catalog.vertical !== "commerce") {
          throw new HttpError(409, "The catalog must contain physical products.");
        }
        return;
      }
      const next = result.paging?.next ? String(result.paging?.cursors?.after || "") : "";
      if (!next || next === after) break;
      after = next;
    }
    throw new HttpError(409, "The catalog must belong to this WhatsApp business and be accessible to the connected Meta user.");
  }
  async function linkCatalog(catalogId) {
    // Never replace an existing remote binding, including bindings made outside AIWizChat.
    const linked = await linkedCatalogs();
    if (linked.cursor || linked.catalogs.some((item) => item.id !== catalogId)) {
      throw new HttpError(409, "WhatsApp already has another linked catalog. Manage that connection before continuing.");
    }
    if (!linked.catalogs.some((item) => item.id === catalogId)) {
      await post(`/${graphId(credentials.wabaId)}/product_catalogs`, new URLSearchParams({ catalog_id: graphId(catalogId) }));
    }
    await verifyBinding(catalogId);
  }
  async function verifyEmptyCatalog(catalogId) {
    const id = graphId(catalogId);
    let products;
    try {
      products = await get(`/${id}/products`, { fields: "id", limit: 1 });
    } catch (error) {
      if (error instanceof HttpError) {
        error.details = {
          ...(error.details || {}),
          diagnosticCode: "catalog_products_edge_unavailable",
          requestedCatalogId: id,
        };
      }
      throw error;
    }
    if (!Array.isArray(products?.data)) throw new HttpError(502, "Meta returned an invalid product list. Recovery was not saved.");
    if (products.data.length) throw new HttpError(409, "Recover a dedicated empty catalog. Existing products will not be imported or overwritten.");
  }
  async function verifyCatalogObject(catalogId) {
    const id = graphId(catalogId);
    let catalog;
    try {
      catalog = await get(`/${id}`, { fields: "id,name,vertical,product_count" });
    } catch (error) {
      if (error instanceof HttpError) {
        error.details = {
          ...(error.details || {}),
          diagnosticCode: "catalog_object_unavailable",
          requestedCatalogId: id,
        };
      }
      throw error;
    }
    if (String(catalog?.id || "") !== id) {
      throw new HttpError(502, "Meta returned an invalid catalog identity.", {
        diagnosticCode: "catalog_identity_mismatch",
        requestedCatalogId: id,
      });
    }
    const vertical = String(catalog?.vertical || "").trim().toLowerCase();
    if (vertical !== "commerce") {
      throw new HttpError(409, "AIWizChat product management requires a commerce catalog. Create or select a catalog whose Meta vertical is commerce.", {
        diagnosticCode: "unsupported_catalog_vertical",
        requestedCatalogId: id,
        catalogVertical: vertical || "unknown",
      });
    }
    return { id, vertical, name: String(catalog?.name || "").slice(0, 150) };
  }
  async function verifyBinding(catalogId) {
    graphId(catalogId);
    let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await linkedCatalogs(cursor);
      if (result.catalogs.some((catalog) => catalog.id === catalogId)) return;
      if (!result.cursor) break;
      if (result.cursor === cursor) break;
      cursor = result.cursor;
    }
    throw new HttpError(409, "Catalog is not linked to the active WhatsApp account. Link it in Commerce Manager first.");
  }
  async function inspectCatalog(catalogId, businessId) {
    const id = graphId(catalogId);
    await verifyBinding(id);
    const [products, settings] = await Promise.all([
      get(`/${graphId(catalogId)}/products`, { fields: "id", limit: 1, return_only_approved_products: false }),
      readSettings(),
    ]);
    if (!Array.isArray(products?.data)) throw new HttpError(502, "Meta returned an invalid catalog.");
    return { businessId: graphId(businessId), empty: products.data.length === 0, ...settings };
  }
  async function readSettings() {
    const result = await get(`/${graphId(credentials.phoneNumberId)}/whatsapp_commerce_settings`);
    const data = Array.isArray(result?.data) ? result.data[0] : result;
    if (typeof data?.is_catalog_visible !== "boolean" || typeof data?.is_cart_enabled !== "boolean") throw new HttpError(502, "Meta returned invalid commerce settings.");
    return { catalogVisible: data.is_catalog_visible, cartEnabled: data.is_cart_enabled };
  }
  async function updateSettings(settings) {
    const result = await post(`/${graphId(credentials.phoneNumberId)}/whatsapp_commerce_settings`, null, {
      is_catalog_visible: settings.catalogVisible, is_cart_enabled: settings.cartEnabled,
    });
    if (result?.success !== true) throw new HttpError(502, "Meta did not confirm the commerce settings update.");
    return readSettings();
  }
  async function batch(requests) {
    if (!requests.length || requests.length > MAX_BATCH) throw new RangeError("Invalid catalog batch size.");
    const raw = await post("/", new URLSearchParams({ batch: JSON.stringify(requests), include_headers: "false" }));
    if (!Array.isArray(raw) || raw.length !== requests.length) {
      const error = new HttpError(502, "Meta returned an incomplete batch response.");
      error.retryable = true; error.ambiguous = true;
      throw error;
    }
    return raw.map((entry) => {
      let body;
      try { body = JSON.parse(entry?.body || "null"); } catch { body = null; }
      if (!entry || !body) {
        const error = new HttpError(502, "Meta returned an unreadable batch result. Verify before retrying.");
        error.retryable = true; error.ambiguous = true;
        return { error };
      }
      if (!entry || !body || entry.code < 200 || entry.code >= 300 || body.error) {
        return { error: providerError({ status: entry?.code, error: body?.error }, true) };
      }
      return { data: body };
    });
  }
  async function lookupProducts(catalogId, products) {
    const requests = products.map((product) => ({
      method: "GET", relative_url: `${graphId(catalogId)}/products?${new URLSearchParams({
        fields: REMOTE_FIELDS, limit: "2", return_only_approved_products: "false",
        filter: JSON.stringify({ retailer_id: { eq: product.sku } }),
      })}`,
    }));
    const results = await batch(requests);
    return results.map((result, index) => {
      if (result.error) return result;
      const rows = result.data.data;
      if (!Array.isArray(rows) || rows.length > 1 || (rows.length === 1 && rows[0].retailer_id !== products[index].sku)) {
        return { error: new HttpError(409, "Catalog SKU lookup is ambiguous. No remote product was changed.") };
      }
      return { remote: rows[0] || null };
    });
  }
  async function writeProducts(catalogId, products) {
    return batch(products.map((product) => {
      const data = remoteProductData(product);
      if (product.metaProductId) delete data.retailer_id;
      else data.allow_upsert = false;
      return { method: "POST", relative_url: product.metaProductId ? graphId(product.metaProductId) : `${graphId(catalogId)}/products`,
        body: new URLSearchParams(Object.entries(data).map(([key, value]) => [key, String(value)])).toString() };
    }));
  }
  return { version, linkedCatalogs, verifyBinding, inspectCatalog, readSettings, updateSettings, lookupProducts, writeProducts,
    ownerBusiness, createOwnedCatalog, verifyOwner, verifyCatalogObject, verifyEmptyCatalog, linkCatalog };
}
module.exports = { createCatalogClient, providerError };
