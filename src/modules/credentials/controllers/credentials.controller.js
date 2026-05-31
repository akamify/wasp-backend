const { metaGraphVersion } = require("@core/config/env");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { encryptString, decryptString } = require("@shared/utils/crypto");
const { hashForLookup } = require("@shared/utils/hash");
const { HttpError } = require("@shared/utils/httpError");
const { validateCredentials } = require("@shared/utils/whatsappSender");
const { stampUntaggedTemplatesForWaba } = require("@shared/services/templateOwnershipService");

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
  const { accessToken, phoneNumberId, businessAccountId, wabaId, graphApiVersion, override, overrideReason } = req.body;

  const businessId = wabaId || businessAccountId;

  const existing = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id }).select(
    "+phoneNumberIdEnc +businessAccountIdEnc isValid"
  );
  let currentWabaId = "";

  if (existing?.isValid && existing?.phoneNumberIdEnc && existing?.businessAccountIdEnc) {
    const currentPhoneNumberId = decryptString(existing.phoneNumberIdEnc);
    currentWabaId = decryptString(existing.businessAccountIdEnc);

    const isChangingIds = currentPhoneNumberId !== phoneNumberId || currentWabaId !== businessId;

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
      wabaId: businessId,
      graphApiVersion: graphApiVersion || metaGraphVersion,
    });
    await stampUntaggedTemplatesForWaba({ workspaceId: req.workspace.id, wabaId: currentWabaId });

    const doc = await WhatsAppCredentials.findOneAndUpdate(
      { workspaceId: req.workspace.id },
      {
        $set: {
          accessTokenEnc: encryptString(accessToken),
          phoneNumberIdEnc: encryptString(phoneNumberId),
          businessAccountIdEnc: encryptString(businessId),
          phoneNumberIdHash: hashForLookup(phoneNumberId),
          businessAccountIdHash: hashForLookup(businessId),
          phoneNumberIdPlain: String(phoneNumberId),
          businessAccountIdPlain: String(businessId),
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
  throw new HttpError(
    403,
    "Disconnect is disabled for safety. This workspace can only edit credentials with an override reason."
  );
}

module.exports = { upsertCredentials, getCredentials, deleteCredentials };
