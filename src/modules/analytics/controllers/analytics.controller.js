const { Message } = require("@infra/database/Message");
const { ClickLog } = require("@infra/database/ClickLog");
const { Template } = require("@infra/database/Template");
const { Contact } = require("@infra/database/Contact");
const { Campaign } = require("@infra/database/Campaign");
const { HttpError } = require("@shared/utils/httpError");
const { resolveActiveConnection } = require("@shared/services/whatsappConnectionService");
const mongoose = require("mongoose");

function clampPct(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function pctChange(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  if (p <= 0 && c <= 0) return 0;
  // We cap the display percentage to a human-friendly 0-100 style scale.
  // For example: 18 vs 1 => 17 (not 1700).
  if (p <= 0) return Math.min(100, c);
  return Math.max(-100, Math.min(100, c - p));
}

function normalizeRange(rangeRaw) {
  const r = String(rangeRaw || "week").trim().toLowerCase();
  if (r === "today" || r === "day" || r === "1d") return "today";
  if (r === "7d" || r === "week" || r === "weekly") return "week";
  if (r === "30d" || r === "month" || r === "monthly") return "30d";
  if (r === "365d" || r === "12m" || r === "year" || r === "yearly") return "year";
  return "week";
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfMonth(d) {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function addMonths(d, months) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + months);
  return x;
}

async function buildSeries({ workspaceId, wabaId, range }) {
  const workspaceObjectId = mongoose.Types.ObjectId.isValid(String(workspaceId || ""))
    ? new mongoose.Types.ObjectId(String(workspaceId))
    : null;
  if (!workspaceObjectId) return { group: "day", points: [] };

  // Include all outbound messages so dashboard reflects real activity
  // (template + non-template sends).
  const baseMatch = {
    workspaceId: workspaceObjectId,
    wabaId,
    direction: "outbound",
  };

  const addDateFieldsStage = {
    $addFields: {
      sentAtD: { $convert: { input: "$statusTimestamps.sentAt", to: "date", onError: null, onNull: null } },
      createdAtD: { $convert: { input: "$createdAt", to: "date", onError: null, onNull: null } },
      effectiveSentAtD: {
        $ifNull: [
          { $convert: { input: "$statusTimestamps.sentAt", to: "date", onError: null, onNull: null } },
          { $convert: { input: "$createdAt", to: "date", onError: null, onNull: null } },
        ],
      },
      deliveredAtD: { $convert: { input: "$statusTimestamps.deliveredAt", to: "date", onError: null, onNull: null } },
      readAtD: { $convert: { input: "$statusTimestamps.readAt", to: "date", onError: null, onNull: null } },
    },
  };

  if (range === "today") {
    const now = new Date();
    const start = startOfDay(now);
    const end = startOfDay(addDays(now, 1));
    const agg = await Message.aggregate([
      { $match: baseMatch },
      addDateFieldsStage,
      { $match: { effectiveSentAtD: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: { h: { $hour: "$effectiveSentAtD" } },
          sent: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $ifNull: ["$deliveredAtD", false] }, 1, 0] } },
          read: { $sum: { $cond: [{ $ifNull: ["$readAtD", false] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        },
      },
      { $sort: { "_id.h": 1 } },
    ]);

    const byHour = new Map(agg.map((r) => [Number(r._id.h), r]));
    const points = Array.from({ length: 24 }).map((_, i) => {
      const row = byHour.get(i);
      return {
        label: `${String(i).padStart(2, "0")}:00`,
        sent: row?.sent || 0,
        delivered: row?.delivered || 0,
        read: row?.read || 0,
        failed: row?.failed || 0,
      };
    });
    return { group: "hour", points };
  }

  if (range === "week") {
    const since = startOfDay(addDays(new Date(), -6));
    const agg = await Message.aggregate([
      { $match: baseMatch },
      addDateFieldsStage,
      { $match: { effectiveSentAtD: { $gte: since } } },
      {
        $group: {
          _id: {
            y: { $year: "$effectiveSentAtD" },
            m: { $month: "$effectiveSentAtD" },
            d: { $dayOfMonth: "$effectiveSentAtD" },
          },
          sent: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $ifNull: ["$deliveredAtD", false] }, 1, 0] } },
          read: { $sum: { $cond: [{ $ifNull: ["$readAtD", false] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ]);

    const byKey = new Map(
      agg.map((r) => [
        `${r._id.y}-${String(r._id.m).padStart(2, "0")}-${String(r._id.d).padStart(2, "0")}`,
        r,
      ])
    );

    const points = Array.from({ length: 7 }).map((_, i) => {
      const day = startOfDay(addDays(new Date(), -6 + i));
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const row = byKey.get(key);
      return {
        label: day.toLocaleDateString("en-US", { weekday: "short" }),
        key,
        sent: row?.sent || 0,
        delivered: row?.delivered || 0,
        read: row?.read || 0,
        failed: row?.failed || 0,
      };
    });

    return { group: "day", points };
  }

  if (range === "30d") {
    const since = startOfDay(addDays(new Date(), -29));
    const agg = await Message.aggregate([
      { $match: baseMatch },
      addDateFieldsStage,
      { $match: { effectiveSentAtD: { $gte: since } } },
      {
        $group: {
          _id: {
            y: { $year: "$effectiveSentAtD" },
            m: { $month: "$effectiveSentAtD" },
            d: { $dayOfMonth: "$effectiveSentAtD" },
          },
          sent: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $ifNull: ["$deliveredAtD", false] }, 1, 0] } },
          read: { $sum: { $cond: [{ $ifNull: ["$readAtD", false] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ]);

    const byKey = new Map(
      agg.map((r) => [
        `${r._id.y}-${String(r._id.m).padStart(2, "0")}-${String(r._id.d).padStart(2, "0")}`,
        r,
      ])
    );

    const points = Array.from({ length: 30 }).map((_, i) => {
      const day = startOfDay(addDays(new Date(), -29 + i));
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const row = byKey.get(key);
      return {
        label: day.toLocaleDateString("en-US", { month: "short", day: "2-digit" }),
        key,
        sent: row?.sent || 0,
        delivered: row?.delivered || 0,
        read: row?.read || 0,
        failed: row?.failed || 0,
      };
    });

    return { group: "day", points };
  }

  // year
  const monthStart = startOfMonth(addMonths(new Date(), -11));
  const agg = await Message.aggregate([
    // Prefer sent timestamp and fallback to createdAt for legacy rows missing sentAt.
    { $match: baseMatch },
    addDateFieldsStage,
    { $match: { effectiveSentAtD: { $gte: monthStart } } },
    {
      $group: {
        _id: { y: { $year: "$effectiveSentAtD" }, m: { $month: "$effectiveSentAtD" } },
        sent: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $ifNull: ["$deliveredAtD", false] }, 1, 0] } },
        read: { $sum: { $cond: [{ $ifNull: ["$readAtD", false] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
      },
    },
    { $sort: { "_id.y": 1, "_id.m": 1 } },
  ]);

  const byKey = new Map(agg.map((r) => [`${r._id.y}-${String(r._id.m).padStart(2, "0")}`, r]));
  const points = Array.from({ length: 12 }).map((_, i) => {
    const d = startOfMonth(addMonths(new Date(), -11 + i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const row = byKey.get(key);
    return {
      label: d.toLocaleDateString("en-US", { month: "short" }),
      key,
      sent: row?.sent || 0,
      delivered: row?.delivered || 0,
      read: row?.read || 0,
      failed: row?.failed || 0,
    };
  });
  return { group: "month", points };
}

async function overview(req, res) {
  const workspaceId = req.workspace.id;
  const range = normalizeRange(req.query.range);
  const activeConnection = await resolveActiveConnection(workspaceId);
  const wabaId = activeConnection?.wabaId || "__no_active_waba__";

  // Include all outbound messages so analytics matches dashboard activity.
  const msgBase = {
    workspaceId,
    wabaId,
    direction: "outbound",
  };

  const sentBase = {
    ...msgBase,
    $or: [
      { "statusTimestamps.sentAt": { $exists: true } },
      { status: { $in: ["accepted", "sent", "delivered", "read", "failed", "timeout_unknown"] } },
    ],
  };

  const [sent, delivered, read, failed, clicks] = await Promise.all([
    Message.countDocuments(sentBase),
    Message.countDocuments({
      ...msgBase,
      "statusTimestamps.deliveredAt": { $exists: true },
    }),
    Message.countDocuments({
      ...msgBase,
      "statusTimestamps.readAt": { $exists: true },
    }),
    Message.countDocuments({ ...msgBase, status: "failed" }),
    ClickLog.countDocuments({ workspaceId }),
  ]);

  // Growth: Monthly message sent (this month vs last month)
  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  const nextMonthStart = startOfMonth(addMonths(now, 1));
  const lastMonthStart = startOfMonth(addMonths(now, -1));

  const [thisMonthSent, lastMonthSent] = await Promise.all([
    Message.countDocuments({
      ...sentBase,
      createdAt: { $gte: thisMonthStart, $lt: nextMonthStart },
    }),
    Message.countDocuments({
      ...sentBase,
      createdAt: { $gte: lastMonthStart, $lt: thisMonthStart },
    }),
  ]);

  // Contacts growth: this week vs last week (based on createdAt)
  const thisWeekStart = startOfDay(addDays(now, -6));
  const lastWeekStart = startOfDay(addDays(now, -13));
  const lastWeekEnd = startOfDay(addDays(now, -6));
  const [contactsThisWeek, contactsLastWeek] = await Promise.all([
    Contact.countDocuments({ workspaceId, wabaId, createdAt: { $gte: thisWeekStart } }),
    Contact.countDocuments({ workspaceId, wabaId, createdAt: { $gte: lastWeekStart, $lt: lastWeekEnd } }),
  ]);

  const todayStart = startOfDay(now);
  const tomorrowStart = startOfDay(addDays(now, 1));
  const activeTemplateFilter = activeConnection
    ? { workspaceId, wabaId: activeConnection.wabaId, isActive: { $ne: false }, deletedAt: null }
    : { workspaceId, _id: null };

  const [campaignsCount, templatesCount, contactsTotal, todaySent] = await Promise.all([
    Campaign.countDocuments({ workspaceId, wabaId }),
    Template.countDocuments(activeTemplateFilter),
    Contact.countDocuments({ workspaceId, wabaId }),
    Message.countDocuments({
      ...sentBase,
      createdAt: { $gte: todayStart, $lt: tomorrowStart },
    }),
  ]);

  const deliveryRatePct = clampPct(sent ? (delivered / sent) * 100 : 0);
  const readRatePct = clampPct(sent ? (read / sent) * 100 : 0);
  const monthlyGrowthPct = pctChange(thisMonthSent, lastMonthSent);
  const contactGrowthPct = pctChange(contactsThisWeek, contactsLastWeek);
  const series = await buildSeries({ workspaceId, wabaId, range });

  res.json({
    success: true,
    range,
    overview: { sent, delivered, read, failed, clicks },
    rates: { deliveryRatePct, readRatePct },
    growth: {
      monthly: { thisMonth: thisMonthSent, lastMonth: lastMonthSent, pct: monthlyGrowthPct },
      contacts: { thisWeek: contactsThisWeek, lastWeek: contactsLastWeek, pct: contactGrowthPct },
    },
    counts: { campaigns: campaignsCount, templates: templatesCount, contacts: contactsTotal },
    today: { sent: todaySent },
    series,
  });
}

async function templatePerformance(req, res) {
  const workspaceId = req.workspace.id;
  const templateId = req.params.id;
  const activeConnection = await resolveActiveConnection(workspaceId);
  if (!activeConnection) throw new HttpError(404, "Template not found");

  const template = await Template.findOne({
    _id: templateId,
    workspaceId,
    wabaId: activeConnection.wabaId,
    isActive: { $ne: false },
    deletedAt: null,
  }).select(
    "_id name status"
  );
  if (!template) throw new HttpError(404, "Template not found");

  const [sent, delivered, read, failed, clicks] = await Promise.all([
    Message.countDocuments({
      workspaceId,
      wabaId: activeConnection.wabaId,
      direction: "outbound",
      templateId,
      "statusTimestamps.sentAt": { $exists: true },
    }),
    Message.countDocuments({
      workspaceId,
      wabaId: activeConnection.wabaId,
      direction: "outbound",
      templateId,
      "statusTimestamps.deliveredAt": { $exists: true },
    }),
    Message.countDocuments({
      workspaceId,
      wabaId: activeConnection.wabaId,
      direction: "outbound",
      templateId,
      "statusTimestamps.readAt": { $exists: true },
    }),
    Message.countDocuments({ workspaceId, wabaId: activeConnection.wabaId, direction: "outbound", templateId, status: "failed" }),
    ClickLog.countDocuments({ workspaceId, templateId }),
  ]);

  res.json({
    success: true,
    template: { id: template._id, name: template.name, status: template.status },
    metrics: { sent, delivered, read, failed, clicks },
  });
}

module.exports = { overview, templatePerformance };

