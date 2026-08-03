const { HttpError } = require("@shared/utils/httpError");
const { resolveActiveConnection, maskId } = require("@shared/services/whatsappConnectionService");
const {
  submitTemplate,
  fetchTemplateStatus,
  fetchAllMessageTemplates,
  fetchWabaName,
  deleteMessageTemplate,
} = require("@shared/utils/whatsappSender");
const { normalizeTemplate } = require("@shared/utils/templateStructure");
const { TemplateVersion } = require("@infra/database/TemplateVersion");
const { TemplateLibraryEvent } = require("@infra/database/TemplateLibraryEvent");
const { templatesRepository } = require("@modules/templates/repositories/index");
const { checkLimit, getUsageState } = require("@modules/billing/services/usageLimit.service");
const { assertTemplateBelongsToWaba } = require("@shared/services/templateOwnershipService");
const { logWorkspaceActivity } = require("@modules/workspaces/services/workspaceActivity.service");
const { isEmbeddedSignupConnection } = require("@shared/services/whatsappConnectionService");

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
    isActive: true,
    staleReason: null,
    deletedAt: null,
    syncedAt: new Date(),
    lastSyncedAt: new Date(),
  };
}

function connectionMetadata(connection, staleTemplateCount = 0, templateCount = 0) {
  return {
    currentWabaIdMasked: connection ? maskId(connection.wabaId) : null,
    currentPhoneNumberIdMasked: connection ? maskId(connection.phoneNumberId) : null,
    displayPhoneNumber: connection?.displayPhoneNumber || null,
    wabaName: connection?.wabaName || null,
    templateCount,
    staleTemplateCountIgnored: staleTemplateCount,
  };
}

function placeholderIndexes(text) {
  const indexes = new Set();
  for (const match of String(text || "").matchAll(/\{\{(\d+)\}\}/g)) {
    const index = Number(match[1]);
    if (Number.isFinite(index) && index > 0) indexes.add(index);
  }
  return Array.from(indexes).sort((a, b) => a - b);
}

function buildVariableSchema(components = []) {
  const schema = [];
  for (const component of components || []) {
    const type = String(component?.type || "").toLowerCase();
    if (type === "header") {
      placeholderIndexes(component?.text).forEach((index) =>
        schema.push({ component: "header", index })
      );
    }
    if (type === "body") {
      placeholderIndexes(component?.text).forEach((index) =>
        schema.push({ component: "body", index })
      );
    }
    if (type === "buttons") {
      (component?.buttons || []).forEach((button, buttonIndex) => {
        placeholderIndexes(button?.url).forEach((index) =>
          schema.push({ component: "button", index, buttonIndex })
        );
      });
    }
  }
  return schema;
}

function serializeApprovedTemplate(template) {
  const doc = template?.toObject ? template.toObject() : template;
  return {
    id: String(doc._id || doc.id || ""),
    name: doc.name,
    languageCode: doc.languageCode || doc.language || "en",
    category: doc.category,
    status: doc.status,
    components: doc.components || [],
    variableSchema: buildVariableSchema(doc.components || []),
  };
}

function isMetaTemplateNotFound(err) {
  const metaError = err?.metaDebug?.meta || err?.metaDebug?.raw?.error || err?.response?.data?.error || {};
  const code = Number(metaError?.code);
  const subcode = Number(metaError?.error_subcode);
  const errorUserTitle = String(metaError?.error_user_title || "").toLowerCase();
  const message = String(
    metaError?.message ||
      err?.message ||
      ""
  ).toLowerCase();
  return (
    (code === 100 && subcode === 2593002) ||
    errorUserTitle.includes("message template not found") ||
    message.includes("message template not found") ||
    message.includes("template does not exist")
  );
}

function permissionSubmitMessage(err) {
  const providerError = String(err?.providerError || "");
  if (providerError) {
    return providerError;
  }
  return err?.message || "Template submission failed";
}

function isTemplateVisible(template) {
  return !!template && template.deletedAt === null && template.isActive !== false;
}

function isDraftTemplate(template) {
  return String(template?.status || "").toLowerCase() === "draft";
}

function sortTemplatesByNewest(templates = []) {
  return [...templates].sort((a, b) => {
    const left = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
    const right = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
    return right - left;
  });
}

function hasLibraryHostedHeaderMedia(components = []) {
  return (components || []).some((component) => {
    const type = String(component?.type || "").toUpperCase();
    const format = String(component?.format || "").toUpperCase();
    if (type !== "HEADER" || !["IMAGE", "VIDEO", "DOCUMENT"].includes(format)) return false;
    const rawValue = component?.example?.header_handle?.[0];
    return /^https?:\/\//i.test(String(rawValue || "").trim());
  });
}

function snapshotTemplate(template) {
  const doc = template?.toObject ? template.toObject() : template || {};
  return {
    name: String(doc.name || "").trim(),
    language: String(doc.languageCode || doc.language || "").trim(),
    languageCode: String(doc.languageCode || doc.language || "").trim(),
    category: String(doc.category || "utility").trim().toLowerCase(),
    components: Array.isArray(doc.components) ? JSON.parse(JSON.stringify(doc.components)) : [],
    status: String(doc.status || "draft").trim().toLowerCase(),
    source: String(doc.source || "local").trim().toLowerCase(),
    rejectedReason: doc.rejectedReason ? String(doc.rejectedReason) : undefined,
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
  return changes;
}

function buildUpdatedBy(user) {
  return {
    userId: user?.id || user?._id || null,
    email: user?.email || null,
    name: user?.name || user?.fullName || null,
  };
}

async function recordLibraryEvent({
  templateId,
  sourceTemplateId = null,
  workspaceId = null,
  actorUserId = null,
  eventType,
  metadata = {},
}) {
  if (!templateId || !eventType) return null;
  return TemplateLibraryEvent.create({
    templateId,
    sourceTemplateId: sourceTemplateId || templateId,
    workspaceId,
    actorUserId,
    eventType,
    metadata,
  }).catch(() => null);
}

async function incrementLibraryPopularity(templateId, amount = 1) {
  if (!templateId || !Number.isFinite(Number(amount)) || Number(amount) === 0) return null;
  return templatesRepository.incrementTemplatePopularity({ id: templateId, amount: Number(amount) }).catch(() => null);
}

async function buildLibraryAnalyticsSummary({ workspaceId, limit = 10 }) {
  const normalizedLimit = Math.min(Math.max(Number(limit || 10), 1), 25);
  const [mostUsedAgg, recentWorkspaceEvents, recentlyAdded, totalsAgg] = await Promise.all([
    TemplateLibraryEvent.aggregate([
      { $match: { eventType: { $in: ["use", "copy"] } } },
      { $group: { _id: "$sourceTemplateId", uses: { $sum: { $cond: [{ $eq: ["$eventType", "use"] }, 1, 0] } }, copies: { $sum: { $cond: [{ $eq: ["$eventType", "copy"] }, 1, 0] } }, lastUsedAt: { $max: "$createdAt" } } },
      { $sort: { uses: -1, copies: -1, lastUsedAt: -1 } },
      { $limit: normalizedLimit },
    ]),
    TemplateLibraryEvent.aggregate([
      { $match: { workspaceId, eventType: { $in: ["use", "copy", "download"] } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$sourceTemplateId", eventType: { $first: "$eventType" }, lastEventAt: { $first: "$createdAt" }, templateId: { $first: "$templateId" } } },
      { $sort: { lastEventAt: -1 } },
      { $limit: normalizedLimit },
    ]),
    Template.find({
      ownerType: "system",
      status: "published",
      isActive: { $ne: false },
      deletedAt: null,
    })
      .sort({ createdAt: -1, updatedAt: -1 })
      .limit(normalizedLimit)
      .select("name language category industry libraryCategory featured popularity createdAt updatedAt thumbnail tags"),
    TemplateLibraryEvent.aggregate([
      { $group: {
        _id: null,
        uses: { $sum: { $cond: [{ $eq: ["$eventType", "use"] }, 1, 0] } },
        copies: { $sum: { $cond: [{ $eq: ["$eventType", "copy"] }, 1, 0] } },
        downloads: { $sum: { $cond: [{ $eq: ["$eventType", "download"] }, 1, 0] } },
        previews: { $sum: { $cond: [{ $eq: ["$eventType", "preview"] }, 1, 0] } },
        favorites: { $sum: { $cond: [{ $eq: ["$eventType", "favorite"] }, 1, 0] } },
      } },
    ]),
  ]);

  const templateIds = Array.from(new Set([
    ...mostUsedAgg.map((item) => String(item._id || "")),
    ...recentWorkspaceEvents.map((item) => String(item._id || "")),
  ].filter(Boolean)));
  const templates = templateIds.length
    ? await Template.find({ _id: { $in: templateIds } })
      .select("name language category industry libraryCategory featured popularity createdAt updatedAt thumbnail tags status ownerType")
    : [];
  const templateById = new Map(templates.map((template) => [String(template._id), template]));

  const serializeTemplate = (template, extra = {}) => {
    const doc = template?.toObject ? template.toObject() : template;
    return {
      _id: String(doc?._id || ""),
      name: doc?.name || "",
      language: doc?.languageCode || doc?.language || "en_US",
      category: doc?.category || null,
      industry: doc?.industry || doc?.libraryCategory || null,
      featured: Boolean(doc?.featured),
      popularity: Number(doc?.popularity || 0),
      thumbnail: doc?.thumbnail || null,
      tags: Array.isArray(doc?.tags) ? doc.tags : [],
      createdAt: doc?.createdAt || null,
      updatedAt: doc?.updatedAt || null,
      ...extra,
    };
  };

  return {
    success: true,
    overview: {
      uses: Number(totalsAgg?.[0]?.uses || 0),
      copies: Number(totalsAgg?.[0]?.copies || 0),
      downloads: Number(totalsAgg?.[0]?.downloads || 0),
      previews: Number(totalsAgg?.[0]?.previews || 0),
      favorites: Number(totalsAgg?.[0]?.favorites || 0),
    },
    mostUsed: mostUsedAgg
      .map((item) => {
        const template = templateById.get(String(item._id || ""));
        if (!template) return null;
        return serializeTemplate(template, {
          useCount: Number(item.uses || 0),
          copyCount: Number(item.copies || 0),
          lastUsedAt: item.lastUsedAt || null,
        });
      })
      .filter(Boolean),
    recentlyUsed: recentWorkspaceEvents
      .map((item) => {
        const template = templateById.get(String(item._id || ""));
        if (!template) return null;
        return serializeTemplate(template, {
          lastEventType: item.eventType,
          lastUsedAt: item.lastEventAt || null,
        });
      })
      .filter(Boolean),
    recentlyAdded: recentlyAdded.map((template) => serializeTemplate(template)),
  };
}

async function listLibraryTemplatePacks(req) {
  const templates = await templatesRepository.listPublishedLibraryPackTemplates();
  const grouped = new Map();
  for (const row of templates || []) {
    const doc = row?.toObject ? row.toObject() : row;
    const packKey = String(doc.templatePackKey || "").trim();
    if (!packKey) continue;
    if (!grouped.has(packKey)) {
      grouped.set(packKey, {
        key: packKey,
        name: String(doc.templatePackName || packKey).trim(),
        industry: doc.industry || null,
        libraryCategory: doc.libraryCategory || null,
        templates: [],
      });
    }
    grouped.get(packKey).templates.push({
      _id: String(doc._id || ""),
      name: doc.name,
      language: doc.languageCode || doc.language || "en_US",
      category: doc.category,
      templatePackOrder: Number(doc.templatePackOrder || 0),
    });
  }
  const packs = Array.from(grouped.values())
    .map((pack) => ({
      ...pack,
      templateCount: pack.templates.length,
      templates: pack.templates.sort((a, b) => Number(a.templatePackOrder || 0) - Number(b.templatePackOrder || 0) || String(a.name).localeCompare(String(b.name))),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { success: true, packs };
}

async function ensureVersionBaseline({ template, user }) {
  const templateId = String(template?._id || "");
  if (!templateId) return null;
  const existing = await TemplateVersion.findOne({
    workspaceId: template.workspaceId,
    templateId,
  }).sort({ versionNumber: -1 });
  if (existing) return existing;
  return TemplateVersion.create({
    workspaceId: template.workspaceId,
    templateId,
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
  const nextSnapshot = snapshotTemplate(template);
  return TemplateVersion.create({
    workspaceId: template.workspaceId,
    templateId: template._id,
    versionNumber: latest ? latestVersionNumber + 1 : 1,
    action,
    updatedBy: buildUpdatedBy(user),
    changes: buildVersionChanges(previousSnapshot, nextSnapshot),
    snapshot: nextSnapshot,
  });
}

async function ensureTemplateNameLanguageAvailable({
  workspaceId,
  name,
  languageCode,
  wabaId = null,
  excludeId,
}) {
  const existing = await templatesRepository.findWorkspaceTemplateByNameLanguage({
    workspaceId,
    name,
    languageCode,
    wabaId,
    excludeId,
  });
  if (existing) {
    throw new HttpError(409, "A template with this name and language already exists.");
  }
}

async function createLocalDraftRecord({ workspaceId, payload }) {
  await checkLimit(workspaceId, "templates");
  const normalized = normalizeTemplate({ ...payload, source: "local" });
  const languageCode = String(normalized.language || "").trim();
  const sourceTemplateId = payload?.sourceTemplateId || null;
  await ensureTemplateNameLanguageAvailable({
    workspaceId,
    name: normalized.name,
    languageCode,
    wabaId: null,
  });
  return templatesRepository.createTemplate({
    ...normalized,
    workspaceId,
    ownerType: "workspace",
    wabaId: null,
    phoneNumberId: null,
    languageCode,
    sourceTemplateId,
    source: "local",
    status: "draft",
    isActive: true,
    deletedAt: null,
    staleReason: null,
    metaTemplateId: undefined,
    rejectedReason: undefined,
    syncedAt: null,
    lastSyncedAt: null,
    featured: false,
    isOfficial: false,
    popularity: 0,
  });
}

async function generateDuplicateDraftName({ workspaceId, name, languageCode }) {
  const normalizedBase = String(name || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const suffix = "_copy";
  const maxBaseLength = Math.max(1, 512 - suffix.length - 4);
  const base = normalizedBase.slice(0, maxBaseLength);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = attempt === 0 ? `${base}${suffix}` : `${base}${suffix}_${attempt + 1}`;
    const existing = await templatesRepository.findWorkspaceTemplateByNameLanguage({
      workspaceId,
      name: candidate,
      languageCode,
      wabaId: null,
    });
    if (!existing) return candidate;
  }
  throw new HttpError(500, "Unable to generate a unique duplicate draft name");
}

async function requireActiveConnection(workspaceId) {
  const connection = await resolveActiveConnection(workspaceId);
  if (!connection) throw new HttpError(400, "Active WhatsApp connection not configured");
  if (!isEmbeddedSignupConnection(connection.doc)) {
    throw new HttpError(409, "This workspace is using a manual/system-user token. Reconnect with Embedded Signup to use customer self-connect.");
  }
  return connection;
}

async function createTemplate(req) {
  await checkLimit(req.workspace.id, "templates");

  const normalized = normalizeTemplate({ ...req.body, source: "local" });
  const connection = await requireActiveConnection(req.workspace.id);
  let metaResponse;
  try {
    metaResponse = await submitTemplate({
      accessToken: connection.accessToken,
      wabaId: connection.wabaId,
      template: normalized,
      graphApiVersion: connection.graphApiVersion,
    });
  } catch (err) {
    const message = permissionSubmitMessage(err);
    throw new HttpError(400, message, {
      message,
      metaDebug: err.metaDebug || null,
      tokenDebug: err.tokenDebug || null,
    });
  }

  const languageCode = String(normalized.language || "").trim();
  const tpl = await templatesRepository.createTemplate({
    ...normalized,
    workspaceId: req.workspace.id,
    wabaId: connection.wabaId,
    phoneNumberId: connection.phoneNumberId,
    languageCode,
    source: "local",
    isActive: true,
    deletedAt: null,
    staleReason: null,
    metaTemplateId: metaResponse?.id || undefined,
    status: normalizeRemoteStatus(metaResponse?.status),
    syncedAt: new Date(),
    lastSyncedAt: new Date(),
  });
  await logWorkspaceActivity({
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    action: "template.created",
    entityType: "template",
    entityId: String(tpl._id),
    metadata: { name: tpl.name, languageCode: tpl.languageCode },
  });
  await ensureVersionBaseline({ template: tpl, user: req.user });

  return { success: true, template: tpl, meta: metaResponse };
}

async function createDraftTemplate(req) {
  const tpl = await createLocalDraftRecord({
    workspaceId: req.workspace.id,
    payload: req.body,
  });
  await logWorkspaceActivity({
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    action: "template.draft.created",
    entityType: "template",
    entityId: String(tpl._id),
    metadata: { name: tpl.name, languageCode: tpl.languageCode },
  });
  await ensureVersionBaseline({ template: tpl, user: req.user });
  return { success: true, template: tpl };
}

async function listTemplates(req) {
  const normalizedStatus = String(req.query.status || "").trim().toLowerCase();
  const includeDrafts = !normalizedStatus || normalizedStatus === "draft";
  const workspaceDraftsPromise = includeDrafts
    ? templatesRepository.listDraftTemplates({ workspaceId: req.workspace.id })
    : Promise.resolve([]);
  const connection = await resolveActiveConnection(req.workspace.id);
  if (!connection) {
    const drafts = await workspaceDraftsPromise;
    return {
      success: true,
      templates: sortTemplatesByNewest(drafts),
      metadata: connectionMetadata(null, 0, drafts.length),
    };
  }
  if (!isEmbeddedSignupConnection(connection.doc)) {
    const drafts = await workspaceDraftsPromise;
    return {
      success: true,
      templates: sortTemplatesByNewest(drafts),
      metadata: {
        ...connectionMetadata(connection, 0, drafts.length),
        warning: "This workspace is using a manual/system-user token. Reconnect with Embedded Signup to use customer self-connect.",
      },
    };
  }

  const currentWabaTemplatesPromise =
    normalizedStatus === "draft"
      ? Promise.resolve([])
      : templatesRepository.listTemplates({
          workspaceId: req.workspace.id,
          wabaId: connection.wabaId,
          status: req.query.status,
        });

  const [drafts, templates, staleTemplateCount] = await Promise.all([
    workspaceDraftsPromise,
    currentWabaTemplatesPromise,
    templatesRepository.countHiddenStaleTemplates({ workspaceId: req.workspace.id, wabaId: connection.wabaId }),
  ]);
  const allTemplates = sortTemplatesByNewest([...(drafts || []), ...(templates || [])]);
  return {
    success: true,
    templates: allTemplates,
    metadata: connectionMetadata(connection, staleTemplateCount, allTemplates.length),
  };
}

async function listApprovedTemplates(req) {
  const connection = await resolveActiveConnection(req.workspace.id);
  if (!connection) {
    return { success: true, templates: [], metadata: connectionMetadata(null) };
  }
  const templates = await templatesRepository.listTemplates({
    workspaceId: req.workspace.id,
    wabaId: connection.wabaId,
    status: "approved",
  });
  return {
    success: true,
    templates: templates.map(serializeApprovedTemplate),
    metadata: connectionMetadata(connection, 0, templates.length),
  };
}

async function getTemplate(req) {
  const template = await templatesRepository.getWorkspaceTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!isTemplateVisible(template)) throw new HttpError(404, "Template not found");
  if (isDraftTemplate(template)) {
    return { success: true, template };
  }
  const connection = await requireActiveConnection(req.workspace.id);
  if (String(template.wabaId || "") !== String(connection.wabaId)) {
    throw new HttpError(404, "Template not found for the currently connected WhatsApp account");
  }
  return { success: true, template };
}

async function updateTemplate(req) {
  const workspaceTemplate = await templatesRepository.getWorkspaceTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!isTemplateVisible(workspaceTemplate)) throw new HttpError(404, "Template not found");
  if (isDraftTemplate(workspaceTemplate)) {
    return updateDraftTemplate(req);
  }

  const connection = await requireActiveConnection(req.workspace.id);
  if (String(workspaceTemplate.wabaId || "") !== String(connection.wabaId)) {
    throw new HttpError(404, "Template not found for the currently connected WhatsApp account");
  }
  const existing = workspaceTemplate;

  if (req.body?.category && String(req.body.category).trim().toLowerCase() !== String(existing.category).trim().toLowerCase()) {
    throw new HttpError(400, "Template category cannot be changed after creation");
  }
  if (existing.metaTemplateId) {
    if (req.body?.name && String(req.body.name).trim() !== String(existing.name).trim()) {
      throw new HttpError(400, "Template name cannot be changed after it is linked to Meta");
    }
    if (req.body?.language && String(req.body.language).trim() !== String(existing.language).trim()) {
      throw new HttpError(400, "Template language cannot be changed after it is linked to Meta");
    }
  }

  const previousSnapshot = snapshotTemplate(existing);
  const normalized = normalizeTemplate({ ...existing.toObject(), ...req.body });
  let metaResponse = null;
  if (existing.metaTemplateId) {
    try {
      metaResponse = await submitTemplate({
        accessToken: connection.accessToken,
        wabaId: connection.wabaId,
        template: normalized,
        metaTemplateId: existing.metaTemplateId,
        graphApiVersion: connection.graphApiVersion,
      });
    } catch (err) {
      const message = permissionSubmitMessage(err);
      throw new HttpError(400, message, {
        message,
        metaDebug: err.metaDebug || null,
        tokenDebug: err.tokenDebug || null,
      });
    }
  }

  existing.name = normalized.name;
  existing.language = normalized.language;
  existing.languageCode = normalized.language;
  existing.components = normalized.components;
  if (metaResponse) {
    existing.status = normalizeRemoteStatus(metaResponse?.status || existing.status);
    existing.source = "local";
    existing.syncedAt = new Date();
    existing.lastSyncedAt = new Date();
  }
  const saved = await existing.save();
  await createTemplateVersion({ template: saved, previousSnapshot, user: req.user, action: "updated" });
  return { success: true, template: saved, ...(metaResponse ? { meta: metaResponse } : {}) };
}

async function updateDraftTemplate(req) {
  const existing = await templatesRepository.getDraftTemplate({
    id: req.params.id,
    workspaceId: req.workspace.id,
  });
  if (!existing) throw new HttpError(404, "Draft template not found");

  const normalized = normalizeTemplate({ ...existing.toObject(), ...req.body, source: "local" });
  const languageCode = String(normalized.language || "").trim();
  await ensureTemplateNameLanguageAvailable({
    workspaceId: req.workspace.id,
    name: normalized.name,
    languageCode,
    wabaId: null,
    excludeId: String(existing._id),
  });

  const previousSnapshot = snapshotTemplate(existing);
  existing.name = normalized.name;
  existing.language = normalized.language;
  existing.languageCode = languageCode;
  existing.category = normalized.category;
  existing.components = normalized.components;
  existing.status = "draft";
  existing.source = "local";
  existing.wabaId = null;
  existing.phoneNumberId = null;
  existing.metaTemplateId = undefined;
  existing.rejectedReason = undefined;
  existing.syncedAt = null;
  existing.lastSyncedAt = null;
  existing.staleReason = null;
  existing.isActive = true;

  const saved = await existing.save();
  await logWorkspaceActivity({
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    action: "template.draft.updated",
    entityType: "template",
    entityId: String(saved._id),
    metadata: { name: saved.name, languageCode: saved.languageCode },
  });
  await createTemplateVersion({ template: saved, previousSnapshot, user: req.user, action: "updated" });
  return { success: true, template: saved };
}

async function deleteTemplate(req) {
  const template = await templatesRepository.getWorkspaceTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!isTemplateVisible(template)) throw new HttpError(404, "Template not found");

  if (isDraftTemplate(template)) {
    await templatesRepository.softDeleteTemplate({ id: template._id, workspaceId: req.workspace.id, staleReason: "draft_deleted" });
    await logWorkspaceActivity({
      workspaceId: req.workspace.id,
      actorUserId: req.user?.id || null,
      action: "template.draft.deleted",
      entityType: "template",
      entityId: String(template._id),
      metadata: { name: template.name },
    });
    return { success: true };
  }

  const connection = await requireActiveConnection(req.workspace.id);

  if (String(template.wabaId || "") !== String(connection.wabaId)) {
    await templatesRepository.softDeleteTemplate({
      id: template._id,
      workspaceId: req.workspace.id,
      staleReason: "old_waba_connection",
    });
    return { success: true, warning: "Removed stale local template from previous WhatsApp account." };
  }

  let warning = null;
  if (template.source === "meta" || template.metaTemplateId) {
    try {
      await deleteMessageTemplate({
        accessToken: connection.accessToken,
        wabaId: connection.wabaId,
        templateName: template.name,
        graphApiVersion: connection.graphApiVersion,
      });
    } catch (err) {
      if (!isMetaTemplateNotFound(err)) {
        throw new HttpError(400, "Meta template delete failed", { message: err.message, metaDebug: err.metaDebug || null });
      }
      warning = "Template was not found on Meta, so it was removed locally.";
    }
  }

  await templatesRepository.softDeleteTemplate({ id: template._id, workspaceId: req.workspace.id });
  await logWorkspaceActivity({
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    action: "template.deleted",
    entityType: "template",
    entityId: String(template._id),
    metadata: { name: template.name },
  });
  return { success: true, ...(warning ? { warning } : {}) };
}

async function submitForApproval(req) {
  const workspaceTemplate = await templatesRepository.getWorkspaceTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!isTemplateVisible(workspaceTemplate)) throw new HttpError(404, "Template not found");
  const connection = await requireActiveConnection(req.workspace.id);
  const template = workspaceTemplate;

  if (!isDraftTemplate(template)) {
    if (String(template.wabaId || "") !== String(connection.wabaId)) {
      throw new HttpError(404, "Template not found for the currently connected WhatsApp account");
    }
    assertTemplateBelongsToWaba(template, connection.wabaId);
  } else {
    await ensureTemplateNameLanguageAvailable({
      workspaceId: req.workspace.id,
      name: String(template.name || "").trim(),
      languageCode: String(template.languageCode || template.language || "").trim(),
      wabaId: connection.wabaId,
      excludeId: String(template._id),
    });
  }

  if (String(template.name).trim().toLowerCase() === "hello_world") {
    throw new HttpError(400, "The Meta sample template `hello_world` cannot be submitted/edited. Create a new template with a different name.");
  }
  if (hasLibraryHostedHeaderMedia(template.components)) {
    throw new HttpError(
      400,
      "This template still uses library media. Re-upload the header media from this workspace before submitting to Meta."
    );
  }

  const previousSnapshot = snapshotTemplate(template);
  const normalizedTemplate = normalizeTemplate(template.toObject());
  let apiRes;
  try {
    apiRes = await submitTemplate({
      accessToken: connection.accessToken,
      wabaId: connection.wabaId,
      template: normalizedTemplate,
      metaTemplateId: template.metaTemplateId,
      graphApiVersion: connection.graphApiVersion,
    });
  } catch (err) {
    const message = permissionSubmitMessage(err);
    throw new HttpError(400, message, { message, metaDebug: err.metaDebug || null, tokenDebug: err.tokenDebug || null });
  }

  template.metaTemplateId = apiRes?.id || template.metaTemplateId;
  template.wabaId = connection.wabaId;
  template.phoneNumberId = connection.phoneNumberId;
  template.status = normalizeRemoteStatus(apiRes?.status);
  template.source = "local";
  template.deletedAt = null;
  template.staleReason = null;
  template.isActive = true;
  template.rejectedReason = undefined;
  template.syncedAt = new Date();
  template.lastSyncedAt = new Date();
  await template.save();
  await createTemplateVersion({ template, previousSnapshot, user: req.user, action: "submitted" });
  return { success: true, template, meta: apiRes };
}

async function duplicateTemplate(req) {
  const sourceTemplate = await templatesRepository.getWorkspaceTemplate({
    id: req.params.id,
    workspaceId: req.workspace.id,
  });
  const libraryTemplate = sourceTemplate ? null : await templatesRepository.getPublishedLibraryTemplate({
    id: req.params.id,
  });
  const templateToDuplicate = sourceTemplate || libraryTemplate;
  if (!templateToDuplicate || !isTemplateVisible(templateToDuplicate)) throw new HttpError(404, "Template not found");

  const source = templateToDuplicate.toObject ? templateToDuplicate.toObject() : templateToDuplicate;
  const languageCode = String(source.languageCode || source.language || "en_US").trim();
  const duplicateName = await generateDuplicateDraftName({
    workspaceId: req.workspace.id,
    name: source.name,
    languageCode,
  });
  const duplicate = await createLocalDraftRecord({
    workspaceId: req.workspace.id,
    payload: {
      name: duplicateName,
      language: languageCode,
      category: source.category,
      components: Array.isArray(source.components) ? source.components : [],
      sourceTemplateId: templateToDuplicate._id,
    },
  });

  await logWorkspaceActivity({
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    action: "template.draft.duplicated",
    entityType: "template",
    entityId: String(duplicate._id),
    metadata: {
      sourceTemplateId: String(templateToDuplicate._id),
      sourceName: templateToDuplicate.name,
      sourceOwnerType: templateToDuplicate.ownerType || "workspace",
      name: duplicate.name,
    },
  });
  if (String(templateToDuplicate.ownerType || "") === "system") {
    await incrementLibraryPopularity(templateToDuplicate._id, 1);
    await recordLibraryEvent({
      templateId: templateToDuplicate._id,
      sourceTemplateId: templateToDuplicate._id,
      workspaceId: req.workspace.id,
      actorUserId: req.user?.id || null,
      eventType: "use",
      metadata: { duplicateTemplateId: String(duplicate._id), duplicateName: duplicate.name },
    });
    await recordLibraryEvent({
      templateId: templateToDuplicate._id,
      sourceTemplateId: templateToDuplicate._id,
      workspaceId: req.workspace.id,
      actorUserId: req.user?.id || null,
      eventType: "copy",
      metadata: { duplicateTemplateId: String(duplicate._id), duplicateName: duplicate.name },
    });
  }
  return { success: true, template: duplicate };
}

async function installLibraryTemplatePack(req) {
  const packKey = String(req.params.packKey || "").trim();
  if (!packKey) throw new HttpError(400, "Template pack key is required");
  const sourceTemplates = await templatesRepository.listPublishedLibraryTemplatesByPack({ packKey });
  if (!sourceTemplates.length) throw new HttpError(404, "Template pack not found");

  const createdTemplates = [];
  for (const sourceTemplate of sourceTemplates) {
    const source = sourceTemplate?.toObject ? sourceTemplate.toObject() : sourceTemplate;
    const languageCode = String(source.languageCode || source.language || "en_US").trim();
    const duplicateName = await generateDuplicateDraftName({
      workspaceId: req.workspace.id,
      name: source.name,
      languageCode,
    });
    const duplicate = await createLocalDraftRecord({
      workspaceId: req.workspace.id,
      payload: {
        name: duplicateName,
        language: languageCode,
        category: source.category,
        components: Array.isArray(source.components) ? source.components : [],
        sourceTemplateId: sourceTemplate._id,
      },
    });
    createdTemplates.push(duplicate);
    await incrementLibraryPopularity(sourceTemplate._id, 1);
    await recordLibraryEvent({
      templateId: sourceTemplate._id,
      sourceTemplateId: sourceTemplate._id,
      workspaceId: req.workspace.id,
      actorUserId: req.user?.id || null,
      eventType: "use",
      metadata: { packKey, duplicateTemplateId: String(duplicate._id), duplicateName: duplicate.name, installedViaPack: true },
    });
    await recordLibraryEvent({
      templateId: sourceTemplate._id,
      sourceTemplateId: sourceTemplate._id,
      workspaceId: req.workspace.id,
      actorUserId: req.user?.id || null,
      eventType: "copy",
      metadata: { packKey, duplicateTemplateId: String(duplicate._id), duplicateName: duplicate.name, installedViaPack: true },
    });
    await logWorkspaceActivity({
      workspaceId: req.workspace.id,
      actorUserId: req.user?.id || null,
      action: "template.pack.installed_item",
      entityType: "template",
      entityId: String(duplicate._id),
      metadata: {
        packKey,
        sourceTemplateId: String(sourceTemplate._id),
        sourceName: sourceTemplate.name,
        name: duplicate.name,
      },
    });
  }

  await logWorkspaceActivity({
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    action: "template.pack.installed",
    entityType: "template_pack",
    entityId: packKey,
    metadata: {
      packKey,
      templateCount: createdTemplates.length,
      templateIds: createdTemplates.map((item) => String(item._id)),
    },
  });

  return {
    success: true,
    packKey,
    count: createdTemplates.length,
    templates: createdTemplates,
  };
}

async function favoriteLibraryTemplate(req) {
  const template = await templatesRepository.getPublishedLibraryTemplate({ id: req.params.id });
  if (!template || !isTemplateVisible(template)) throw new HttpError(404, "Library template not found");
  const workspaceId = String(req.workspace.id || "");
  const current = Array.isArray(template.favoriteWorkspaces) ? template.favoriteWorkspaces.map((item) => String(item || "")) : [];
  if (!current.includes(workspaceId)) {
    template.favoriteWorkspaces = [...(template.favoriteWorkspaces || []), req.workspace.id];
    await template.save();
    await recordLibraryEvent({
      templateId: template._id,
      sourceTemplateId: template._id,
      workspaceId: req.workspace.id,
      actorUserId: req.user?.id || null,
      eventType: "favorite",
    });
  }
  return { success: true, favorite: true, templateId: String(template._id) };
}

async function unfavoriteLibraryTemplate(req) {
  const template = await templatesRepository.getPublishedLibraryTemplate({ id: req.params.id });
  if (!template || !isTemplateVisible(template)) throw new HttpError(404, "Library template not found");
  const workspaceId = String(req.workspace.id || "");
  template.favoriteWorkspaces = (Array.isArray(template.favoriteWorkspaces) ? template.favoriteWorkspaces : [])
    .filter((item) => String(item || "") !== workspaceId);
  await template.save();
  await recordLibraryEvent({
    templateId: template._id,
    sourceTemplateId: template._id,
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    eventType: "unfavorite",
  });
  return { success: true, favorite: false, templateId: String(template._id) };
}

async function trackLibraryTemplateEvent(req) {
  const template = await templatesRepository.getPublishedLibraryTemplate({ id: req.params.id });
  if (!template || !isTemplateVisible(template)) throw new HttpError(404, "Library template not found");
  const eventType = String(req.body?.eventType || "").trim().toLowerCase();
  if (!["preview", "copy", "download", "use"].includes(eventType)) {
    throw new HttpError(400, "Unsupported library analytics event");
  }
  await recordLibraryEvent({
    templateId: template._id,
    sourceTemplateId: template._id,
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    eventType,
    metadata: { source: "manual_track" },
  });
  if (eventType === "use" || eventType === "copy") {
    await incrementLibraryPopularity(template._id, 1);
  }
  return { success: true, tracked: eventType, templateId: String(template._id) };
}

async function getLibraryAnalytics(req) {
  return buildLibraryAnalyticsSummary({
    workspaceId: req.workspace.id,
    limit: req.query.limit || 10,
  });
}

async function syncStatus(req) {
  const workspaceTemplate = await templatesRepository.getWorkspaceTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!isTemplateVisible(workspaceTemplate)) throw new HttpError(404, "Template not found");
  if (isDraftTemplate(workspaceTemplate)) {
    throw new HttpError(400, "Draft templates are stored locally and do not have a Meta status yet");
  }
  const connection = await requireActiveConnection(req.workspace.id);
  const template = workspaceTemplate;
  if (String(template.wabaId || "") !== String(connection.wabaId)) {
    throw new HttpError(404, "Template not found for the currently connected WhatsApp account");
  }

  const previousSnapshot = snapshotTemplate(template);
  const remote = await fetchTemplateStatus({
    accessToken: connection.accessToken,
    wabaId: connection.wabaId,
    templateName: template.name,
    metaTemplateId: template.metaTemplateId,
    graphApiVersion: connection.graphApiVersion,
  });
  if (!remote) {
    template.isActive = false;
    template.staleReason = "missing_from_meta";
    await template.save();
    throw new HttpError(404, "Template not found in active Meta WABA. Refresh templates.");
  }

  template.status = normalizeRemoteStatus(remote.status);
  template.rejectedReason = remote.rejected_reason || template.rejectedReason;
  if (Array.isArray(remote.components) && remote.components.length) template.components = remote.components;
  template.syncedAt = new Date();
  template.lastSyncedAt = new Date();
  await template.save();
  await createTemplateVersion({ template, previousSnapshot, user: req.user, action: "synced" });
  return { success: true, template, meta: remote };
}

async function syncMetaTemplates(req) {
  const connection = req.metaConnectionOverride || (await requireActiveConnection(req.workspace.id));
  const exactName = req.body?.name ? String(req.body.name).trim() : undefined;
  let remoteTemplates;
  try {
    remoteTemplates = await fetchAllMessageTemplates({
      accessToken: connection.accessToken,
      wabaId: connection.wabaId,
      graphApiVersion: connection.graphApiVersion,
      exactName,
    });
  } catch (err) {
    throw new HttpError(400, "Failed to fetch Meta templates", { message: err.message, metaDebug: err.metaDebug || null });
  }
  const wabaName = await fetchWabaName({
    accessToken: connection.accessToken,
    wabaId: connection.wabaId,
    graphApiVersion: connection.graphApiVersion,
  }).catch(() => null);
  if (wabaName && wabaName !== connection.wabaName) {
    await connection.doc.updateOne({ $set: { wabaName } });
    connection.wabaName = wabaName;
  }

  const synced = [];
  const activeKeys = [];
  const templateLimitState = await getUsageState({ workspaceId: req.workspace.id, resourceKey: "templates" });
  let currentStoredTemplates = Number(templateLimitState.currentUsage || 0);
  for (const remote of remoteTemplates) {
    const normalized = normalizeRemoteTemplate(remote);
    if (!normalized.name || !normalized.languageCode) continue;
    activeKeys.push({ name: normalized.name, languageCode: normalized.languageCode });

    const existing = await templatesRepository.findTemplateForMetaSync({
      workspaceId: req.workspace.id,
      wabaId: connection.wabaId,
      name: normalized.name,
      languageCode: normalized.languageCode,
    });
    if (existing) {
      Object.assign(existing, normalized, {
        phoneNumberId: connection.phoneNumberId,
        wabaId: connection.wabaId,
      });
      synced.push(await existing.save());
      continue;
    }
    await checkLimit(req.workspace.id, "templates", { currentUsage: currentStoredTemplates });
    synced.push(await templatesRepository.createTemplate({
      workspaceId: req.workspace.id,
      wabaId: connection.wabaId,
      phoneNumberId: connection.phoneNumberId,
      ...normalized,
    }));
    currentStoredTemplates += 1;
  }

  if (!exactName) {
    await templatesRepository.markCurrentWabaTemplatesStaleExcept({
      workspaceId: req.workspace.id,
      wabaId: connection.wabaId,
      activeKeys,
    });
    await templatesRepository.markWorkspaceOldWabaTemplatesStale({
      workspaceId: req.workspace.id,
      activeWabaId: connection.wabaId,
    });
  }

  const [templates, staleTemplateCount] = await Promise.all([
    templatesRepository.listTemplates({ workspaceId: req.workspace.id, wabaId: connection.wabaId }),
    templatesRepository.countHiddenStaleTemplates({ workspaceId: req.workspace.id, wabaId: connection.wabaId }),
  ]);
  return {
    success: true,
    count: templates.length,
    templates,
    metadata: connectionMetadata(connection, staleTemplateCount, templates.length),
  };
}

async function listLibraryTemplates(req) {
  const workspaceId = String(req.workspace?.id || "");
  const templates = await templatesRepository.listPublishedLibraryTemplates({
    q: req.query.q || req.query.search,
    category: req.query.category,
    industry: req.query.industry,
    language: req.query.language,
    tag: req.query.tag,
    sort: req.query.sort,
    limit: req.query.limit || 100,
  });
  return {
    success: true,
    templates: (templates || []).map((template) => {
      const doc = template?.toObject ? template.toObject() : template;
      const bodyComponent = Array.isArray(doc.components)
        ? doc.components.find((component) => String(component?.type || "").toUpperCase() === "BODY")
        : null;
      const description = String(bodyComponent?.text || "").trim().replace(/\s+/g, " ").slice(0, 180) || "";
      const favoriteWorkspaceIds = Array.isArray(doc.favoriteWorkspaces)
        ? doc.favoriteWorkspaces.map((item) => String(item || ""))
        : [];
      return {
        _id: String(doc._id || ""),
        name: doc.name,
        language: doc.languageCode || doc.language || "en_US",
        category: doc.category,
        status: doc.status,
        ownerType: doc.ownerType || "system",
        libraryCategory: doc.libraryCategory || null,
        industry: doc.industry || null,
        templatePackKey: doc.templatePackKey || null,
        templatePackName: doc.templatePackName || null,
        templatePackOrder: Number(doc.templatePackOrder || 0),
        tags: Array.isArray(doc.tags) ? doc.tags : [],
        featured: Boolean(doc.featured),
        thumbnail: doc.thumbnail || null,
        isOfficial: Boolean(doc.isOfficial),
        isFavorite: workspaceId ? favoriteWorkspaceIds.includes(workspaceId) : false,
        popularity: Number(doc.popularity || 0),
        components: Array.isArray(doc.components) ? doc.components : [],
        description,
        sourceTemplateId: doc.sourceTemplateId ? String(doc.sourceTemplateId) : null,
        createdAt: doc.createdAt || null,
        updatedAt: doc.updatedAt || null,
      };
    }),
  };
}

async function listTemplateHistory(req) {
  const template = await templatesRepository.getWorkspaceTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!isTemplateVisible(template)) throw new HttpError(404, "Template not found");
  await ensureVersionBaseline({ template, user: req.user });
  const versions = await TemplateVersion.find({
    workspaceId: req.workspace.id,
    templateId: template._id,
  }).sort({ versionNumber: -1, createdAt: -1 });
  return { success: true, templateId: String(template._id), versions };
}

async function restoreTemplateVersion(req) {
  const template = await templatesRepository.getWorkspaceTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!isTemplateVisible(template)) throw new HttpError(404, "Template not found");
  await ensureVersionBaseline({ template, user: req.user });
  const version = await TemplateVersion.findOne({
    _id: req.params.versionId,
    workspaceId: req.workspace.id,
    templateId: template._id,
  });
  if (!version) throw new HttpError(404, "Template version not found");

  const snapshot = version.snapshot || {};
  const previousSnapshot = snapshotTemplate(template);
  const restoredPayload = {
    ...template.toObject(),
    name: snapshot.name || template.name,
    language: snapshot.language || template.language,
    category: snapshot.category || template.category,
    components: Array.isArray(snapshot.components) ? snapshot.components : template.components,
    source: "local",
  };

  if (isDraftTemplate(template)) {
    const normalized = normalizeTemplate(restoredPayload);
    const languageCode = String(normalized.language || "").trim();
    await ensureTemplateNameLanguageAvailable({
      workspaceId: req.workspace.id,
      name: normalized.name,
      languageCode,
      wabaId: null,
      excludeId: String(template._id),
    });
    template.name = normalized.name;
    template.language = normalized.language;
    template.languageCode = languageCode;
    template.category = normalized.category;
    template.components = normalized.components;
    template.status = "draft";
    template.source = "local";
    template.rejectedReason = undefined;
    template.syncedAt = null;
    template.lastSyncedAt = null;
    template.metaTemplateId = undefined;
    template.wabaId = null;
    template.phoneNumberId = null;
    template.staleReason = null;
    template.isActive = true;
  } else {
    const connection = await requireActiveConnection(req.workspace.id);
    if (String(template.wabaId || "") !== String(connection.wabaId)) {
      throw new HttpError(404, "Template not found for the currently connected WhatsApp account");
    }
    if (template.metaTemplateId) {
      if (snapshot.name && String(snapshot.name).trim() !== String(template.name).trim()) {
        throw new HttpError(400, "This Meta-linked template version cannot restore a different name");
      }
      if (snapshot.language && String(snapshot.language).trim() !== String(template.language).trim()) {
        throw new HttpError(400, "This Meta-linked template version cannot restore a different language");
      }
      if (snapshot.category && String(snapshot.category).trim().toLowerCase() !== String(template.category).trim().toLowerCase()) {
        throw new HttpError(400, "This Meta-linked template version cannot restore a different category");
      }
    }
    const normalized = normalizeTemplate(restoredPayload);
    let metaResponse = null;
    if (template.metaTemplateId) {
      try {
        metaResponse = await submitTemplate({
          accessToken: connection.accessToken,
          wabaId: connection.wabaId,
          template: normalized,
          metaTemplateId: template.metaTemplateId,
          graphApiVersion: connection.graphApiVersion,
        });
      } catch (err) {
        const message = permissionSubmitMessage(err);
        throw new HttpError(400, message, {
          message,
          metaDebug: err.metaDebug || null,
          tokenDebug: err.tokenDebug || null,
        });
      }
    }
    template.name = normalized.name;
    template.language = normalized.language;
    template.languageCode = normalized.language;
    template.category = normalized.category;
    template.components = normalized.components;
    template.status = normalizeRemoteStatus(metaResponse?.status || template.status);
    template.source = "local";
    template.rejectedReason = undefined;
    template.syncedAt = new Date();
    template.lastSyncedAt = new Date();
    template.staleReason = null;
    template.isActive = true;
  }

  const saved = await template.save();
  await createTemplateVersion({ template: saved, previousSnapshot, user: req.user, action: "restored" });
  await logWorkspaceActivity({
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    action: "template.version.restored",
    entityType: "template",
    entityId: String(saved._id),
    metadata: { restoredFromVersion: Number(version.versionNumber || 0), name: saved.name },
  });
  return { success: true, template: saved, restoredFrom: version };
}

module.exports = {
  createTemplate,
  createDraftTemplate,
  deleteTemplate,
  duplicateTemplate,
  favoriteLibraryTemplate,
  getLibraryAnalytics,
  getTemplate,
  installLibraryTemplatePack,
  listLibraryTemplatePacks,
  listLibraryTemplates,
  listTemplateHistory,
  listApprovedTemplates,
  listTemplates,
  restoreTemplateVersion,
  submitForApproval,
  syncMetaTemplates,
  syncStatus,
  trackLibraryTemplateEvent,
  unfavoriteLibraryTemplate,
  updateTemplate,
  updateDraftTemplate,
};
