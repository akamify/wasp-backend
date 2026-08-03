const { refreshWhatsAppConnectionMetadata } = require("@shared/services/whatsappConnectionMetadataService");

async function syncConnectionMetadata(workspaceId, options = {}) {
  return refreshWhatsAppConnectionMetadata(workspaceId, options);
}

module.exports = { syncConnectionMetadata };
