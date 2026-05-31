require("module-alias/register");

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Template } = require("@infra/database/Template");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { assertTemplateBelongsToWaba } = require("@shared/services/templateOwnershipService");

function hasUniqueIndex(model, expectedFields, partialFilterExpression) {
  return model.schema.indexes().some(([fields, options]) => {
    const sameFields = JSON.stringify(fields) === JSON.stringify(expectedFields);
    const samePartial = partialFilterExpression
      ? JSON.stringify(options.partialFilterExpression) === JSON.stringify(partialFilterExpression)
      : true;
    return sameFields && options.unique === true && samePartial;
  });
}

assert(hasUniqueIndex(Template, { workspaceId: 1, wabaId: 1, name: 1, languageCode: 1 }));
assert(hasUniqueIndex(
  WhatsAppCredentials,
  { workspaceId: 1, isActive: 1 },
  { isActive: true }
));

for (const field of ["workspaceId", "wabaId", "phoneNumberId", "name", "languageCode", "category", "status", "components", "metaTemplateId", "isActive", "syncedAt", "deletedAt", "source"]) {
  assert(Template.schema.path(field), `Template field missing: ${field}`);
}

assert.doesNotThrow(() => assertTemplateBelongsToWaba({ workspaceId: "workspace-a", wabaId: "waba-b" }, "waba-b"));
assert.throws(
  () => assertTemplateBelongsToWaba({ workspaceId: "workspace-a", wabaId: "waba-a" }, "waba-b"),
  /previous WhatsApp account/
);

const root = path.resolve(__dirname, "..");
const routes = fs.readFileSync(path.join(root, "src/core/routes/whatsappIntegrationRoutes.js"), "utf8");
const sender = fs.readFileSync(path.join(root, "src/shared/services/whatsapp/whatsappSender.js"), "utf8");
const templatesService = fs.readFileSync(path.join(root, "src/modules/templates/services/templates.service.js"), "utf8");
const metadataService = fs.readFileSync(path.join(root, "src/shared/services/whatsappConnectionMetadataService.js"), "utf8");
const embeddedSignup = fs.readFileSync(path.join(root, "src/modules/meta/controllers/metaEmbeddedSignup.controller.js"), "utf8");
const outboundMessageService = fs.readFileSync(path.join(root, "src/shared/services/outboundMessageService.js"), "utf8");
assert(routes.includes('"/templates/refresh"'));
assert(routes.includes('"/connection/refresh-metadata"'));
assert(sender.includes("Meta token is missing business_management."));
assert(sender.includes("whatsapp_business_manage_events"));
assert(templatesService.includes('staleReason: "old_waba_connection"'));
assert(templatesService.includes("Removed stale local template from previous WhatsApp account."));
assert(templatesService.includes("meta template not found -> local cleanup"));
assert(templatesService.includes("Template was not found on Meta, so it was removed locally."));
assert(templatesService.includes("subcode === 2593002"));
assert(templatesService.includes("active WABA template filter applied"));
for (const field of ["wabaName", "displayPhoneNumber", "verifiedName", "nameStatus", "qualityRating", "codeVerificationStatus", "platformType", "accountMode", "throughput", "messagingLimitTier", "businessProfile.about", "lastMetadataSyncAt", "metadataFetchStatus", "metadataWarnings"]) {
  assert(WhatsAppCredentials.schema.path(field), `WhatsApp metadata field missing: ${field}`);
}
assert(metadataService.includes("phone_list_extended"));
assert(metadataService.includes("phone_list_minimal"));
assert(metadataService.includes("pending_verification"));
assert(metadataService.includes("pending_display_name_review"));
assert(metadataService.includes("metadata_partial"));
assert(metadataService.includes("[whatsapp-metadata] metadata refresh complete"));
assert(embeddedSignup.includes("refreshWhatsAppConnectionMetadata(workspaceId)"));
assert(outboundMessageService.includes("code === 133010"));
assert(outboundMessageService.includes("This phone number is connected but not registered on WhatsApp Cloud API yet."));

console.log("TEMPLATE_WABA_SCOPING_OK");
