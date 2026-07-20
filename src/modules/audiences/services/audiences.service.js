const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");
const { audiencesRepository } = require("@modules/audiences/repositories");
const { previewContacts, countContacts, buildFilterCatalog, normalizeNode } = require("@modules/audiences/services/filterEngine.service");
const { contactListsRepository } = require("@modules/contacts/repositories");

async function resolveStaticContactIds({ workspaceId, wabaId, contactIds }) {
  const contacts = await contactListsRepository.findExistingContactsByIds({ workspaceId, wabaId, contactIds });
  if (!contacts.length) throw new HttpError(400, "Select at least one valid contact");
  return contacts.map((contact) => new mongoose.Types.ObjectId(String(contact._id)));
}

async function enrichAudience(scope, audience) {
  if (!audience) return null;
  const doc = audience.toObject ? audience.toObject() : audience;
  let resolvedCount = Number(doc.contactCount || 0);
  if (doc.type === "dynamic" && doc.filterTree) {
    const countResult = await countContacts({ workspaceId: scope.workspaceId, wabaId: scope.wabaId, filterTree: doc.filterTree });
    resolvedCount = countResult.total;
  } else if (doc.type === "static") {
    resolvedCount = Array.isArray(doc.contactIds) ? doc.contactIds.length : 0;
  }
  return {
    ...doc,
    contactCount: resolvedCount,
  };
}

async function listAudiences(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const audiences = await audiencesRepository.listAudiences({ workspaceId: req.workspace.id, wabaId: scope.wabaId });
  const enriched = await Promise.all(audiences.map((audience) => enrichAudience(scope, audience)));
  return {
    success: true,
    audiences: enriched,
    fieldCatalog: await buildFilterCatalog({ workspaceId: req.workspace.id }),
  };
}

async function getAudience(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const audience = await audiencesRepository.getAudience({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!audience) throw new HttpError(404, "Audience not found");
  return { success: true, audience: await enrichAudience(scope, audience) };
}

async function createAudience(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const type = String(req.body?.type || "").trim().toLowerCase();
  const filterTree = req.body?.filterTree ? normalizeNode(req.body.filterTree) : null;
  const contactIds = type === "static"
    ? await resolveStaticContactIds({ workspaceId: req.workspace.id, wabaId: scope.wabaId, contactIds: req.body?.contactIds })
    : [];
  const countResult = type === "dynamic"
    ? await countContacts({ workspaceId: req.workspace.id, wabaId: scope.wabaId, filterTree })
    : { total: contactIds.length };
  try {
    const audience = await audiencesRepository.createAudience({
      workspaceId: req.workspace.id,
      wabaId: scope.wabaId,
      name: String(req.body?.name || "").trim(),
      description: String(req.body?.description || "").trim(),
      type,
      filterTree: type === "dynamic" ? filterTree : null,
      contactIds: type === "static" ? contactIds : [],
      contactCount: countResult.total,
      lastRefreshedAt: new Date(),
      createdBy: req.user?.id || null,
      updatedBy: req.user?.id || null,
      legacySource: "audience_manager",
    });
    return { success: true, audience: await enrichAudience(scope, audience) };
  } catch (error) {
    if (Number(error?.code) === 11000) throw new HttpError(409, "An audience with this name already exists");
    throw error;
  }
}

async function updateAudience(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const audience = await audiencesRepository.getAudience({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!audience) throw new HttpError(404, "Audience not found");
  const nextType = req.body?.type ? String(req.body.type).trim().toLowerCase() : audience.type;
  if (req.body?.name !== undefined) audience.name = String(req.body.name || "").trim();
  if (req.body?.description !== undefined) audience.description = String(req.body.description || "").trim();
  audience.type = nextType;
  if (nextType === "dynamic") {
    if (req.body?.filterTree !== undefined) {
      audience.filterTree = normalizeNode(req.body.filterTree);
    }
    const countResult = await countContacts({ workspaceId: req.workspace.id, wabaId: scope.wabaId, filterTree: audience.filterTree });
    audience.contactCount = countResult.total;
    audience.contactIds = [];
  } else if (req.body?.contactIds !== undefined || nextType === "static") {
    const contactIds = await resolveStaticContactIds({ workspaceId: req.workspace.id, wabaId: scope.wabaId, contactIds: req.body?.contactIds || audience.contactIds });
    audience.contactIds = contactIds;
    audience.contactCount = contactIds.length;
    audience.filterTree = null;
  }
  audience.lastRefreshedAt = new Date();
  audience.updatedBy = req.user?.id || null;
  try {
    await audience.save();
  } catch (error) {
    if (Number(error?.code) === 11000) throw new HttpError(409, "An audience with this name already exists");
    throw error;
  }
  return { success: true, audience: await enrichAudience(scope, audience) };
}

async function deleteAudience(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const result = await audiencesRepository.deleteAudience({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!Number(result?.deletedCount || 0)) throw new HttpError(404, "Audience not found");
  return { success: true };
}

async function previewAudienceContacts(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const audience = await audiencesRepository.getAudienceLean({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!audience) throw new HttpError(404, "Audience not found");
  const preview = audience.type === "dynamic"
    ? await previewContacts({
        workspaceId: req.workspace.id,
        wabaId: scope.wabaId,
        filterTree: audience.filterTree,
        page: req.query.page,
        limit: req.query.limit,
      })
    : await previewContacts({
        workspaceId: req.workspace.id,
        wabaId: scope.wabaId,
        filterTree: { kind: "group", operator: "and", conditions: [] },
        page: req.query.page,
        limit: req.query.limit,
        contactIds: audience.contactIds || [],
      });
  return { success: true, audience: await enrichAudience(scope, audience), preview };
}

module.exports = {
  listAudiences,
  getAudience,
  createAudience,
  updateAudience,
  deleteAudience,
  previewAudienceContacts,
};
