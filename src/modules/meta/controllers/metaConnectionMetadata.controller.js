const { HttpError } = require("@shared/utils/httpError");
const {
  refreshWhatsAppConnectionMetadata,
  serializeWhatsAppConnection,
} = require("@shared/services/whatsappConnectionMetadataService");

async function refreshConnectionMetadata(req, res) {
  const connection = await refreshWhatsAppConnectionMetadata(req.workspace.id);
  if (!connection) throw new HttpError(404, "Active WhatsApp connection not configured");
  return res.json({
    success: true,
    connection: serializeWhatsAppConnection(connection),
  });
}

module.exports = { refreshConnectionMetadata };
