const Joi = require("joi");
const { Template } = require("@infra/database/Template");
const { Workspace } = require("@infra/database/Workspace");
const { TemplateVersion } = require("@infra/database/TemplateVersion");
const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const {
  fetchTemplateStatus,
  fetchAllMessageTemplates,
  deleteMessageTemplate,
} = require("@shared/utils/whatsappSender");
const { normalizeTemplate } = require("@shared/utils/templateStructure");
const { assertTemplateBelongsToWaba } = require("@shared/services/templateOwnershipService");
const { uploadBufferToCloudinary } = require("@shared/services/cloudinaryService");
const { validateMediaFile } = require("@shared/utils/mediaValidation");

function normalizeRemoteStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("approve")) return "approved";
  if (s.includes("reject")) return "rejected";
  if (s.includes("pause")) return "paused";
  if (s.includes("disable")) return "disabled";
  if (s.includes("pending")) return "pending";
  return "pending";
}

function normalizeRemoteTemplate(remote) {
  const languageCode = String(remote?.language || "en_US").trim();
  return {
    name: String(remote?.name || "").trim(),
    language: languageCode,
    languageCode,
    category: String(remote?.category || "utility").trim().toLowerCase(),
    components: Array.isArray(remote?.components) ? remote.components : [],
    status: normalizeRemoteStatus(remote?.status),
    source: "meta",
    metaTemplateId: remote?.id ? String(remote.id) : undefined,
    rejectedReason: remote?.rejected_reason || undefined,
    lastSyncedAt: new Date(),
    syncedAt: new Date(),
    isActive: true,
    deletedAt: null,
    staleReason: null,
  };
}

function snapshotTemplate(template) {
  const doc = template?.toObject ? template.toObject() : template || {};
  return {
    name: String(doc.name || "").trim(),
    language: String(doc.languageCode || doc.language || "").trim(),
    languageCode: String(doc.languageCode || doc.language || "").trim(),
    category: String(doc.category || "utility").trim().toLowerCase(),
    status: String(doc.status || "draft").trim().toLowerCase(),
    components: Array.isArray(doc.components) ? JSON.parse(JSON.stringify(doc.components)) : [],
    libraryCategory: doc.libraryCategory || null,
    industry: doc.industry || null,
    templatePackKey: doc.templatePackKey || null,
    templatePackName: doc.templatePackName || null,
    templatePackOrder: Number(doc.templatePackOrder || 0),
    tags: Array.isArray(doc.tags) ? [...doc.tags] : [],
    featured: Boolean(doc.featured),
    thumbnail: doc.thumbnail || null,
    isOfficial: Boolean(doc.isOfficial),
  };
}

function buildVersionChanges(previousSnapshot, nextSnapshot) {
  const changes = [];
  const previous = previousSnapshot || null;
  const next = nextSnapshot || null;
  const pushFieldChange = (field, before, after) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    changes.push({ field, before, after });
  };
  if (!previous) {
    Object.entries(next || {}).forEach(([field, after]) => {
      changes.push({ field, before: undefined, after });
    });
    return changes;
  }
  pushFieldChange("name", previous.name, next?.name);
  pushFieldChange("language", previous.language, next?.language);
  pushFieldChange("category", previous.category, next?.category);
  pushFieldChange("status", previous.status, next?.status);
  pushFieldChange("components", previous.components, next?.components);
  pushFieldChange("libraryCategory", previous.libraryCategory, next?.libraryCategory);
  pushFieldChange("industry", previous.industry, next?.industry);
  pushFieldChange("templatePackKey", previous.templatePackKey, next?.templatePackKey);
  pushFieldChange("templatePackName", previous.templatePackName, next?.templatePackName);
  pushFieldChange("templatePackOrder", previous.templatePackOrder, next?.templatePackOrder);
  pushFieldChange("tags", previous.tags, next?.tags);
  pushFieldChange("featured", previous.featured, next?.featured);
  pushFieldChange("thumbnail", previous.thumbnail, next?.thumbnail);
  pushFieldChange("isOfficial", previous.isOfficial, next?.isOfficial);
  return changes;
}

function buildUpdatedBy(user) {
  return {
    userId: user?.id || user?._id || null,
    email: user?.email || null,
    name: user?.name || user?.fullName || null,
  };
}

async function ensureVersionBaseline({ template, user }) {
  const existing = await TemplateVersion.findOne({
    workspaceId: template.workspaceId || null,
    templateId: template._id,
  }).sort({ versionNumber: -1 });
  if (existing) return existing;
  return TemplateVersion.create({
    workspaceId: template.workspaceId || null,
    templateId: template._id,
    versionNumber: 1,
    action: "created",
    updatedBy: buildUpdatedBy(user),
    changes: buildVersionChanges(null, snapshotTemplate(template)),
    snapshot: snapshotTemplate(template),
  });
}

async function createTemplateVersion({ template, previousSnapshot, user, action = "updated" }) {
  const latest = await ensureVersionBaseline({ template, user });
  const latestVersionNumber = Number(latest?.versionNumber || 1);
  return TemplateVersion.create({
    workspaceId: template.workspaceId || null,
    templateId: template._id,
    versionNumber: latest ? latestVersionNumber + 1 : 1,
    action,
    updatedBy: buildUpdatedBy(user),
    changes: buildVersionChanges(previousSnapshot, snapshotTemplate(template)),
    snapshot: snapshotTemplate(template),
  });
}

async function ensureWorkspaceForTemplate(template) {
  const workspaceId = String(template?.workspaceId || "");
  const workspace = await Workspace.findById(workspaceId).select("_id name plan isActive");
  if (!workspace) throw new HttpError(404, "Workspace not found for template");
  return { id: String(workspace._id), name: workspace.name, plan: workspace.plan, isActive: !!workspace.isActive };
}

async function adminGetMasterTemplate(req, res) {
  const template = await Template.findById(req.params.id);
  if (!template) throw new HttpError(404, "Template not found");
  const workspace = template.workspaceId ? await ensureWorkspaceForTemplate(template) : null;
  res.json({ success: true, template, workspace });
}

const createSchema = Joi.object({
  name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).required(),
  language: Joi.string().min(2).max(20).required(),
  category: Joi.string().valid("marketing", "utility", "authentication").required(),
  components: Joi.array().items(Joi.object().unknown(true)).min(1).required(),
  libraryCategory: Joi.string().trim().max(80).allow("", null).optional(),
  industry: Joi.string().trim().max(80).allow("", null).optional(),
  templatePackKey: Joi.string().trim().max(80).allow("", null).optional(),
  templatePackName: Joi.string().trim().max(120).allow("", null).optional(),
  templatePackOrder: Joi.number().integer().min(0).max(9999).optional(),
  tags: Joi.array().items(Joi.string().trim().max(40)).max(25).optional(),
  featured: Joi.boolean().optional(),
  thumbnail: Joi.string().trim().allow("", null).optional(),
  isOfficial: Joi.boolean().optional(),
});

const updateSchema = Joi.object({
  name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).optional(),
  language: Joi.string().min(2).max(20).optional(),
  category: Joi.string().valid("marketing", "utility", "authentication").optional(),
  components: Joi.array().items(Joi.object().unknown(true)).min(1).optional(),
  libraryCategory: Joi.string().trim().max(80).allow("", null).optional(),
  industry: Joi.string().trim().max(80).allow("", null).optional(),
  templatePackKey: Joi.string().trim().max(80).allow("", null).optional(),
  templatePackName: Joi.string().trim().max(120).allow("", null).optional(),
  templatePackOrder: Joi.number().integer().min(0).max(9999).optional(),
  tags: Joi.array().items(Joi.string().trim().max(40)).max(25).optional(),
  featured: Joi.boolean().optional(),
  thumbnail: Joi.string().trim().allow("", null).optional(),
  isOfficial: Joi.boolean().optional(),
});

async function adminCreateMasterTemplate(req, res) {
  const payload = await createSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const normalized = normalizeTemplate({ ...payload, source: "local" });
  const created = await Template.create({
    workspaceId: null,
    ownerType: "system",
    wabaId: null,
    phoneNumberId: null,
    name: normalized.name,
    language: normalized.language,
    languageCode: normalized.language,
    category: normalized.category,
    components: normalized.components,
    status: "draft",
    source: "local",
    metaTemplateId: undefined,
    syncedAt: null,
    isActive: true,
    deletedAt: null,
    staleReason: null,
    rejectedReason: undefined,
    lastSyncedAt: null,
    libraryCategory: payload.libraryCategory || null,
    industry: payload.industry || null,
    templatePackKey: payload.templatePackKey || null,
    templatePackName: payload.templatePackName || null,
    templatePackOrder: Number(payload.templatePackOrder || 0),
    tags: Array.isArray(payload.tags) ? payload.tags.filter(Boolean) : [],
    featured: Boolean(payload.featured),
    thumbnail: payload.thumbnail || null,
    isOfficial: Boolean(payload.isOfficial),
    popularity: 0,
  });
  await ensureVersionBaseline({ template: created, user: req.user });
  res.status(201).json({ success: true, template: created });
}

async function adminUploadMasterTemplateMedia(req, res) {
  const file = req.file;
  if (!file?.buffer) throw new HttpError(400, "File is required");
  const mediaType = String(req.body?.mediaType || "").trim().toLowerCase();
  if (!["image", "video", "document"].includes(mediaType)) {
    throw new HttpError(400, "Media type must be image, video, or document");
  }

  const validation = validateMediaFile({
    mediaType,
    mimeType: file.mimetype,
    originalName: file.originalname,
    sizeBytes: file.size,
    buffer: file.buffer,
  });

  let uploaded;
  try {
    uploaded = await uploadBufferToCloudinary({
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
      folder: "aiwizchat/template-library",
    });
  } catch (error) {
    throw new HttpError(500, "Template library media upload failed", {
      code: error?.code || "MEDIA_UPLOAD_FAILED",
      message: error?.message || "Template library media upload failed",
    });
  }

  const publicUrl = String(uploaded?.secure_url || uploaded?.url || "").trim();
  if (!publicUrl) throw new HttpError(500, "Template library media upload failed");

  res.status(201).json({
    success: true,
    asset: {
      id: String(uploaded?.public_id || uploaded?.asset_id || ""),
      originalName: String(file.originalname || "file"),
      displayName: String(file.originalname || "file"),
      mimeType: String(file.mimetype || ""),
      extension: validation.extension,
      sizeBytes: Number(file.size || 0),
      mediaType: validation.mediaType,
      publicUrl,
      status: "ready",
      createdAt: new Date().toISOString(),
    },
  });
}

async function adminUpdateMasterTemplate(req, res) {
  const payload = await updateSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const existing = await Template.findById(req.params.id);
  if (!existing) throw new HttpError(404, "Template not found");
  const previousSnapshot = snapshotTemplate(existing);

  if (
    payload?.category &&
    String(payload.category).trim().toLowerCase() !== String(existing.category || "").trim().toLowerCase()
  ) {
    throw new HttpError(400, "Template category cannot be changed after creation");
  }
  if (existing.metaTemplateId) {
    if (payload?.name && String(payload.name).trim() !== String(existing.name || "").trim()) {
      throw new HttpError(400, "Template name cannot be changed after it is linked to Meta");
    }
    if (payload?.language && String(payload.language).trim() !== String(existing.language || "").trim()) {
      throw new HttpError(400, "Template language cannot be changed after it is linked to Meta");
    }
  }

  const normalized = normalizeTemplate({
    ...existing.toObject(),
    ...payload,
  });

  existing.name = normalized.name;
  existing.language = normalized.language;
  existing.languageCode = normalized.language;
  existing.category = existing.category;
  existing.components = normalized.components;
  if (Object.prototype.hasOwnProperty.call(payload, "libraryCategory")) existing.libraryCategory = payload.libraryCategory || null;
  if (Object.prototype.hasOwnProperty.call(payload, "industry")) existing.industry = payload.industry || null;
  if (Object.prototype.hasOwnProperty.call(payload, "templatePackKey")) existing.templatePackKey = payload.templatePackKey || null;
  if (Object.prototype.hasOwnProperty.call(payload, "templatePackName")) existing.templatePackName = payload.templatePackName || null;
  if (Object.prototype.hasOwnProperty.call(payload, "templatePackOrder")) existing.templatePackOrder = Number(payload.templatePackOrder || 0);
  if (Object.prototype.hasOwnProperty.call(payload, "tags")) existing.tags = Array.isArray(payload.tags) ? payload.tags.filter(Boolean) : [];
  if (Object.prototype.hasOwnProperty.call(payload, "featured")) existing.featured = Boolean(payload.featured);
  if (Object.prototype.hasOwnProperty.call(payload, "thumbnail")) existing.thumbnail = payload.thumbnail || null;
  if (Object.prototype.hasOwnProperty.call(payload, "isOfficial")) existing.isOfficial = Boolean(payload.isOfficial);
  const saved = await existing.save();
  await createTemplateVersion({ template: saved, previousSnapshot, user: req.user, action: "updated" });
  res.json({ success: true, template: saved });
}

async function adminDeleteMasterTemplate(req, res) {
  const template = await Template.findById(req.params.id);
  if (!template) throw new HttpError(404, "Template not found");
  const workspace = template.workspaceId ? await ensureWorkspaceForTemplate(template) : null;

  const shouldDeleteOnMeta = template.ownerType !== "system" && (template.source === "meta" || !!template.metaTemplateId);
  let metaDelete = null;

  if (shouldDeleteOnMeta) {
    const creds = await getCredentialsForUser(workspace.id);
    assertTemplateBelongsToWaba(template, creds.wabaId);
    try {
      metaDelete = await deleteMessageTemplate({
        accessToken: creds.accessToken,
        wabaId: creds.wabaId,
        templateName: template.name,
        graphApiVersion: creds.graphApiVersion,
      });
    } catch (err) {
      throw new HttpError(400, "Meta template delete failed", {
        message: err.message,
        metaDebug: err.metaDebug || null,
      });
    }
  }

  await Template.deleteOne({ _id: template._id });
  res.json({ success: true, meta: metaDelete });
}

async function adminDuplicateMasterTemplate(req, res) {
  const source = await Template.findById(req.params.id);
  if (!source) throw new HttpError(404, "Template not found");
  const duplicate = await Template.create({
    workspaceId: null,
    ownerType: "system",
    wabaId: null,
    phoneNumberId: null,
    name: `${String(source.name || "").slice(0, 500)}_copy`,
    language: source.language,
    languageCode: source.languageCode,
    category: source.category,
    components: Array.isArray(source.components) ? source.components : [],
    status: "draft",
    source: "local",
    metaTemplateId: undefined,
    syncedAt: null,
    isActive: true,
    deletedAt: null,
    staleReason: null,
    rejectedReason: undefined,
    lastSyncedAt: null,
    libraryCategory: source.libraryCategory || null,
    industry: source.industry || null,
    templatePackKey: source.templatePackKey || null,
    templatePackName: source.templatePackName || null,
    templatePackOrder: Number(source.templatePackOrder || 0),
    tags: Array.isArray(source.tags) ? source.tags : [],
    featured: false,
    thumbnail: source.thumbnail || null,
    sourceTemplateId: source._id,
    isOfficial: Boolean(source.isOfficial),
    popularity: 0,
  });
  await ensureVersionBaseline({ template: duplicate, user: req.user });
  await createTemplateVersion({ template: duplicate, previousSnapshot: null, user: req.user, action: "duplicated" });
  res.status(201).json({ success: true, template: duplicate });
}

async function adminPublishMasterTemplate(req, res) {
  const template = await Template.findById(req.params.id);
  if (!template) throw new HttpError(404, "Template not found");
  if (template.ownerType !== "system") throw new HttpError(400, "Only system templates can be published to the library");
  if (String(template.status || "").toLowerCase() === "published") throw new HttpError(400, "Template is already published");
  if (!["draft", "archived"].includes(String(template.status || "").toLowerCase())) {
    throw new HttpError(400, "Only draft or archived system templates can be published");
  }
  const previousSnapshot = snapshotTemplate(template);
  template.status = "published";
  template.isActive = true;
  template.deletedAt = null;
  template.staleReason = null;
  const saved = await template.save();
  await createTemplateVersion({ template: saved, previousSnapshot, user: req.user, action: "published" });
  res.json({ success: true, template: saved });
}

async function adminArchiveMasterTemplate(req, res) {
  const template = await Template.findById(req.params.id);
  if (!template) throw new HttpError(404, "Template not found");
  if (template.ownerType !== "system") throw new HttpError(400, "Only system templates can be archived in the library");
  if (String(template.status || "").toLowerCase() !== "published") {
    throw new HttpError(400, "Only published system templates can be archived");
  }
  const previousSnapshot = snapshotTemplate(template);
  template.status = "archived";
  const saved = await template.save();
  await createTemplateVersion({ template: saved, previousSnapshot, user: req.user, action: "archived" });
  res.json({ success: true, template: saved });
}

async function adminListMasterTemplateHistory(req, res) {
  const template = await Template.findById(req.params.id);
  if (!template) throw new HttpError(404, "Template not found");
  await ensureVersionBaseline({ template, user: req.user });
  const versions = await TemplateVersion.find({
    workspaceId: template.workspaceId || null,
    templateId: template._id,
  }).sort({ versionNumber: -1, createdAt: -1 });
  res.json({ success: true, templateId: String(template._id), versions });
}

async function adminRestoreMasterTemplateVersion(req, res) {
  const template = await Template.findById(req.params.id);
  if (!template) throw new HttpError(404, "Template not found");
  await ensureVersionBaseline({ template, user: req.user });
  const version = await TemplateVersion.findOne({
    _id: req.params.versionId,
    workspaceId: template.workspaceId || null,
    templateId: template._id,
  });
  if (!version) throw new HttpError(404, "Template version not found");
  const previousSnapshot = snapshotTemplate(template);
  const snapshot = version.snapshot || {};
  const normalized = normalizeTemplate({
    ...template.toObject(),
    name: snapshot.name || template.name,
    language: snapshot.language || template.language,
    category: snapshot.category || template.category,
    components: Array.isArray(snapshot.components) ? snapshot.components : template.components,
    source: "local",
  });
  template.name = normalized.name;
  template.language = normalized.language;
  template.languageCode = normalized.language;
  template.category = normalized.category;
  template.components = normalized.components;
  template.status = snapshot.status || "draft";
  template.libraryCategory = snapshot.libraryCategory || null;
  template.industry = snapshot.industry || null;
  template.templatePackKey = snapshot.templatePackKey || null;
  template.templatePackName = snapshot.templatePackName || null;
  template.templatePackOrder = Number(snapshot.templatePackOrder || 0);
  template.tags = Array.isArray(snapshot.tags) ? snapshot.tags : [];
  template.featured = Boolean(snapshot.featured);
  template.thumbnail = snapshot.thumbnail || null;
  template.isOfficial = Boolean(snapshot.isOfficial);
  const saved = await template.save();
  await createTemplateVersion({ template: saved, previousSnapshot, user: req.user, action: "restored" });
  res.json({ success: true, template: saved, restoredFrom: version });
}

async function adminSyncTemplateStatus(req, res) {
  const template = await Template.findById(req.params.id);
  if (!template) throw new HttpError(404, "Template not found");
  if (template.ownerType === "system") throw new HttpError(400, "System templates do not support Meta sync status");
  const workspace = await ensureWorkspaceForTemplate(template);
  const creds = await getCredentialsForUser(workspace.id);
  assertTemplateBelongsToWaba(template, creds.wabaId);

  let remote;
  try {
    remote = await fetchTemplateStatus({
      accessToken: creds.accessToken,
      wabaId: creds.wabaId,
      templateName: template.name,
      metaTemplateId: template.metaTemplateId,
      graphApiVersion: creds.graphApiVersion,
    });
  } catch (err) {
    throw new HttpError(400, "Failed to fetch template status", {
      message: err.message,
      metaDebug: err.metaDebug || null,
    });
  }

  if (!remote) throw new HttpError(404, "Template not found in Meta account (by name)");

  template.status = normalizeRemoteStatus(remote.status);
  template.rejectedReason = remote.rejected_reason || template.rejectedReason;
  if (Array.isArray(remote.components) && remote.components.length > 0) {
    template.components = remote.components;
  }
  template.lastSyncedAt = new Date();
  await template.save();

  res.json({ success: true, template, meta: remote });
}

const syncMetaSchema = Joi.object({
  workspaceId: Joi.string().required(),
  name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).optional(),
});

async function adminSyncMetaTemplates(req, res) {
  const payload = await syncMetaSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const workspace = await Workspace.findById(payload.workspaceId).select("_id name plan isActive");
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const creds = await getCredentialsForUser(String(workspace._id));

  let remoteTemplates;
  try {
    remoteTemplates = await fetchAllMessageTemplates({
      accessToken: creds.accessToken,
      wabaId: creds.wabaId,
      graphApiVersion: creds.graphApiVersion,
      exactName: payload.name ? String(payload.name).trim() : undefined,
    });
  } catch (err) {
    throw new HttpError(400, "Failed to fetch Meta templates", {
      message: err.message,
      metaDebug: err.metaDebug || null,
    });
  }

  const synced = [];
  for (const remote of remoteTemplates) {
    const normalized = normalizeRemoteTemplate(remote);
    if (!normalized.name) continue;

    const existing = await Template.findOne({
      workspaceId: String(workspace._id),
      wabaId: creds.wabaId,
      name: normalized.name,
      languageCode: normalized.languageCode,
    });

    if (existing) {
      existing.language = normalized.language;
      existing.languageCode = normalized.languageCode;
      existing.category = normalized.category;
      existing.components = normalized.components;
      existing.status = normalized.status;
      existing.source = "meta";
      existing.metaTemplateId = normalized.metaTemplateId || existing.metaTemplateId;
      existing.rejectedReason = normalized.rejectedReason;
      existing.lastSyncedAt = normalized.lastSyncedAt;
      existing.wabaId = creds.wabaId;
      existing.phoneNumberId = creds.phoneNumberId;
      await existing.save();
      synced.push(existing);
      continue;
    }

    const created = await Template.create({
      workspaceId: String(workspace._id),
      wabaId: creds.wabaId,
      ...normalized,
    });
    synced.push(created);
  }

  res.json({ success: true, count: synced.length, templates: synced });
}

module.exports = {
  adminCreateMasterTemplate,
  adminUploadMasterTemplateMedia,
  adminDuplicateMasterTemplate,
  adminPublishMasterTemplate,
  adminArchiveMasterTemplate,
  adminListMasterTemplateHistory,
  adminRestoreMasterTemplateVersion,
  adminGetMasterTemplate,
  adminUpdateMasterTemplate,
  adminDeleteMasterTemplate,
  adminSyncTemplateStatus,
  adminSyncMetaTemplates,
};


