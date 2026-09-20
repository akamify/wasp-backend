const crypto = require("crypto");
const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const repository = require("../repositories/catalog.repository");
const { createCatalogClient } = require("./metaCatalog.service");
const { catalogEnabled, assertCatalogReady } = require("./catalogReadiness.service");
const { MAX_SYNC_ATTEMPTS, ownsRemote, retryAt } = require("../domain/catalog");

function createCatalogSync({ repo = repository, getCredentials = getCredentialsForUser, createClient = createCatalogClient,
  enabled = catalogEnabled, ready = assertCatalogReady, now = () => new Date() } = {}) {
  async function update(workspaceId, product, owner, build) {
    // A concurrent edit causes the conditional update to miss. The next sweep
    // reconciles its newer snapshot, without a document read for every item.
    return repo.syncProduct(workspaceId, product, owner, build(product));
  }
  async function failure(workspaceId, product, owner, error, { definite = false } = {}) {
    return update(workspaceId, product, owner, (current) => {
      const attempts = current.syncAttempts + 1;
      const unresolved = !definite && current.syncSubmittedRevision > current.syncedRevision;
      const terminal = attempts >= MAX_SYNC_ATTEMPTS || error.retryable === false || (!error.retryable && !unresolved);
      return { syncStatus: terminal ? "error" : unresolved ? "accepted" : "pending",
        syncAttempts: attempts, syncNextAttemptAt: retryAt(attempts, now(), error.retryAfterMs),
        syncError: error instanceof HttpError ? error.message.slice(0, 300) : "Catalog sync failed. Retry after checking the connection.",
        ...(definite ? { syncSubmittedRevision: 0 } : {}) };
    });
  }
  async function processCatalog(catalog, owner) {
    const workspaceId = String(catalog.workspaceId);
    const products = await repo.claimProducts(workspaceId, catalog._id, owner, now());
    if (!products.length) return { processed: 0 };
    try {
      const credentials = await getCredentials(workspaceId);
      if (credentials.wabaId !== catalog.wabaId || credentials.phoneNumberId !== catalog.phoneNumberId) {
        throw new HttpError(409, "Sync paused: reconnect the catalog's original WhatsApp account.");
      }
      const client = createClient({ ...credentials, graphApiVersion: catalog.graphApiVersion });
      await client.verifyBinding(catalog.catalogId);
      const lookups = await client.lookupProducts(catalog.catalogId, products);
      const writes = [];
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        const result = lookups[i];
        if (result?.error) {
          await failure(workspaceId, product, owner, result.error);
          continue;
        }
        const remote = result?.remote;
        if (remote && !ownsRemote(product, remote)) {
          await failure(workspaceId, product, owner, new HttpError(409, "This SKU belongs to an unmanaged Meta product. It was not overwritten."));
          continue;
        }
        if (product.metaProductId && remote?.id !== product.metaProductId) {
          await failure(workspaceId, product, owner, new HttpError(409, "Managed Meta product is missing or replaced. No product was recreated."));
          continue;
        }
        if (product.syncSubmittedRevision > product.syncedRevision
            || (product.syncStatus === "accepted" && product.syncSubmittedRevision > 0)) {
          if (!remote || remote.custom_label_3 !== String(product.syncSubmittedRevision)) {
            const unknown = new HttpError(503, "Previous Meta write is not yet verified. Only status checks will retry.");
            unknown.retryable = true;
            await failure(workspaceId, product, owner, unknown);
            continue;
          }
          await update(workspaceId, product, owner, (current) => {
            const newer = current.revision > product.syncSubmittedRevision;
            const review = ["approved", "pending", "rejected", "outdated"].includes(remote.review_status) ? remote.review_status : "unknown";
            const awaitingReview = !["approved", "rejected"].includes(review);
            const exhausted = awaitingReview && current.syncAttempts + 1 >= MAX_SYNC_ATTEMPTS;
            return { metaProductId: remote.id, syncedRevision: product.syncSubmittedRevision,
              syncStatus: newer ? "pending" : review === "rejected" || exhausted ? "error" : awaitingReview ? "accepted" : "synced",
              metaReviewStatus: review, metaVisibility: String(remote.visibility || ""),
              syncError: review === "rejected" ? "Meta rejected this product. Review it in Commerce Manager." : exhausted ? "Meta review is still pending. Check Commerce Manager and retry status sync." : "",
              syncAttempts: newer || !awaitingReview ? 0 : current.syncAttempts + 1,
              syncNextAttemptAt: newer ? now() : retryAt(current.syncAttempts + 1, now()), lastSyncedAt: now() };
          });
          continue;
        }
        // CREATE never upserts another product. Existing managed records are
        // recovered by retailer ID; unowned records are rejected above.
        const prepared = await repo.syncProduct(workspaceId, product, owner, {
          syncSubmittedRevision: product.revision, syncStatus: "accepted",
          ...(remote ? { metaProductId: remote.id } : {}), syncError: "",
          syncNextAttemptAt: new Date(now().getTime() + 30000),
        });
        if (prepared) writes.push(prepared);
      }
      if (writes.length) {
        if (!await repo.holdsCatalog(workspaceId, catalog._id, owner, now())) return { processed: products.length };
        // Persisted submission state precedes external I/O. After a timeout or
        // crash, future runs only inspect this revision before sending another.
        let responses;
        try { responses = await client.writeProducts(catalog.catalogId, writes); }
        catch (error) {
          for (const product of writes) await failure(workspaceId, product, owner, error, { definite: !error.ambiguous && Boolean(error.statusCode) && error.statusCode < 500 });
          return { processed: products.length };
        }
        for (let i = 0; i < writes.length; i++) {
          const product = writes[i];
          const response = responses[i];
          if (response?.error) {
            await failure(workspaceId, product, owner, response.error, { definite: !response.error.ambiguous });
          } else {
            // IDs are hints only; a later scoped read verifies ownership and revision.
            await update(workspaceId, product, owner, () => ({
              syncStatus: "accepted", syncNextAttemptAt: new Date(now().getTime() + 30000),
            }));
          }
        }
      }
      return { processed: products.length };
    } catch (error) {
      for (const product of products) await failure(workspaceId, product, owner, error);
      return { processed: products.length, deferred: true };
    } finally { await repo.releaseProducts(workspaceId, catalog._id, owner); }
  }
  async function run() {
    if (!enabled()) return { skipped: true };
    await ready();
    const candidates = await repo.findCandidates(now());
    const seen = new Set();
    for (const candidate of candidates) {
      const key = String(candidate.catalogConnectionId);
      if (seen.has(key)) continue;
      seen.add(key);
      const workspaceId = String(candidate.workspaceId);
      const owner = crypto.randomUUID();
      const catalog = await repo.claimCatalog(workspaceId, candidate.catalogConnectionId, owner, now());
      if (!catalog) {
        if (!await repo.catalogExists(workspaceId, candidate.catalogConnectionId)) await repo.deferCatalog(workspaceId, candidate.catalogConnectionId, now());
        continue;
      }
      try { return await processCatalog(catalog, owner); }
      finally { await repo.releaseCatalog(workspaceId, catalog._id, owner); }
    }
    return { processed: 0 };
  }
  return { run };
}
module.exports = { createCatalogSync, runCatalogSync: (...args) => createCatalogSync().run(...args) };
