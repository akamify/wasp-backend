const { Contact } = require("@infra/database/Contact");
const { HttpError } = require("@shared/utils/httpError");

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeOptionalString(value) {
  if (value === undefined) return undefined;
  const trimmed = String(value || "").trim();
  return trimmed || "";
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return undefined;

  return Array.from(
    new Set(
      tags
        .map((tag) => String(tag || "").trim())
        .filter(Boolean)
    )
  );
}

function buildContactUpdate(patch = {}) {
  const $set = {};
  const $unset = {};

  const name = normalizeOptionalString(patch.name);
  if (name !== undefined) {
    if (name) $set.name = name;
    else $unset.name = 1;
  }

  const email = normalizeOptionalString(patch.email);
  if (email !== undefined) {
    if (email) $set.email = email.toLowerCase();
    else $unset.email = 1;
  }

  const company = normalizeOptionalString(patch.company);
  if (company !== undefined) {
    if (company) $set.company = company;
    else $unset.company = 1;
  }

  const notes = normalizeOptionalString(patch.notes);
  if (notes !== undefined) {
    if (notes) $set.notes = notes;
    else $unset.notes = 1;
  }

  const tags = normalizeTags(patch.tags);
  if (tags !== undefined) {
    $set.tags = tags;
  }

  if (patch.lastMessagePreview !== undefined) {
    const preview = normalizeOptionalString(patch.lastMessagePreview);
    if (preview) $set.lastMessagePreview = preview;
  }

  if (patch.lastInboundAt) {
    $set.lastInboundAt = patch.lastInboundAt;
  }

  if (patch.lastOutboundAt) {
    $set.lastOutboundAt = patch.lastOutboundAt;
  }

  const update = {};
  if (Object.keys($set).length > 0) update.$set = $set;
  if (Object.keys($unset).length > 0) update.$unset = $unset;
  return update;
}

function assertNormalizedPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || normalizedPhone.length < 8) {
    throw new HttpError(400, "A valid phone number is required");
  }
  return normalizedPhone;
}

async function upsertContactForUser({ userId, phone, patch = {}, createIfMissing = true }) {
  const normalizedPhone = assertNormalizedPhone(phone);
  const update = buildContactUpdate(patch);

  if (createIfMissing) {
    update.$setOnInsert = {
      workspaceId: userId,
      phone: normalizedPhone,
      source: patch.source || "manual",
    };
  } else if (patch.source) {
    update.$set = { ...(update.$set || {}), source: patch.source };
  }

  return Contact.findOneAndUpdate({ workspaceId: userId, phone: normalizedPhone }, update, {
    upsert: createIfMissing,
    returnDocument: "after",
    setDefaultsOnInsert: false,
  });
}

async function touchContactFromMessage({ userId, phone, direction, preview, occurredAt, name }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const patch = {
    ...(name ? { name } : {}),
    lastMessagePreview: preview || "",
    source: direction === "inbound" ? "inbound" : "outbound",
    ...(direction === "inbound"
      ? { lastInboundAt: occurredAt || new Date() }
      : { lastOutboundAt: occurredAt || new Date() }),
  };

  return upsertContactForUser({
    userId,
    phone: normalizedPhone,
    patch,
    createIfMissing: true,
  });
}

module.exports = {
  normalizePhone,
  assertNormalizedPhone,
  upsertContactForUser,
  touchContactFromMessage,
};
