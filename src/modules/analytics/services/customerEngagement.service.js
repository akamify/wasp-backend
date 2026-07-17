const crypto = require("crypto");
const mongoose = require("mongoose");
const { Message } = require("@infra/database/Message");
const { Contact } = require("@infra/database/Contact");
const { ClickLog } = require("@infra/database/ClickLog");
const { ConversionEvent } = require("@infra/database/ConversionEvent");
const { normalizePhone } = require("@shared/services/contactService");

function createTrackingToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

function extractInterestHints(input) {
  const values = [];
  const metadata = input && typeof input === "object" ? input : {};
  [
    metadata.category,
    metadata.productCategory,
    metadata.productType,
    metadata.interest,
    metadata.collection,
  ]
    .flat()
    .forEach((value) => {
      const text = String(value || "").trim().toLowerCase();
      if (text) values.push(text);
    });
  if (metadata.url) {
    try {
      const pathname = new URL(String(metadata.url)).pathname;
      pathname
        .split("/")
        .map((part) => String(part || "").trim().toLowerCase())
        .filter((part) => part && part.length > 2)
        .slice(0, 3)
        .forEach((part) => values.push(part));
    } catch {}
  }
  return Array.from(new Set(values)).slice(0, 12);
}

async function syncContactEngagement(contactId) {
  if (!contactId || !mongoose.Types.ObjectId.isValid(String(contactId))) return null;

  const [contact, clickCount, lastClick, conversionRows, recentMessages] = await Promise.all([
    Contact.findById(contactId).select("workspaceId engagement").lean(),
    ClickLog.countDocuments({ contactId }),
    ClickLog.findOne({ contactId }).sort({ clickedAt: -1 }).select("clickedAt").lean(),
    ConversionEvent.aggregate([
      { $match: { contactId: new mongoose.Types.ObjectId(String(contactId)) } },
      {
        $group: {
          _id: null,
          conversionCount: { $sum: 1 },
          totalRevenue: { $sum: { $cond: [{ $gt: ["$value", 0] }, "$value", 0] } },
          purchaseCount: {
            $sum: { $cond: [{ $eq: ["$eventName", "purchase"] }, 1, 0] },
          },
          lastConversionAt: { $max: "$timestamp" },
          interests: { $push: "$metadata" },
          behaviours: { $addToSet: "$eventName" },
        },
      },
    ]),
    Message.find({ contactId, direction: "outbound" })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("tracking conversion createdAt")
      .lean(),
  ]);

  if (!contact) return null;

  const conversion = conversionRows?.[0] || null;
  const interestHints = Array.from(
    new Set(
      (conversion?.interests || [])
        .flatMap((metadata) => extractInterestHints(metadata))
        .concat(
          recentMessages.flatMap((message) => {
            const values = [];
            if (message?.tracking?.clicked) values.push("clicked_offer");
            if (message?.conversion?.converted) values.push("converted");
            return values;
          })
        )
    )
  ).slice(0, 12);

  const behaviours = Array.from(
    new Set([
      ...(conversion?.behaviours || []).map((value) => String(value || "").trim()),
      ...recentMessages.flatMap((message) => {
        const values = [];
        if (message?.tracking?.clicked) values.push("clicked_offer");
        if (message?.conversion?.converted) values.push("converted");
        return values;
      }),
    ].filter(Boolean))
  ).slice(0, 20);

  const lastActivityAt = [lastClick?.clickedAt, conversion?.lastConversionAt, recentMessages?.[0]?.createdAt]
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;

  const score = clampScore(
    clickCount * 4 +
      Number(conversion?.conversionCount || 0) * 12 +
      Number(conversion?.purchaseCount || 0) * 18 +
      (lastClick?.clickedAt ? 10 : 0) +
      (conversion?.lastConversionAt ? 20 : 0)
  );

  await Contact.updateOne(
    { _id: contactId },
    {
      $set: {
        "engagement.interests": interestHints,
        "engagement.behaviour": behaviours,
        "engagement.engagementScore": score,
        "engagement.lastActivityAt": lastActivityAt,
        "engagement.lastClickedAt": lastClick?.clickedAt || null,
        "engagement.lastConversionAt": conversion?.lastConversionAt || null,
        "engagement.clickCount": clickCount,
        "engagement.conversionCount": Number(conversion?.conversionCount || 0),
        "engagement.totalRevenue": Number(conversion?.totalRevenue || 0),
        "engagement.purchaseCount": Number(conversion?.purchaseCount || 0),
      },
    }
  );

  return {
    engagementScore: score,
    interests: interestHints,
    behaviour: behaviours,
    lastActivityAt,
  };
}

async function resolveMessageAttribution({ workspaceId, trackingToken, messageId, phone }) {
  if (!workspaceId) return null;

  if (trackingToken) {
    return Message.findOne({
      workspaceId,
      "tracking.trackingToken": String(trackingToken).trim(),
      direction: "outbound",
    }).lean();
  }

  if (messageId && mongoose.Types.ObjectId.isValid(String(messageId))) {
    return Message.findOne({
      _id: messageId,
      workspaceId,
      direction: "outbound",
    }).lean();
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  return Message.findOne({
    workspaceId,
    phone: normalizedPhone,
    direction: "outbound",
  })
    .sort({ createdAt: -1 })
    .lean();
}

module.exports = {
  createTrackingToken,
  resolveMessageAttribution,
  syncContactEngagement,
};
