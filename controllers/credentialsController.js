const { metaGraphVersion } = require("../config/env");
const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { encryptString, decryptString } = require("../utils/crypto");
const { hashForLookup } = require("../utils/hash");
const { HttpError } = require("../utils/httpError");
const { validateCredentials } = require("../utils/whatsappSender");

function mask(value) {
  const s = String(value || "");
  if (s.length <= 6) return "***";
  return `${s.slice(0, 2)}***${s.slice(-3)}`;
}

function buildValidationDetails(err) {
  return {
    message: err.message,
    metaDebug: err.metaDebug || null,
    validationSteps: err.validationSteps || [],
  };
}

async function upsertCredentials(req, res) {
  const { accessToken, phoneNumberId, businessAccountId, wabaId, graphApiVersion } = req.body;

  const businessId = wabaId || businessAccountId;

  try {
    const validationResult = await validateCredentials({
      accessToken,
      phoneNumberId,
      wabaId: businessId,
      graphApiVersion: graphApiVersion || metaGraphVersion,
    });

    const doc = await WhatsAppCredentials.findOneAndUpdate(
      { workspaceId: req.workspace.id },
      {
        $set: {
          accessTokenEnc: encryptString(accessToken),
          phoneNumberIdEnc: encryptString(phoneNumberId),
          businessAccountIdEnc: encryptString(businessId),
          phoneNumberIdHash: hashForLookup(phoneNumberId),
          businessAccountIdHash: hashForLookup(businessId),
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
      credentials: {
        id: doc._id,
        phoneNumberId: mask(phoneNumberId),
        businessAccountId: mask(businessId),
        graphApiVersion: doc.graphApiVersion,
        isValid: doc.isValid,
        lastValidatedAt: doc.lastValidatedAt,
      },
    });
  } catch (err) {
    throw new HttpError(
      400,
      "WhatsApp credential validation failed",
      buildValidationDetails(err)
    );
  }
}

async function getCredentials(req, res) {
  const doc = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id }).select(
    "+phoneNumberIdEnc +businessAccountIdEnc graphApiVersion isValid lastValidatedAt createdAt updatedAt"
  );
  if (!doc) throw new HttpError(404, "WhatsApp credentials not found");

  const phoneNumberId = decryptString(doc.phoneNumberIdEnc);
  const businessAccountId = decryptString(doc.businessAccountIdEnc);

  res.json({
    success: true,
    credentials: {
      id: doc._id,
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

async function deleteCredentials(req, res) {
  await WhatsAppCredentials.deleteOne({ workspaceId: req.workspace.id });
  res.json({ success: true });
}

module.exports = { upsertCredentials, getCredentials, deleteCredentials };
