const { parseRupees } = require("./money");
const { HttpError } = require("@shared/utils/httpError");

const MAX_BATCH = 20;
const LEASE_MS = 180000;
const MAX_SYNC_ATTEMPTS = 8;
function productPatch(input, current = {}) {
  const { price, revision, ...fields } = input;
  const patch = { ...fields, ...(price !== undefined ? { pricePaise: parseRupees(price) } : {}) };
  const next = { ...current, ...patch };
  if (patch.taxRateBps !== undefined && input.taxConfirmed !== true) throw new HttpError(400, "Confirm the inclusive tax configuration when changing tax.");
  if (!next.taxConfirmed) throw new HttpError(400, "Confirm the inclusive tax configuration.");
  if ((next.stockOnHand || 0) < (current.stockReserved || 0)) throw new HttpError(409, "Stock cannot be lower than reserved quantity.");
  if (!next.trackInventory && (current.stockReserved || 0) > 0) throw new HttpError(409, "Inventory tracking cannot be disabled while stock is reserved.");
  return patch;
}
function productDto(product) {
  const fields = ["sku", "name", "description", "brand", "condition", "category", "imageUrl", "productUrl",
    "pricePaise", "taxRateBps", "taxConfirmed", "available", "trackInventory", "stockOnHand",
    "stockReserved", "archivedAt", "revision", "syncedRevision", "syncStatus", "syncError",
    "metaProductId", "metaReviewStatus", "metaVisibility", "lastSyncedAt", "createdAt", "updatedAt"];
  return { id: String(product._id), catalogConnectionId: String(product.catalogConnectionId), currency: "INR",
    ...Object.fromEntries(fields.map((key) => [key, product[key]])) };
}
function catalogDto(catalog) {
  if (!catalog) return null;
  const fields = ["wabaId", "phoneNumberId", "catalogId", "businessId", "graphApiVersion", "active",
    "status", "catalogVisible", "cartEnabled", "lastCheckedAt", "lastError", "revision"];
  return { id: String(catalog._id), ...Object.fromEntries(fields.map((key) => [key, catalog[key]])) };
}
function remoteProductData(product) {
  const sellable = !product.archivedAt && product.available
    && (!product.trackInventory || product.stockOnHand > product.stockReserved);
  return {
    retailer_id: product.sku, name: product.name, description: product.description,
    image_url: product.imageUrl, url: product.productUrl, price: product.pricePaise,
    currency: "INR", condition: product.condition,
    availability: sellable ? "in stock" : "out of stock",
    visibility: product.archivedAt ? "staging" : "published",
    brand: product.brand || "",
    custom_label_4: `aiwizchat:${product._id}`,
    custom_label_3: String(product.revision),
  };
}
function ownsRemote(product, remote) {
  return remote?.retailer_id === product.sku && remote?.custom_label_4 === `aiwizchat:${product._id}`;
}
function retryAt(attempt, now = new Date(), retryAfterMs = 0) {
  const delay = Math.max(Math.min(30000 * 2 ** Math.min(attempt, 6), 3600000), Math.min(retryAfterMs, 3600000));
  return new Date(now.getTime() + delay);
}
module.exports = { MAX_BATCH, LEASE_MS, MAX_SYNC_ATTEMPTS, productPatch, productDto, catalogDto, remoteProductData, ownsRemote, retryAt };
