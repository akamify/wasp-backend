const Joi = require("joi");
const { Template } = require("@infra/database/Template");
const { Workspace } = require("@infra/database/Workspace");
const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const {
  fetchTemplateStatus,
  fetchAllMessageTemplates,
  deleteMessageTemplate,
} = require("@shared/utils/whatsappSender");
const { normalizeTemplate } = require("@shared/utils/templateStructure");

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
  return {
    name: String(remote?.name || "").trim(),
    language: String(remote?.language || "en_US").trim(),
    category: String(remote?.category || "utility").trim().toLowerCase(),
    components: Array.isArray(remote?.components) ? remote.components : [],
    status: normalizeRemoteStatus(remote?.status),
    source: "meta",
    metaTemplateId: remote?.id ? String(remote.id) : undefined,
    rejectedReason: remote?.rejected_reason || undefined,
    lastSyncedAt: new Date(),
  };
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
  const workspace = await ensureWorkspaceForTemplate(template);
  res.json({ success: true, template, workspace });
}

const updateSchema = Joi.object({
  name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).optional(),
  language: Joi.string().min(2).max(20).optional(),
  category: Joi.string().valid("marketing", "utility", "authentication").optional(),
  components: Joi.array().items(Joi.object().unknown(true)).min(1).optional(),
});

async function adminUpdateMasterTemplate(req, res) {
  const payload = await updateSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const existing = await Template.findById(req.params.id);
  if (!existing) throw new HttpError(404, "Template not found");

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
  existing.category = existing.category;
  existing.components = normalized.components;
  const saved = await existing.save();
  res.json({ success: true, template: saved });
}

async function adminDeleteMasterTemplate(req, res) {
  const template = await Template.findById(req.params.id);
  if (!template) throw new HttpError(404, "Template not found");
  const workspace = await ensureWorkspaceForTemplate(template);

  const shouldDeleteOnMeta = template.source === "meta" || !!template.metaTemplateId;
  let metaDelete = null;

  if (shouldDeleteOnMeta) {
    const creds = await getCredentialsForUser(workspace.id);
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

async function adminSyncTemplateStatus(req, res) {
  const template = await Template.findById(req.params.id);
  if (!template) throw new HttpError(404, "Template not found");
  const workspace = await ensureWorkspaceForTemplate(template);
  const creds = await getCredentialsForUser(workspace.id);

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
      $or: [
        ...(normalized.metaTemplateId ? [{ metaTemplateId: normalized.metaTemplateId }] : []),
        { name: normalized.name },
      ],
    });

    if (existing) {
      existing.language = normalized.language;
      existing.category = normalized.category;
      existing.components = normalized.components;
      existing.status = normalized.status;
      existing.source = "meta";
      existing.metaTemplateId = normalized.metaTemplateId || existing.metaTemplateId;
      existing.rejectedReason = normalized.rejectedReason;
      existing.lastSyncedAt = normalized.lastSyncedAt;
      await existing.save();
      synced.push(existing);
      continue;
    }

    const created = await Template.create({
      workspaceId: String(workspace._id),
      ...normalized,
    });
    synced.push(created);
  }

  res.json({ success: true, count: synced.length, templates: synced });
}

module.exports = {
  adminGetMasterTemplate,
  adminUpdateMasterTemplate,
  adminDeleteMasterTemplate,
  adminSyncTemplateStatus,
  adminSyncMetaTemplates,
};


