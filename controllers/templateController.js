const { Template } = require("../models/Template");
const { HttpError } = require("../utils/httpError");
const { getCredentialsForUser } = require("../services/credentialsService");
const {
  submitTemplate,
  fetchTemplateStatus,
  fetchAllMessageTemplates,
  deleteMessageTemplate,
} = require("../utils/whatsappSender");
const { normalizeTemplate } = require("../utils/templateStructure");

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

async function createTemplate(req, res) {
  const normalized = normalizeTemplate({ ...req.body, source: "local" });
  const creds = await getCredentialsForUser(req.workspace.id);

  let metaResponse;
  try {
    metaResponse = await submitTemplate({
      accessToken: creds.accessToken,
      wabaId: creds.wabaId,
      template: normalized,
      graphApiVersion: creds.graphApiVersion,
    });
  } catch (err) {
    throw new HttpError(400, "Template submission failed", {
      message: err.message,
      metaDebug: err.metaDebug || null,
    });
  }

  const tpl = await Template.create({
    ...normalized,
    workspaceId: req.workspace.id,
    source: "local",
    metaTemplateId: metaResponse?.id || undefined,
    status: normalizeRemoteStatus(metaResponse?.status),
    lastSyncedAt: new Date(),
  });
  res.status(201).json({ success: true, template: tpl, meta: metaResponse });
}

async function listTemplates(req, res) {
  const filter = { workspaceId: req.workspace.id };
  if (req.query.status) filter.status = req.query.status;
  const templates = await Template.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, templates });
}

async function getTemplate(req, res) {
  const template = await Template.findOne({ _id: req.params.id, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  res.json({ success: true, template });
}

async function updateTemplate(req, res) {
  const existing = await Template.findOne({ _id: req.params.id, workspaceId: req.workspace.id });
  if (!existing) throw new HttpError(404, "Template not found");

  const normalized = normalizeTemplate({
    ...existing.toObject(),
    ...req.body,
  });

  existing.name = normalized.name;
  existing.language = normalized.language;
  existing.category = normalized.category;
  existing.components = normalized.components;
  const template = await existing.save();
  res.json({ success: true, template });
}

async function deleteTemplate(req, res) {
  const template = await Template.findOne({ _id: req.params.id, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");

  const shouldDeleteOnMeta = template.source === "meta" || !!template.metaTemplateId;
  let metaDelete = null;

  if (shouldDeleteOnMeta) {
    const creds = await getCredentialsForUser(req.workspace.id);
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

  await Template.deleteOne({ _id: req.params.id, workspaceId: req.workspace.id });
  res.json({ success: true, meta: metaDelete });
}

async function submitForApproval(req, res) {
  const template = await Template.findOne({ _id: req.params.id, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");

  const creds = await getCredentialsForUser(req.workspace.id);
  const normalizedTemplate = normalizeTemplate(template.toObject());

  template.name = normalizedTemplate.name;
  template.language = normalizedTemplate.language;
  template.category = normalizedTemplate.category;
  template.components = normalizedTemplate.components;

  let apiRes;
  try {
    apiRes = await submitTemplate({
      accessToken: creds.accessToken,
      wabaId: creds.wabaId,
      template: normalizedTemplate,
      graphApiVersion: creds.graphApiVersion,
    });
  } catch (err) {
    throw new HttpError(400, "Template submission failed", {
      message: err.message,
      metaDebug: err.metaDebug || null,
    });
  }

  const remoteStatus = normalizeRemoteStatus(apiRes?.status);

  template.metaTemplateId = apiRes?.id || template.metaTemplateId;
  template.status = remoteStatus;
  template.source = "local";
  template.lastSyncedAt = new Date();
  await template.save();

  res.json({ success: true, template, meta: apiRes });
}

async function syncStatus(req, res) {
  const template = await Template.findOne({ _id: req.params.id, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");

  const creds = await getCredentialsForUser(req.workspace.id);

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

  if (!remote) {
    throw new HttpError(404, "Template not found in Meta account (by name)");
  }

  template.status = normalizeRemoteStatus(remote.status);
  template.rejectedReason = remote.rejected_reason || template.rejectedReason;
  if (Array.isArray(remote.components) && remote.components.length > 0) {
    template.components = remote.components;
  }
  template.lastSyncedAt = new Date();
  await template.save();

  res.json({ success: true, template, meta: remote });
}

async function syncMetaTemplates(req, res) {
  const creds = await getCredentialsForUser(req.workspace.id);
  const exactName = req.body?.name ? String(req.body.name).trim() : undefined;

  let remoteTemplates;
  try {
    remoteTemplates = await fetchAllMessageTemplates({
      accessToken: creds.accessToken,
      wabaId: creds.wabaId,
      graphApiVersion: creds.graphApiVersion,
      exactName,
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
      workspaceId: req.workspace.id,
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
      workspaceId: req.workspace.id,
      ...normalized,
    });
    synced.push(created);
  }

  res.json({ success: true, count: synced.length, templates: synced });
}

module.exports = {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  submitForApproval,
  syncStatus,
  syncMetaTemplates,
};
