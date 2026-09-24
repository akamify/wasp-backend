const crypto = require("crypto");
const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { createCatalogClient } = require("./metaCatalog.service");
const catalogs = require("./catalog.service");
const repository = require("../repositories/catalogSetup.repository");

function catalogCapabilities(credentials) {
  const scopes = new Set(Array.isArray(credentials?.grantedScopes) ? credentials.grantedScopes : []);
  const catalogTargets = new Set(Array.isArray(credentials?.catalogTargetIds) ? credentials.catalogTargetIds : []);
  return {
    connectExistingCatalog: scopes.has("catalog_management") && catalogTargets.size > 0,
    createCatalog: scopes.has("catalog_management") && scopes.has("business_management"),
  };
}

function requireCatalogCreationPermission(credentials) {
  const capabilities = catalogCapabilities(credentials);
  if (!capabilities.createCatalog) {
    const scopes = new Set(Array.isArray(credentials?.grantedScopes) ? credentials.grantedScopes : []);
    const missingScopes = ["catalog_management", "business_management"].filter((scope) => !scopes.has(scope));
    throw new HttpError(403,
      "Creating a Meta catalog in AIWizChat requires catalog and business management permissions.", {
        missingScopes,
        alternative: "Create an empty catalog in Meta Commerce Manager, link it to this WhatsApp account, then use Find linked catalogs.",
      });
  }
}

function createSetupService({ repo = repository, getCredentials = getCredentialsForUser,
  createClient = createCatalogClient, catalogService = catalogs } = {}) {
  async function status(workspaceId) {
    const credentials = await getCredentials(workspaceId);
    const setup = await repo.read(workspaceId, credentials.wabaId);
    return {
      setup: setup ? { name: setup.name, catalogId: setup.catalogId, state: setup.state,
        activePhoneMatches: setup.phoneNumberId === credentials.phoneNumberId } : null,
      capabilities: catalogCapabilities(credentials),
    };
  }
  async function create(workspaceId, input) {
    const credentials = await getCredentials(workspaceId);
    const client = createClient(credentials);
    const existing = await catalogService.getCatalog(workspaceId);
    let setup = await repo.read(workspaceId, credentials.wabaId);
    if (existing) {
      // A lost response or audit failure must not turn a completed setup into an error.
      if (setup?.catalogId === existing.catalogId && setup.phoneNumberId === credentials.phoneNumberId
          && existing.activePhoneMatches !== false) return existing;
      throw new HttpError(409, "A catalog is already connected. Open its settings to manage it.");
    }
    if (!setup || (!setup.catalogId && setup.state === "ready")) {
      requireCatalogCreationPermission(credentials);
    }
    const business = await client.ownerBusiness();
    if (!setup) {
      const linked = await client.linkedCatalogs();
      if (linked.catalogs.length || linked.cursor) throw new HttpError(409, "WhatsApp already has a catalog. Use Connect existing catalog.");
      setup = await repo.ensure(workspaceId, { wabaId: credentials.wabaId, phoneNumberId: credentials.phoneNumberId,
        businessId: business.id, name: input.name });
    }
    if (setup.businessId !== business.id || setup.phoneNumberId !== credentials.phoneNumberId) {
      throw new HttpError(409, "Catalog setup belongs to another WhatsApp connection. Restore that connection to continue.");
    }
    const owner = crypto.randomUUID();
    setup = await repo.claim(workspaceId, credentials.wabaId, owner);
    if (!setup) throw new HttpError(409, "Catalog setup is in progress. Refresh its status shortly.");
    const save = async (patch) => {
      const result = await repo.save(workspaceId, credentials.wabaId, owner, patch);
      if (!result) throw new HttpError(409, "Catalog setup changed. Refresh its status before continuing.");
      setup = result;
    };
    const assertCurrent = async () => {
      const current = await getCredentials(workspaceId);
      if (current.wabaId !== credentials.wabaId || current.phoneNumberId !== credentials.phoneNumberId) {
        throw new HttpError(409, "WhatsApp connection changed. Restore the original connection to resume setup.");
      }
    };
    try {
      await assertCurrent();
      if (!setup.catalogId && input.recoveryCatalogId) {
        await client.verifyOwner(input.recoveryCatalogId, business.id);
        await client.verifyEmptyCatalog(input.recoveryCatalogId);
        await save({ catalogId: input.recoveryCatalogId, state: "created" });
      }
      if (!setup.catalogId) {
        if (setup.state !== "ready") throw new HttpError(409,
          "Creation result is uncertain. Find the catalog in Meta Commerce Manager and enter its ID below. A duplicate will not be created.");
        requireCatalogCreationPermission(credentials);
        const linked = await client.linkedCatalogs();
        if (linked.catalogs.length || linked.cursor) throw new HttpError(409, "WhatsApp already has a catalog. Use Connect existing catalog.");
        // Persist intent BEFORE the external write. A crash/timeout never blindly repeats creation.
        await save({ state: "creating" });
        let catalogId;
        try { catalogId = await client.createOwnedCatalog(business.id, setup.name); }
        catch (error) {
          if (error.ambiguous === false) await save({ state: "ready" });
          throw error;
        }
        await save({ catalogId, state: "created" });
      }
      await assertCurrent();
      await client.verifyOwner(setup.catalogId, business.id);
      await client.linkCatalog(setup.catalogId);
      await assertCurrent();
      // The catalog was created or ownership-verified through the Business-owned
      // catalog edge immediately above, so it may not be present in the older
      // Facebook Login asset targets. Direct catalog/WABA read-back still applies.
      const catalog = await catalogService.bindCatalog(
        workspaceId,
        { catalogId: setup.catalogId, confirmDedicatedCatalog: true },
        { requireCatalogTarget: false }
      );
      await save({ state: "connected" });
      return catalog;
    } finally { await repo.release(workspaceId, credentials.wabaId, owner); }
  }
  return { status, create };
}
module.exports = { ...createSetupService(), createSetupService };
