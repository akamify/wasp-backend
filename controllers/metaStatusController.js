const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { decryptString } = require("../utils/crypto");

function mask(value) {
  const s = String(value || "");
  if (s.length <= 6) return "***";
  return `${s.slice(0, 2)}***${s.slice(-3)}`;
}

async function metaStatus(req, res) {
  const doc = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id }).select(
    "+phoneNumberIdEnc +businessAccountIdEnc graphApiVersion isValid lastValidatedAt createdAt updatedAt"
  );

  if (!doc) {
    return res.json({
      success: true,
      status: "disconnected",
      credentials: null,
    });
  }

  const phoneNumberId = decryptString(doc.phoneNumberIdEnc);
  const businessAccountId = decryptString(doc.businessAccountIdEnc);

  return res.json({
    success: true,
    status: doc.isValid ? "active" : "pending",
    credentials: {
      id: String(doc._id),
      phoneNumberId: mask(phoneNumberId),
      businessAccountId: mask(businessAccountId),
      graphApiVersion: doc.graphApiVersion,
      isValid: doc.isValid,
      lastValidatedAt: doc.lastValidatedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    },
  });
}

module.exports = { metaStatus };

