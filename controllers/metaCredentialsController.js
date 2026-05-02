const { metaGraphVersion } = require("../config/env");
const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { encryptString, decryptString } = require("../utils/crypto");
const { hashForLookup } = require("../utils/hash");
const { HttpError } = require("../utils/httpError");
const { validateCredentials } = require("../utils/whatsappSender");

async function saveMetaCredentials(req, res) {
  const { accessToken, phoneNumberId, wabaId, graphApiVersion, override, overrideReason } = req.body;

  const existing = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id }).select(
    "+phoneNumberIdEnc +businessAccountIdEnc isValid"
  );

  if (existing?.isValid && existing?.phoneNumberIdEnc && existing?.businessAccountIdEnc) {
    const currentPhoneNumberId = decryptString(existing.phoneNumberIdEnc);
    const currentWabaId = decryptString(existing.businessAccountIdEnc);

    const isChangingIds = currentPhoneNumberId !== phoneNumberId || currentWabaId !== wabaId;

    if (isChangingIds) {
      if (!override || !String(overrideReason || "").trim() || String(overrideReason || "").trim().length < 10) {
        throw new HttpError(409, "Workspace already has a connected WABA. Disconnect is disabled; editing requires override.", {
          requiresOverride: true,
          hint: "Pass override=true and a meaningful overrideReason (min 10 chars) to change phoneNumberId/wabaId.",
        });
      }
    }
  }

  try {
    const validationResult = await validateCredentials({
      accessToken,
      phoneNumberId,
      wabaId,
      graphApiVersion: graphApiVersion || metaGraphVersion,
    });

    const doc = await WhatsAppCredentials.findOneAndUpdate(
      { workspaceId: req.workspace.id },
      {
        $set: {
          accessTokenEnc: encryptString(accessToken),
          phoneNumberIdEnc: encryptString(phoneNumberId),
          businessAccountIdEnc: encryptString(wabaId),
          phoneNumberIdHash: hashForLookup(phoneNumberId),
          businessAccountIdHash: hashForLookup(wabaId),
          graphApiVersion: graphApiVersion || metaGraphVersion,
          isValid: true,
          lastValidatedAt: new Date(),
          lastEditedAt: new Date(),
          lastEditedBy: req.user?.id || null,
          lastEditedReason: String(overrideReason || "").trim() || null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      validation: validationResult,
      credentialsId: String(doc._id),
    });
  } catch (err) {
    throw new HttpError(400, "Failed to save Meta credentials", {
      message: err.message,
      metaDebug: err.metaDebug || null,
    });
  }
}

module.exports = { saveMetaCredentials };

