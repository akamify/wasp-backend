const { User } = require("../models/User");
const { Workspace } = require("../models/Workspace");
const { Campaign } = require("../models/Campaign");
const { Template } = require("../models/Template");
const { Contact } = require("../models/Contact");
const { Event } = require("../models/Event");
const { Transaction } = require("../models/Transaction");
const { Message } = require("../models/Message");
const mongoose = require("mongoose");

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const limitRaw = Number(req.query.limit || 25) || 25;
  const limit = Math.min(Math.max(limitRaw, 5), 200);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchRegex(req) {
  const q = String(req.query.q || "").trim();
  if (!q) return null;
  return new RegExp(escapeRegExp(q), "i");
}

function normalizeListOption(value) {
  return String(value || "").trim().toLowerCase();
}

function parseSort(req, allowed, fallback) {
  const raw = normalizeListOption(req.query.sort);
  if (!raw) return fallback;
  return allowed.includes(raw) ? raw : fallback;
}

function parseFilter(req, allowed, fallback) {
  const raw = normalizeListOption(req.query.filter);
  if (!raw) return fallback;
  return allowed.includes(raw) ? raw : fallback;
}

function shouldIncludeTestData(req) {
  const v = String(req.query.includeTest || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function testDataNorFilter() {
  // Exclude common seed/smoke users by email/name patterns.
  // This is intentionally conservative and can be bypassed with `?includeTest=1`.
  return [
    { email: /@example\.com$/i },
    { email: /@test\.com$/i },
    { email: /^smoke\+/i },
    { email: /^legacy\+/i },
    { email: /^e2e\+/i },
    { email: /^dbg\+/i },
    { name: /^smoke/i },
    { name: /^legacy/i },
    { name: /^e2e/i },
    { name: /^dbg/i },
  ];
}

function listResponse({ items, total, page, limit }) {
  return { success: true, items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function adminListUsers(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filterKey = parseFilter(req, ["all", "admin", "member", "banned"], "all");
  const sortKey = parseSort(req, ["recent", "old", "az"], "recent");
  const searchFilter = rx
    ? {
        $or: [{ email: rx }, { name: rx }, { phone: rx }, { role: rx }],
      }
    : {};

  const roleFilter =
    filterKey === "admin"
      ? { role: "admin" }
      : filterKey === "member"
        ? { role: "user" }
        : {};

  // Back-compat: older DBs won't have `status`. Treat missing as active.
  const statusFilter =
    filterKey === "banned"
      ? { status: "banned" }
      : filterKey === "all"
        ? {}
        : { $or: [{ status: { $exists: false } }, { status: "active" }] };

  const baseFilter = shouldIncludeTestData(req)
    ? searchFilter
    : {
        $and: [searchFilter, { $nor: testDataNorFilter() }],
      };

  const filter = { $and: [baseFilter, roleFilter, statusFilter] };
  const sort =
    sortKey === "old"
      ? { createdAt: 1 }
      : sortKey === "az"
        ? { name: 1, email: 1 }
        : { createdAt: -1 };

  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort(sort).skip(skip).limit(limit).select("email name phone role status createdAt"),
  ]);

  const userIds = users.map((u) => u._id);
  const workspaces = await Workspace.find({ ownerId: { $in: userIds }, isActive: true }).select("ownerId name plan createdAt");
  const workspaceByOwnerId = new Map(workspaces.map((w) => [String(w.ownerId), w]));

  res.json(
    listResponse({
      items: users.map((u) => {
        const w = workspaceByOwnerId.get(String(u._id));
        return {
          id: String(u._id),
          email: u.email,
          name: u.name || "",
          phone: u.phone || "",
          role: u.role,
          status: u.status || "active",
          createdAt: u.createdAt,
          workspace: w
            ? { id: String(w._id), name: w.name, plan: w.plan, createdAt: w.createdAt }
            : null,
        };
      }),
      total,
      page,
      limit,
    })
  );
}

async function adminListChannels(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filterKey = parseFilter(req, ["all", "free", "paid"], "all");
  const sortKey = parseSort(req, ["recent", "old", "name"], "recent");

  const searchFilter = rx ? { $or: [{ name: rx }, { plan: rx }] } : {};
  const planFilter =
    filterKey === "free"
      ? { plan: /free/i }
      : filterKey === "paid"
        ? { plan: { $not: /free/i } }
        : {};

  const filter = { $and: [{ isActive: true }, searchFilter, planFilter] };
  const sort =
    sortKey === "old" ? { createdAt: 1 } : sortKey === "name" ? { name: 1 } : { createdAt: -1 };

  const [total, workspaces] = await Promise.all([
    Workspace.countDocuments(filter),
    Workspace.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select("ownerId name plan isActive createdAt updatedAt"),
  ]);

  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));

  res.json(
    listResponse({
      items: workspaces.map((w) => {
        const owner = ownerById.get(String(w.ownerId));
        return {
          id: String(w._id),
          name: w.name,
          plan: w.plan,
          isActive: w.isActive,
          createdAt: w.createdAt,
          owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || "" } : null,
        };
      }),
      total,
      page,
      limit,
    })
  );
}

async function adminListMasterCampaigns(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filterKey = parseFilter(req, ["all", "processing", "completed", "paused"], "all");
  const sortKey = parseSort(req, ["recent", "engagement", "name"], "recent");

  const searchFilter = rx ? { $or: [{ name: rx }, { status: rx }, { type: rx }] } : {};
  const statusFilter =
    filterKey === "completed"
      ? { status: "completed" }
      : filterKey === "paused"
        ? { status: "paused" }
        : filterKey === "processing"
          ? { status: { $in: ["queued", "running"] } }
          : {};

  const filter = { $and: [searchFilter, statusFilter] };
  const sort =
    sortKey === "name"
      ? { name: 1, createdAt: -1 }
      : sortKey === "engagement"
        ? { "totals.sent": -1, "totals.total": -1, createdAt: -1 }
        : { createdAt: -1 };

  const [total, campaigns] = await Promise.all([
    Campaign.countDocuments(filter),
    Campaign.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select("workspaceId name templateId type status scheduledAt totals createdAt updatedAt"),
  ]);

  const workspaceIds = Array.from(new Set(campaigns.map((c) => String(c.workspaceId)).filter(isValidObjectId)));
  const templateIds = Array.from(new Set(campaigns.map((c) => String(c.templateId)).filter(isValidObjectId)));
  const [workspaces, templates] = await Promise.all([
    Workspace.find({ _id: { $in: workspaceIds } }).select("name ownerId plan"),
    Template.find({ _id: { $in: templateIds } }).select("name status language category workspaceId"),
  ]);
  const workspaceById = new Map(workspaces.map((w) => [String(w._id), w]));
  const templateById = new Map(templates.map((t) => [String(t._id), t]));

  res.json(
    listResponse({
      items: campaigns.map((c) => {
        const w = workspaceById.get(String(c.workspaceId));
        const t = templateById.get(String(c.templateId));
        return {
          id: String(c._id),
          name: c.name,
          type: c.type,
          status: c.status,
          scheduledAt: c.scheduledAt || null,
          totals: c.totals || {},
          createdAt: c.createdAt,
          workspace: w ? { id: String(w._id), name: w.name, plan: w.plan } : null,
          template: t ? { id: String(t._id), name: t.name, status: t.status, language: t.language, category: t.category } : null,
        };
      }),
      total,
      page,
      limit,
    })
  );
}

async function adminListMasterTemplates(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filter = rx
    ? { $or: [{ name: rx }, { status: rx }, { language: rx }, { category: rx }, { source: rx }] }
    : {};

  const [total, templates] = await Promise.all([
    Template.countDocuments(filter),
    Template.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("workspaceId name language category status source rejectedReason updatedAt createdAt"),
  ]);

  const workspaceIds = Array.from(new Set(templates.map((t) => String(t.workspaceId)).filter(isValidObjectId)));
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select("name ownerId plan");
  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  const workspaceById = new Map(workspaces.map((w) => [String(w._id), w]));
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));

  res.json(
    listResponse({
      items: templates.map((t) => {
        const w = workspaceById.get(String(t.workspaceId));
        const owner = w ? ownerById.get(String(w.ownerId)) : null;
        return {
          id: String(t._id),
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          source: t.source,
          updatedAt: t.updatedAt,
          createdAt: t.createdAt,
          workspace: w
            ? {
                id: String(w._id),
                name: w.name,
                plan: w.plan,
                owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || "" } : null,
              }
            : null,
        };
      }),
      total,
      page,
      limit,
    })
  );
}

async function adminListMasterContacts(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filterKey = parseFilter(req, ["all", "synced", "imported"], "all");
  const sortKey = parseSort(req, ["recent", "az", "workspace"], "recent");

  const searchFilter = rx
    ? { $or: [{ phone: rx }, { name: rx }, { email: rx }, { company: rx }, { source: rx }, { tags: rx }] }
    : {};

  const sourceFilter =
    filterKey === "imported"
      ? { source: "imported" }
      : filterKey === "synced"
        ? { source: { $in: ["inbound", "outbound"] } }
        : {};

  const filter = { $and: [searchFilter, sourceFilter] };
  const sort =
    sortKey === "az"
      ? { name: 1, phone: 1 }
      : sortKey === "workspace"
        ? { workspaceId: 1, updatedAt: -1 }
        : { updatedAt: -1 };

  const [total, contacts] = await Promise.all([
    Contact.countDocuments(filter),
    Contact.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select("workspaceId phone name email company language source tags lastMessagePreview updatedAt createdAt"),
  ]);

  const workspaceIds = Array.from(new Set(contacts.map((c) => String(c.workspaceId)).filter(isValidObjectId)));
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select("name ownerId plan");
  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  const workspaceById = new Map(workspaces.map((w) => [String(w._id), w]));
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));

  res.json(
    listResponse({
      items: contacts.map((c) => {
        const w = workspaceById.get(String(c.workspaceId));
        const owner = w ? ownerById.get(String(w.ownerId)) : null;
        return {
          id: String(c._id),
          phone: c.phone,
          name: c.name || "",
          email: c.email || "",
          company: c.company || "",
          language: c.language || null,
          source: c.source,
          tags: c.tags || [],
          lastMessagePreview: c.lastMessagePreview || "",
          updatedAt: c.updatedAt,
          createdAt: c.createdAt,
          workspace: w
            ? {
                id: String(w._id),
                name: w.name,
                plan: w.plan,
                owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || "" } : null,
              }
            : null,
        };
      }),
      total,
      page,
      limit,
    })
  );
}

async function adminListNotifications(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filter = rx ? { $or: [{ eventName: rx }, { phone: rx }, { status: rx }] } : {};

  const [total, events] = await Promise.all([
    Event.countDocuments(filter),
    Event.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("workspaceId eventName phone status error templateId messageId createdAt updatedAt"),
  ]);

  const workspaceIds = Array.from(new Set(events.map((e) => String(e.workspaceId)).filter(isValidObjectId)));
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select("name ownerId plan");
  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  const workspaceById = new Map(workspaces.map((w) => [String(w._id), w]));
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));

  res.json(
    listResponse({
      items: events.map((e) => {
        const w = workspaceById.get(String(e.workspaceId));
        const owner = w ? ownerById.get(String(w.ownerId)) : null;
        return {
          id: String(e._id),
          eventName: e.eventName,
          phone: e.phone,
          status: e.status,
          templateId: e.templateId ? String(e.templateId) : null,
          messageId: e.messageId ? String(e.messageId) : null,
          createdAt: e.createdAt,
          workspaceId: String(e.workspaceId),
          workspace: w
            ? {
                id: String(w._id),
                name: w.name,
                plan: w.plan,
                owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || "" } : null,
              }
            : null,
        };
      }),
      total,
      page,
      limit,
    })
  );
}

async function adminListTransactions(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filterKey = parseFilter(req, ["all", "credit", "debit"], "all");
  const sortKey = parseSort(req, ["recent", "old", "amount"], "recent");

  const searchFilter = rx ? { $or: [{ reason: rx }, { provider: rx }, { providerRef: rx }, { type: rx }, { currency: rx }] } : {};
  const typeFilter = filterKey === "credit" ? { type: "credit" } : filterKey === "debit" ? { type: "debit" } : {};
  const filter = { $and: [searchFilter, typeFilter] };
  const sort =
    sortKey === "old"
      ? { createdAt: 1 }
      : sortKey === "amount"
        ? { amount: -1, createdAt: -1 }
        : { createdAt: -1 };

  const [total, txs] = await Promise.all([
    Transaction.countDocuments(filter),
    Transaction.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select("workspaceId type amount currency reason provider providerRef createdAt"),
  ]);

  const workspaceIds = Array.from(new Set(txs.map((t) => String(t.workspaceId)).filter(isValidObjectId)));
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select("name ownerId plan");
  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  const workspaceById = new Map(workspaces.map((w) => [String(w._id), w]));
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));

  res.json(
    listResponse({
      items: txs.map((t) => {
        const w = workspaceById.get(String(t.workspaceId));
        const owner = w ? ownerById.get(String(w.ownerId)) : null;
        return {
          id: String(t._id),
          type: t.type,
          amount: t.amount,
          currency: t.currency,
          reason: t.reason,
          provider: t.provider,
          providerRef: t.providerRef || null,
          createdAt: t.createdAt,
          workspace: w ? { id: String(w._id), name: w.name, plan: w.plan } : null,
          owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || "" } : null,
        };
      }),
      total,
      page,
      limit,
    })
  );
}

async function adminListMessageLogs(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filterKey = parseFilter(req, ["all", "inbound", "outbound", "failed"], "all");
  const sortKey = parseSort(req, ["recent", "phone", "workspace"], "recent");

  const searchFilter = rx
    ? {
        $or: [
          { phone: rx },
          { direction: rx },
          { status: rx },
          { whatsappMessageId: rx },
          { text: rx },
        ],
      }
    : {};

  const extraFilter =
    filterKey === "inbound"
      ? { direction: "inbound" }
      : filterKey === "outbound"
        ? { direction: "outbound" }
        : filterKey === "failed"
          ? { status: "failed" }
          : {};

  const filter = { $and: [searchFilter, extraFilter] };
  const sort =
    sortKey === "phone"
      ? { phone: 1, createdAt: -1 }
      : sortKey === "workspace"
        ? { workspaceId: 1, createdAt: -1 }
        : { createdAt: -1 };

  const [total, messages] = await Promise.all([
    Message.countDocuments(filter),
    Message.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select("workspaceId campaignId templateId phone direction status whatsappMessageId text createdAt"),
  ]);

  const workspaceIds = Array.from(new Set(messages.map((m) => String(m.workspaceId)).filter(isValidObjectId)));
  const campaignIds = Array.from(new Set(messages.map((m) => (m.campaignId ? String(m.campaignId) : "")).filter(Boolean)));
  const templateIds = Array.from(new Set(messages.map((m) => (m.templateId ? String(m.templateId) : "")).filter(Boolean)));
  const [workspaces, campaigns, templates] = await Promise.all([
    Workspace.find({ _id: { $in: workspaceIds } }).select("name ownerId plan"),
    Campaign.find({ _id: { $in: campaignIds } }).select("name status type workspaceId"),
    Template.find({ _id: { $in: templateIds } }).select("name status language category"),
  ]);
  const workspaceById = new Map(workspaces.map((w) => [String(w._id), w]));
  const campaignById = new Map(campaigns.map((c) => [String(c._id), c]));
  const templateById = new Map(templates.map((t) => [String(t._id), t]));

  res.json(
    listResponse({
      items: messages.map((m) => {
        const w = workspaceById.get(String(m.workspaceId));
        const c = m.campaignId ? campaignById.get(String(m.campaignId)) : null;
        const t = m.templateId ? templateById.get(String(m.templateId)) : null;
        return {
          id: String(m._id),
          phone: m.phone,
          direction: m.direction,
          status: m.status,
          whatsappMessageId: m.whatsappMessageId || null,
          text: m.text || "",
          createdAt: m.createdAt,
          workspace: w ? { id: String(w._id), name: w.name, plan: w.plan } : null,
          campaign: c ? { id: String(c._id), name: c.name, status: c.status, type: c.type } : null,
          template: t ? { id: String(t._id), name: t.name, status: t.status, language: t.language, category: t.category } : null,
        };
      }),
      total,
      page,
      limit,
    })
  );
}

async function adminSubscriptionPlans(req, res) {
  const items = await Workspace.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: "$plan", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  res.json({ success: true, items: items.map((i) => ({ plan: i._id || "unknown", count: i.count })) });
}

async function adminSubscriptionsData(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filter = rx ? { $or: [{ name: rx }, { plan: rx }] } : {};

  const [total, workspaces, planSummary] = await Promise.all([
    Workspace.countDocuments({ ...filter, isActive: true }),
    Workspace.find({ ...filter, isActive: true })
      .sort({ plan: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("ownerId name plan isActive createdAt updatedAt"),
    Workspace.aggregate([
      { $match: { ...filter, isActive: true } },
      { $group: { _id: "$plan", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));

  res.json(
    Object.assign(
      listResponse({
        items: workspaces.map((w) => {
          const owner = ownerById.get(String(w.ownerId));
          return {
            id: String(w._id),
            name: w.name,
            plan: w.plan,
            isActive: w.isActive,
            createdAt: w.createdAt,
            owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || "" } : null,
          };
        }),
        total,
        page,
        limit,
      }),
      { summary: planSummary.map((p) => ({ plan: p._id || "unknown", count: p.count })) }
    )
  );
}

async function adminPaymentGateway(req, res) {
  const { page, limit } = parsePaging(req);
  res.json(listResponse({ items: [], total: 0, page, limit }));
}

async function adminSupportTickets(req, res) {
  const { page, limit } = parsePaging(req);
  res.json(listResponse({ items: [], total: 0, page, limit }));
}

async function adminAppUpdate(req, res) {
  res.json({ success: true, version: "v3.7.5" });
}

async function adminUpdateUserStatus(req, res) {
  const id = String(req.params.id || "").trim();
  if (!isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid user id" });
  const status = String(req.body?.status || "").trim().toLowerCase();
  if (!["active", "banned"].includes(status)) return res.status(400).json({ success: false, message: "Invalid status" });
  const user = await User.findByIdAndUpdate(id, { $set: { status } }, { new: true }).select("email name role status createdAt");
  if (!user) return res.status(404).json({ success: false, message: "User not found" });
  res.json({ success: true, user: { id: String(user._id), email: user.email, name: user.name || "", role: user.role, status: user.status || "active" } });
}

module.exports = {
  adminListUsers,
  adminUpdateUserStatus,
  adminListChannels,
  adminListMasterCampaigns,
  adminListMasterTemplates,
  adminListMasterContacts,
  adminListNotifications,
  adminListTransactions,
  adminListMessageLogs,
  adminSubscriptionPlans,
  adminSubscriptionsData,
  adminPaymentGateway,
  adminSupportTickets,
  adminAppUpdate,
};
