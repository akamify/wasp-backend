const { metaGraphVersion } = require("../config/env");
const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { encryptString } = require("../utils/crypto");
const { hashForLookup } = require("../utils/hash");
const { HttpError } = require("../utils/httpError");
const { validateCredentials } = require("../utils/whatsappSender");

async function saveMetaCredentials(req, res) {
  const { accessToken, phoneNumberId, wabaId, graphApiVersion } = req.body;

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

