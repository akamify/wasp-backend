const { User } = require("../models/User");
const { Workspace } = require("../models/Workspace");
const { Template } = require("../models/Template");
const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { Wallet } = require("../models/Wallet");
const { Transaction } = require("../models/Transaction");
const { Message } = require("../models/Message");
const { ClickLog } = require("../models/ClickLog");
const { decryptString } = require("../utils/crypto");
const bcrypt = require("bcryptjs");
const { HttpError } = require("../utils/httpError");
const { AdminAccount } = require("../models/AdminAccount");

function mask(value) {
  const source = String(value || "");
  if (!source) return "";
  if (source.length <= 6) return "***";
  return `${source.slice(0, 2)}***${source.slice(-3)}`;
}

async function adminOverview(req, res) {
  const rangeRaw = String(req.query.range || "week").trim().toLowerCase();
  const range =
    rangeRaw === "7d" || rangeRaw === "week" || rangeRaw === "weekly"
      ? "week"
      : rangeRaw === "30d" || rangeRaw === "month" || rangeRaw === "monthly"
        ? "month"
        : rangeRaw === "365d" || rangeRaw === "12m" || rangeRaw === "year" || rangeRaw === "yearly"
          ? "year"
          : "week";

  const since = new Date();
  if (range === "week") since.setDate(since.getDate() - 6);
  else if (range === "month") since.setDate(since.getDate() - 29);
  else since.setMonth(since.getMonth() - 11);
  since.setHours(0, 0, 0, 0);

  const [
    totalUsers,
    totalWorkspaces,
    totalTemplates,
    approvedTemplates,
    totalCredentials,
    validCredentials,
    walletTotals,
    totalMessages,
    deliveredMessages,
    readMessages,
    failedMessages,
    totalClicks,
    dailyMessages,
  ] = await Promise.all([
    User.countDocuments(),
    Workspace.countDocuments({ isActive: true }),
    Template.countDocuments(),
    Template.countDocuments({ status: "approved" }),
    WhatsAppCredentials.countDocuments(),
    WhatsAppCredentials.countDocuments({ isValid: true }),
    Wallet.aggregate([{ $group: { _id: null, balance: { $sum: "$balance" } } }]),
    Message.countDocuments({ direction: "outbound" }),
    Message.countDocuments({ direction: "outbound", status: "delivered" }),
    Message.countDocuments({ direction: "outbound", status: "read" }),
    Message.countDocuments({ direction: "outbound", status: "failed" }),
    ClickLog.countDocuments(),
    Message.aggregate(
      range === "year"
        ? [
            { $match: { direction: "outbound", createdAt: { $gte: since } } },
            {
              $group: {
                _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
                count: { $sum: 1 },
              },
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } },
          ]
        : [
            { $match: { direction: "outbound", createdAt: { $gte: since } } },
            {
              $group: {
                _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" }, day: { $dayOfMonth: "$createdAt" } },
                count: { $sum: 1 },
              },
            },
            { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
          ]
    ),
  ]);

  const points =
    range === "year"
      ? dailyMessages.map((item) => ({
          label: `${item._id.year}-${String(item._id.month).padStart(2, "0")}`,
          count: item.count,
        }))
      : dailyMessages.map((item) => ({
          label: `${item._id.year}-${String(item._id.month).padStart(2, "0")}-${String(item._id.day).padStart(2, "0")}`,
          count: item.count,
        }));

  res.json({
    success: true,
    range,
    overview: {
      users: totalUsers,
      workspaces: totalWorkspaces,
      templates: totalTemplates,
      approvedTemplates,
      credentials: totalCredentials,
      validCredentials,
      walletBalance: walletTotals[0]?.balance || 0,
      outboundMessages: totalMessages,
      deliveredMessages,
      readMessages,
      failedMessages,
      clicks: totalClicks,
    },
    series: {
      group: range === "year" ? "month" : "day",
      points,
    },
    // Back-compat: keep dailyMessages even when range is monthly/yearly.
    dailyMessages:
      range === "year"
        ? points.map((p) => ({ date: p.label, count: p.count }))
        : points.map((p) => ({ date: p.label, count: p.count })),
  });
}

async function adminUsers(req, res) {
  const users = await User.find().sort({ createdAt: -1 }).limit(100).select("email name phone role createdAt");
  const userIds = users.map((user) => user._id);
  const workspaces = await Workspace.find({ ownerId: { $in: userIds }, isActive: true }).select("ownerId name plan");
  const workspaceIds = workspaces.map((workspace) => workspace._id);
  const [wallets, templateCounts] = await Promise.all([
    Wallet.find({ workspaceId: { $in: workspaceIds } }).select("workspaceId balance currency"),
    Template.aggregate([
      { $match: { workspaceId: { $in: workspaceIds } } },
      { $group: { _id: "$workspaceId", count: { $sum: 1 } } },
    ]),
  ]);

  const workspaceByOwnerId = new Map(workspaces.map((workspace) => [String(workspace.ownerId), workspace]));
  const walletByWorkspaceId = new Map(wallets.map((wallet) => [String(wallet.workspaceId), wallet]));
  const templateCountByWorkspaceId = new Map(templateCounts.map((entry) => [String(entry._id), entry.count]));

  res.json({
    success: true,
    users: users.map((user) => {
      const workspace = workspaceByOwnerId.get(String(user._id));
      const wallet = workspace ? walletByWorkspaceId.get(String(workspace._id)) : null;
      return {
        id: String(user._id),
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
        createdAt: user.createdAt,
        workspace: workspace
          ? {
              id: String(workspace._id),
              name: workspace.name,
              plan: workspace.plan,
            }
          : null,
        wallet: wallet
          ? { balance: wallet.balance, currency: wallet.currency }
          : { balance: 0, currency: "INR" },
        templateCount: workspace ? templateCountByWorkspaceId.get(String(workspace._id)) || 0 : 0,
      };
    }),
  });
}

async function adminTemplates(req, res) {
  const templates = await Template.find().sort({ updatedAt: -1 }).limit(150).select("workspaceId name language category status source rejectedReason updatedAt createdAt");
  const workspaceIds = Array.from(new Set(templates.map((template) => String(template.workspaceId))));
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select("name ownerId");
  const owners = await User.find({ _id: { $in: workspaces.map((workspace) => workspace.ownerId) } }).select("email name");
  const workspaceById = new Map(workspaces.map((workspace) => [String(workspace._id), workspace]));
  const ownerById = new Map(owners.map((owner) => [String(owner._id), owner]));

  res.json({
    success: true,
    templates: templates.map((template) => {
      const workspace = workspaceById.get(String(template.workspaceId));
      const owner = workspace ? ownerById.get(String(workspace.ownerId)) : null;
      return {
        id: String(template._id),
        name: template.name,
        language: template.language,
        category: template.category,
        status: template.status,
        source: template.source,
        rejectedReason: template.rejectedReason || null,
        updatedAt: template.updatedAt,
        createdAt: template.createdAt,
        workspace: workspace
          ? {
              id: String(workspace._id),
              name: workspace.name,
              ownerEmail: owner?.email || "",
              ownerName: owner?.name || "",
            }
          : null,
      };
    }),
  });
}

async function adminCredentials(req, res) {
  const credentials = await WhatsAppCredentials.find()
    .sort({ updatedAt: -1 })
    .limit(100)
    .select("+phoneNumberIdEnc +businessAccountIdEnc workspaceId graphApiVersion isValid lastValidatedAt updatedAt");
  const workspaces = await Workspace.find({ _id: { $in: credentials.map((item) => item.workspaceId) } }).select("name ownerId");
  const owners = await User.find({ _id: { $in: workspaces.map((workspace) => workspace.ownerId) } }).select("email name");
  const workspaceById = new Map(workspaces.map((workspace) => [String(workspace._id), workspace]));
  const ownerById = new Map(owners.map((owner) => [String(owner._id), owner]));

  res.json({
    success: true,
    credentials: credentials.map((item) => {
      const workspace = workspaceById.get(String(item.workspaceId));
      const owner = workspace ? ownerById.get(String(workspace.ownerId)) : null;
      return {
        id: String(item._id),
        graphApiVersion: item.graphApiVersion,
        isValid: item.isValid,
        lastValidatedAt: item.lastValidatedAt,
        updatedAt: item.updatedAt,
        phoneNumberId: mask(decryptString(item.phoneNumberIdEnc)),
        businessAccountId: mask(decryptString(item.businessAccountIdEnc)),
        workspace: workspace
          ? {
              id: String(workspace._id),
              name: workspace.name,
              ownerEmail: owner?.email || "",
              ownerName: owner?.name || "",
            }
          : null,
      };
    }),
  });
}

async function adminWallets(req, res) {
  const wallets = await Wallet.find().sort({ balance: -1, updatedAt: -1 }).limit(100).select("workspaceId balance currency updatedAt");
  const workspaceIds = wallets.map((wallet) => wallet.workspaceId);
  const [workspaces, recentTransactions] = await Promise.all([
    Workspace.find({ _id: { $in: workspaceIds } }).select("name ownerId"),
    Transaction.find({ workspaceId: { $in: workspaceIds } }).sort({ createdAt: -1 }).limit(200).select("workspaceId type amount currency reason createdAt"),
  ]);
  const owners = await User.find({ _id: { $in: workspaces.map((workspace) => workspace.ownerId) } }).select("email name");
  const workspaceById = new Map(workspaces.map((workspace) => [String(workspace._id), workspace]));
  const ownerById = new Map(owners.map((owner) => [String(owner._id), owner]));
  const txByWorkspaceId = new Map();
  for (const tx of recentTransactions) {
    const key = String(tx.workspaceId);
    if (!txByWorkspaceId.has(key)) txByWorkspaceId.set(key, []);
    if (txByWorkspaceId.get(key).length < 3) txByWorkspaceId.get(key).push(tx);
  }

  res.json({
    success: true,
    wallets: wallets.map((wallet) => {
      const workspace = workspaceById.get(String(wallet.workspaceId));
      const owner = workspace ? ownerById.get(String(workspace.ownerId)) : null;
      return {
        id: String(wallet._id),
        balance: wallet.balance,
        currency: wallet.currency,
        updatedAt: wallet.updatedAt,
        workspace: workspace
          ? {
              id: String(workspace._id),
              name: workspace.name,
              ownerEmail: owner?.email || "",
              ownerName: owner?.name || "",
            }
          : null,
        recentTransactions: (txByWorkspaceId.get(String(wallet.workspaceId)) || []).map((tx) => ({
          id: String(tx._id),
          type: tx.type,
          amount: tx.amount,
          currency: tx.currency,
          reason: tx.reason,
          createdAt: tx.createdAt,
        })),
      };
    }),
  });
}

module.exports = {
  adminOverview,
  adminUsers,
  adminTemplates,
  adminCredentials,
  adminWallets,
  adminChangePassword,
};

async function adminChangePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  const adminAccount = await AdminAccount.findById(req.user.id).select("+passwordHash username displayName envLoginDisabled");
  if (!adminAccount) throw new HttpError(404, "Admin account not found");

  const ok = await bcrypt.compare(String(currentPassword || ""), adminAccount.passwordHash);
  if (!ok) throw new HttpError(401, "Current password is incorrect");

  const next = String(newPassword || "");
  if (next.length < 8) throw new HttpError(400, "New password must be at least 8 characters");

  adminAccount.passwordHash = await bcrypt.hash(next, 12);
  adminAccount.envLoginDisabled = true;
  adminAccount.passwordResetTokenHash = undefined;
  adminAccount.passwordResetTokenExpiresAt = undefined;
  await adminAccount.save();
  res.json({ success: true });
}
