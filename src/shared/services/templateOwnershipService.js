const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { Template } = require("@infra/database/Template");

function normalizeWabaId(value) {
  return String(value || "").trim();
}

function assertTemplateBelongsToWaba(template, wabaId) {
  const currentWabaId = normalizeWabaId(wabaId);
  const templateWabaId = normalizeWabaId(template?.wabaId);
  if (!currentWabaId || !templateWabaId || templateWabaId !== currentWabaId) {
    // eslint-disable-next-line no-console
    console.warn("[templates] send rejected template not in active WABA", {
      workspaceId: template?.workspaceId ? String(template.workspaceId) : null,
    });
    throw new HttpError(
      400,
      "This template belongs to a previous WhatsApp account. Refresh templates for the current account."
    );
  }
}

async function assertTemplateBelongsToCurrentWaba({ template, workspaceId }) {
  const creds = await getCredentialsForUser(workspaceId);
  assertTemplateBelongsToWaba(template, creds.wabaId);
  return creds;
}

async function stampUntaggedTemplatesForWaba({ workspaceId, wabaId }) {
  const normalizedWabaId = normalizeWabaId(wabaId);
  if (!workspaceId || !normalizedWabaId) return;
  await Template.updateMany(
    { workspaceId, wabaId: null },
    { $set: { wabaId: normalizedWabaId } }
  );
}

async function markTemplatesStaleForInactiveWabas({ workspaceId, activeWabaId }) {
  await Template.updateMany(
    { workspaceId, wabaId: { $ne: normalizeWabaId(activeWabaId) } },
    { $set: { isActive: false, staleReason: "old_waba_connection" } }
  );
}

module.exports = {
  assertTemplateBelongsToCurrentWaba,
  assertTemplateBelongsToWaba,
  normalizeWabaId,
  markTemplatesStaleForInactiveWabas,
  stampUntaggedTemplatesForWaba,
};
