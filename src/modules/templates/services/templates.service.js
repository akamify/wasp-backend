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
const { templatesRepository } = require("@modules/templates/repositories/index");
const { enforceMonthlyLimit } = require("@modules/billing/services/usageLimit.service");
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

async function requireActiveConnection(workspaceId) {
  const connection = await resolveActiveConnection(workspaceId);
  if (!connection) throw new HttpError(400, "Active WhatsApp connection not configured");
  if (!isEmbeddedSignupConnection(connection.doc)) {
    throw new HttpError(409, "This workspace is using a manual/system-user token. Reconnect with Embedded Signup to use customer self-connect.");
  }
  return connection;
}

async function createTemplate(req) {
  await enforceMonthlyLimit({
    workspaceId: req.workspace.id,
    limitKey: "maxTemplates",
    errorMessage: "Monthly template create limit reached for your current plan",
    countInWindow: (start, end) =>
      templatesRepository.countTemplatesCreatedBetween({ workspaceId: req.workspace.id, start, end }),
  });

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

  return { success: true, template: tpl, meta: metaResponse };
}

async function listTemplates(req) {
  const connection = await resolveActiveConnection(req.workspace.id);
  if (!connection) {
    return { success: true, templates: [], metadata: connectionMetadata(null) };
  }
  if (!isEmbeddedSignupConnection(connection.doc)) {
    return {
      success: true,
      templates: [],
      metadata: {
        ...connectionMetadata(connection, 0, 0),
        warning: "This workspace is using a manual/system-user token. Reconnect with Embedded Signup to use customer self-connect.",
      },
    };
  }

  const [templates, staleTemplateCount] = await Promise.all([
    templatesRepository.listTemplates({
      workspaceId: req.workspace.id,
      wabaId: connection.wabaId,
      status: req.query.status,
    }),
    templatesRepository.countHiddenStaleTemplates({ workspaceId: req.workspace.id, wabaId: connection.wabaId }),
  ]);
  if (staleTemplateCount > 0) {
  }
  return {
    success: true,
    templates,
    metadata: connectionMetadata(connection, staleTemplateCount, templates.length),
  };
}

async function getTemplate(req) {
  const connection = await requireActiveConnection(req.workspace.id);
  const template = await templatesRepository.getTemplate({
    id: req.params.id,
    workspaceId: req.workspace.id,
    wabaId: connection.wabaId,
  });
  if (!template) throw new HttpError(404, "Template not found for the currently connected WhatsApp account");
  return { success: true, template };
}

async function updateTemplate(req) {
  const connection = await requireActiveConnection(req.workspace.id);
  const existing = await templatesRepository.getTemplate({
    id: req.params.id,
    workspaceId: req.workspace.id,
    wabaId: connection.wabaId,
  });
  if (!existing) throw new HttpError(404, "Template not found for the currently connected WhatsApp account");

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

  const normalized = normalizeTemplate({ ...existing.toObject(), ...req.body });
  existing.name = normalized.name;
  existing.language = normalized.language;
  existing.languageCode = normalized.language;
  existing.components = normalized.components;
  return { success: true, template: await existing.save() };
}

async function deleteTemplate(req) {
  const connection = await requireActiveConnection(req.workspace.id);
  const template = await templatesRepository.getWorkspaceTemplate({ id: req.params.id, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");

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
  const connection = await requireActiveConnection(req.workspace.id);
  const template = await templatesRepository.getTemplate({
    id: req.params.id,
    workspaceId: req.workspace.id,
    wabaId: connection.wabaId,
  });
  if (!template) throw new HttpError(404, "Template not found for the currently connected WhatsApp account");
  assertTemplateBelongsToWaba(template, connection.wabaId);

  if (String(template.name).trim().toLowerCase() === "hello_world") {
    throw new HttpError(400, "The Meta sample template `hello_world` cannot be submitted/edited. Create a new template with a different name.");
  }

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
  template.status = normalizeRemoteStatus(apiRes?.status);
  template.source = "local";
  template.syncedAt = new Date();
  template.lastSyncedAt = new Date();
  await template.save();
  return { success: true, template, meta: apiRes };
}

async function syncStatus(req) {
  const connection = await requireActiveConnection(req.workspace.id);
  const template = await templatesRepository.getTemplate({
    id: req.params.id,
    workspaceId: req.workspace.id,
    wabaId: connection.wabaId,
  });
  if (!template) throw new HttpError(404, "Template not found for the currently connected WhatsApp account");

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
  return { success: true, template, meta: remote };
}

async function syncMetaTemplates(req) {
  const connection = await requireActiveConnection(req.workspace.id);
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
    synced.push(await templatesRepository.createTemplate({
      workspaceId: req.workspace.id,
      wabaId: connection.wabaId,
      phoneNumberId: connection.phoneNumberId,
      ...normalized,
    }));
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

module.exports = {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  submitForApproval,
  syncMetaTemplates,
  syncStatus,
  updateTemplate,
};
