const crypto = require("crypto");
const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const repository = require("../repositories/catalog.repository");
const { createCatalogClient } = require("./metaCatalog.service");
const { productPatch, productDto, catalogDto } = require("../domain/catalog");

function createCatalogService({ repo = repository, getCredentials = getCredentialsForUser, createClient = createCatalogClient } = {}) {
  async function context(workspaceId, requireCatalog = true, allowOldPhone = false) {
    const credentials = await getCredentials(workspaceId);
    const catalog = await repo.activeCatalog(workspaceId, credentials.wabaId);
    if (catalog && !allowOldPhone && catalog.phoneNumberId !== credentials.phoneNumberId) throw new HttpError(409, "Catalog belongs to another WhatsApp phone. Reconnect its original phone or disconnect this catalog.");
    if (requireCatalog && !catalog) throw new HttpError(409, "Connect a catalog for the active WhatsApp account.");
    return { credentials, catalog };
  }
  async function listCatalogs(workspaceId, cursor) {
    const credentials = await getCredentials(workspaceId);
    return createClient(credentials).linkedCatalogs(cursor);
  }
  async function getCatalog(workspaceId) {
    const { catalog, credentials } = await context(workspaceId, false, true);
    return catalog ? { ...catalogDto(catalog), activePhoneMatches: catalog.phoneNumberId === credentials.phoneNumberId } : null;
  }
  async function bindCatalog(workspaceId, input) {
    const { credentials, catalog } = await context(workspaceId, false);
    const client = createClient(credentials);
    if (catalog) {
      if (catalog.catalogId !== input.catalogId) throw new HttpError(409, "Disconnect the current catalog before connecting another.");
      await client.verifyBinding(catalog.catalogId);
      return catalogDto(catalog);
    }
    const scope = { catalogId: input.catalogId, wabaId: credentials.wabaId, phoneNumberId: credentials.phoneNumberId };
    const historical = await repo.historicalCatalog(workspaceId, scope);
    const business = await client.ownerBusiness();
    const catalogTargets = Array.isArray(credentials.catalogTargetIds) ? credentials.catalogTargetIds : [];
    if (catalogTargets.length && !catalogTargets.includes(input.catalogId)) {
      throw new HttpError(403, "Meta access is not authorized for this catalog. Authorize catalog access again and select this exact catalog.", {
        catalogId: input.catalogId,
      });
    }
    // An asset-scoped Facebook Login token is authoritative for explicitly selected catalogs.
    // Broad tokens still require the Business-owned catalog edge ownership check.
    if (!catalogTargets.length) await client.verifyOwner(input.catalogId, business.id);
    if (!historical) await client.verifyEmptyCatalog(input.catalogId);
    // The explicit ownership confirmation authorizes AIWizChat to create the missing
    // WABA association. linkCatalog is idempotent and refuses to replace another binding.
    await client.linkCatalog(input.catalogId);
    const inspected = await client.inspectCatalog(input.catalogId, business.id);
    const fields = { businessId: inspected.businessId, graphApiVersion: client.version,
      status: "connected", catalogVisible: inspected.catalogVisible, cartEnabled: inspected.cartEnabled,
      lastCheckedAt: new Date(), lastError: "" };
    // Recheck the current account after external I/O; never migrate historical records.
    const current = await getCredentials(workspaceId);
    if (current.wabaId !== credentials.wabaId || current.phoneNumberId !== credentials.phoneNumberId) throw new HttpError(409, "WhatsApp connection changed. Reload and retry.");
    const result = historical
      ? await repo.reactivateCatalog(workspaceId, historical._id, historical.revision, fields)
      : await repo.createCatalog({ workspaceId, ...scope, ...fields });
    if (!result) throw new HttpError(409, "Catalog connection changed. Reload and retry.");
    return catalogDto(result);
  }
  async function changeCatalog(workspaceId, input, action) {
    const { credentials, catalog } = await context(workspaceId, true, action === "disconnect");
    if (catalog.revision !== input.revision) throw new HttpError(409, "Catalog changed. Reload and retry.");
    const owner = crypto.randomUUID();
    const locked = await repo.claimCatalog(workspaceId, catalog._id, owner, new Date());
    if (!locked || locked.revision !== input.revision) {
      if (locked) await repo.releaseCatalog(workspaceId, catalog._id, owner);
      throw new HttpError(409, "Catalog is busy or changed. Retry shortly.");
    }
    try {
      let patch;
      if (action === "disconnect") patch = { active: false, status: "disconnected" };
      else {
        const client = createClient({ ...credentials, graphApiVersion: catalog.graphApiVersion });
        await client.verifyBinding(catalog.catalogId);
        const settings = action === "settings" ? await client.updateSettings(input) : await client.readSettings();
        patch = { ...settings, lastCheckedAt: new Date(), lastError: "", status: "connected" };
      }
      const saved = await repo.updateCatalog(workspaceId, catalog._id, owner, locked.revision, patch);
      if (!saved) throw new HttpError(409, "Catalog changed. Refresh its settings before retrying.");
      return catalogDto(saved);
    } finally { await repo.releaseCatalog(workspaceId, catalog._id, owner); }
  }
  async function listProducts(workspaceId, query) {
    const { catalog } = await context(workspaceId);
    const rows = await repo.listProducts(workspaceId, catalog._id, query);
    return { products: rows.slice(0, query.limit).map(productDto),
      nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]._id) : null };
  }
  async function getProduct(workspaceId, id) {
    const { catalog } = await context(workspaceId);
    const product = await repo.findProduct(workspaceId, catalog._id, id);
    if (!product) throw new HttpError(404, "Product not found.");
    return { catalog, product };
  }
  async function createProduct(workspaceId, input) {
    const { catalog } = await context(workspaceId);
    const patch = productPatch(input);
    const product = await repo.createProduct({ workspaceId, catalogConnectionId: catalog._id, ...patch });
    return productDto(product);
  }
  async function editProduct(workspaceId, id, input, archive = false) {
    const { product } = await getProduct(workspaceId, id);
    if (product.inventoryOutletId && ((input.stockOnHand !== undefined && input.stockOnHand !== product.stockOnHand) || input.trackInventory === false))
      throw new HttpError(409, "Manage this product's stock in branch inventory.");
    if (product.revision !== input.revision) throw new HttpError(409, "Product changed. Reload before saving.");
    if (product.archivedAt) {
      if (archive) return productDto(product);
      throw new HttpError(409, "Archived products cannot be edited.");
    }
    const patch = archive ? { archivedAt: new Date(), available: false } : productPatch(input, product);
    const unresolved = product.syncSubmittedRevision > product.syncedRevision;
    const saved = await repo.updateProduct(workspaceId, product, {
      ...patch, syncStatus: unresolved ? "accepted" : "pending", syncError: "",
      syncAttempts: 0, syncNextAttemptAt: new Date(),
    });
    if (!saved) throw new HttpError(409, "Product or reserved stock changed. Reload before saving.");
    return productDto(saved);
  }
  async function retryProduct(workspaceId, id, input) {
    const { product } = await getProduct(workspaceId, id);
    if (product.revision !== input.revision) throw new HttpError(409, "Product changed. Reload and retry.");
    const saved = await repo.retryProduct(workspaceId, product, {
      syncStatus: product.syncSubmittedRevision > product.syncedRevision ? "accepted" : "pending",
      syncAttempts: 0, syncError: "", syncNextAttemptAt: new Date(),
    });
    if (!saved) throw new HttpError(409, "Product is syncing or changed. Retry shortly.");
    return productDto(saved);
  }
  return { listCatalogs, getCatalog, bindCatalog, changeCatalog, listProducts, getProduct, createProduct, editProduct, retryProduct };
}
module.exports = { createCatalogService, ...createCatalogService() };
