const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const {
  submitTemplate,
  fetchTemplateStatus,
  fetchAllMessageTemplates,
  deleteMessageTemplate,
} = require("@shared/utils/whatsappSender");
const { normalizeTemplate } = require("@shared/utils/templateStructure");
const { templatesRepository } = require("@modules/templates/repositories/index");

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

async function createTemplate(req) {
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
      tokenDebug: err.tokenDebug || null,
      providerError: err.providerError || null,
    });
  }

  const tpl = await templatesRepository.createTemplate({
    ...normalized,
    workspaceId: req.workspace.id,
    source: "local",
    metaTemplateId: metaResponse?.id || undefined,
    status: normalizeRemoteStatus(metaResponse?.status),
    lastSyncedAt: new Date(),
  });

  return { success: true, template: tpl, meta: metaResponse };
}

async function listTemplates(req) {
  const filter = { workspaceId: req.workspace.id };
  if (req.query.status) filter.status = req.query.status;
  const templates = await templatesRepository.listTemplates(filter);
  return { success: true, templates };
}

async function getTemplate(req) {
  const template = await templatesRepository.getTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  return { success: true, template };
}

async function updateTemplate(req) {
  const existing = await templatesRepository.getTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!existing) throw new HttpError(404, "Template not found");

  if (
    req.body?.category &&
    String(req.body.category).trim().toLowerCase() !== String(existing.category || "").trim().toLowerCase()
  ) {
    throw new HttpError(400, "Template category cannot be changed after creation");
  }

  if (existing.metaTemplateId) {
    if (req.body?.name && String(req.body.name).trim() !== String(existing.name || "").trim()) {
      throw new HttpError(400, "Template name cannot be changed after it is linked to Meta");
    }
    if (req.body?.language && String(req.body.language).trim() !== String(existing.language || "").trim()) {
      throw new HttpError(400, "Template language cannot be changed after it is linked to Meta");
    }
  }

  const normalized = normalizeTemplate({ ...existing.toObject(), ...req.body });
  existing.name = normalized.name;
  existing.language = normalized.language;
  existing.category = existing.category;
  existing.components = normalized.components;
  const template = await existing.save();
  return { success: true, template };
}

async function deleteTemplate(req) {
  const template = await templatesRepository.getTemplate({ id: req.params.id, workspaceId: req.workspace.id });
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
      throw new HttpError(400, "Meta template delete failed", { message: err.message, metaDebug: err.metaDebug || null });
    }
  }

  await templatesRepository.deleteTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  return { success: true, meta: metaDelete };
}

async function submitForApproval(req) {
  const template = await templatesRepository.getTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");

  if (String(template.name || "").trim().toLowerCase() === "hello_world") {
    throw new HttpError(
      400,
      "The Meta sample template `hello_world` cannot be submitted/edited. Create a new template with a different name."
    );
  }

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
      metaTemplateId: template.metaTemplateId,
      graphApiVersion: creds.graphApiVersion,
    });
  } catch (err) {
    throw new HttpError(400, "Template submission failed", { message: err.message, metaDebug: err.metaDebug || null });
  }

  const remoteStatus = normalizeRemoteStatus(apiRes?.status);
  template.metaTemplateId = apiRes?.id || template.metaTemplateId;
  template.status = remoteStatus;
  template.source = "local";
  template.lastSyncedAt = new Date();
  await template.save();

  return { success: true, template, meta: apiRes };
}

async function syncStatus(req) {
  const template = await templatesRepository.getTemplate({ id: req.params.id, workspaceId: req.workspace.id });
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
    throw new HttpError(400, "Failed to fetch template status", { message: err.message, metaDebug: err.metaDebug || null });
  }

  if (!remote) throw new HttpError(404, "Template not found in Meta account (by name)");

  template.status = normalizeRemoteStatus(remote.status);
  template.rejectedReason = remote.rejected_reason || template.rejectedReason;
  if (Array.isArray(remote.components) && remote.components.length > 0) template.components = remote.components;
  template.lastSyncedAt = new Date();
  await template.save();

  return { success: true, template, meta: remote };
}

async function syncMetaTemplates(req) {
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
    throw new HttpError(400, "Failed to fetch Meta templates", { message: err.message, metaDebug: err.metaDebug || null });
  }

  const synced = [];
  for (const remote of remoteTemplates) {
    const normalized = normalizeRemoteTemplate(remote);
    if (!normalized.name) continue;

    const existing = await templatesRepository.findTemplateForMetaSync({
      workspaceId: req.workspace.id,
      name: normalized.name,
      metaTemplateId: normalized.metaTemplateId,
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

    const created = await templatesRepository.createTemplate({ workspaceId: req.workspace.id, ...normalized });
    synced.push(created);
  }

  return { success: true, count: synced.length, templates: synced };
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


