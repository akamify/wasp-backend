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
    throw new HttpError(
      409,
      "Template belongs to a different WhatsApp account. Sync templates for the currently connected account."
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

module.exports = {
  assertTemplateBelongsToCurrentWaba,
  assertTemplateBelongsToWaba,
  normalizeWabaId,
  stampUntaggedTemplatesForWaba,
};
