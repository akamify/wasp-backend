const mongoose = require("mongoose");
const { AiAddonPlan } = require("@infra/database/AiAddonPlan");
const { AiTopupPack } = require("@infra/database/AiTopupPack");
const { Workspace } = require("@infra/database/Workspace");
const { User } = require("@infra/database/User");
const { AiSubscription } = require("@infra/database/AiSubscription");
const aiBillingOperationsService = require("@modules/ai-agents/services/aiBillingOperations.service");
const { HttpError } = require("@shared/utils/httpError");
const aiAddonService = require("@modules/ai-agents/services/aiAddon.service");

function sanitizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-\s_]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mapPlan(row) {
  return {
    id: String(row._id),
    planKey: row.planKey,
    name: row.name,
    description: row.description || "",
    status: row.status,
    currency: row.currency || "INR",
    monthlyPrice: Number(row.monthlyPrice || 0),
    includedCredits: Number(row.includedCredits || 0),
    tokensPerCredit: Number(row.tokensPerCredit || 1000),
    durationDays: Number(row.durationDays || 30),
    limits: {
      maxAgents: Number(row.limits?.maxAgents || 0),
      maxKbStorageMb: Number(row.limits?.maxKbStorageMb || 0),
      maxInputTokens: Number(row.limits?.maxInputTokens || 4096),
      maxTokensPerReply: Number(row.limits?.maxTokensPerReply || 0),
    },
    renewalPolicy: {
      mode: row.renewalPolicy?.mode || "auto_renew",
      expireUnusedCredits: row.renewalPolicy?.expireUnusedCredits !== false,
    },
    sortOrder: Number(row.sortOrder || 0),
    featured: Boolean(row.featured),
    isDefault: Boolean(row.isDefault),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function mapPack(row) {
  return {
    id: String(row._id),
    packId: row.packId,
    label: row.label,
    description: row.description || "",
    status: row.status,
    currency: row.currency || "INR",
    credits: Number(row.credits || 0),
    price: Number(row.price || 0),
    sortOrder: Number(row.sortOrder || 0),
    featured: Boolean(row.featured),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

async function listPlans() {
  const items = await AiAddonPlan.find({}).sort({ isDefault: -1, featured: -1, sortOrder: 1, createdAt: -1 }).lean();
  return { success: true, items: items.map(mapPlan) };
}

async function createPlan(payload) {
  const planKey = sanitizeKey(payload.planKey || payload.name || "ai_plan");
  if (!planKey) throw new HttpError(400, "Plan key required.");
  const exists = await AiAddonPlan.findOne({ planKey }).lean();
  if (exists) throw new HttpError(409, "Plan key already exists.");
  const row = await AiAddonPlan.create({
    planKey,
    name: String(payload.name || "").trim(),
    description: String(payload.description || "").trim(),
    status: payload.status || "draft",
    currency: String(payload.currency || "INR").trim() || "INR",
    monthlyPrice: Number(payload.monthlyPrice || 0),
    includedCredits: Number(payload.includedCredits || 0),
    tokensPerCredit: Number(payload.tokensPerCredit || 1000),
    durationDays: Number(payload.durationDays || 30),
    limits: {
      maxAgents: Number(payload.limits?.maxAgents || 0),
      maxKbStorageMb: Number(payload.limits?.maxKbStorageMb || 0),
      maxInputTokens: Number(payload.limits?.maxInputTokens || 4096),
      maxTokensPerReply: Number(payload.limits?.maxTokensPerReply || 0),
    },
    renewalPolicy: {
      mode: payload.renewalPolicy?.mode || "auto_renew",
      expireUnusedCredits: payload.renewalPolicy?.expireUnusedCredits !== false,
    },
    sortOrder: Number(payload.sortOrder || 0),
    featured: Boolean(payload.featured),
    isDefault: Boolean(payload.isDefault),
  });
  if (row.isDefault) {
    await AiAddonPlan.updateMany({ _id: { $ne: row._id } }, { $set: { isDefault: false } });
  }
  return { success: true, item: mapPlan(row) };
}

async function updatePlan(planId, payload) {
  const row = await AiAddonPlan.findById(planId);
  if (!row) throw new HttpError(404, "AI plan not found.");
  if (payload.planKey && sanitizeKey(payload.planKey) !== row.planKey) {
    const nextKey = sanitizeKey(payload.planKey);
    const exists = await AiAddonPlan.findOne({ _id: { $ne: row._id }, planKey: nextKey }).lean();
    if (exists) throw new HttpError(409, "Plan key already exists.");
    row.planKey = nextKey;
  }
  row.name = String(payload.name || row.name).trim();
  row.description = payload.description !== undefined ? String(payload.description || "").trim() : row.description;
  row.status = payload.status || row.status;
  row.currency = String(payload.currency || row.currency || "INR").trim() || "INR";
  row.monthlyPrice = Number(payload.monthlyPrice ?? row.monthlyPrice ?? 0);
  row.includedCredits = Number(payload.includedCredits ?? row.includedCredits ?? 0);
  row.tokensPerCredit = Number(payload.tokensPerCredit ?? row.tokensPerCredit ?? 1000);
  row.durationDays = Number(payload.durationDays ?? row.durationDays ?? 30);
  row.limits = {
    maxAgents: Number(payload.limits?.maxAgents ?? row.limits?.maxAgents ?? 0),
    maxKbStorageMb: Number(payload.limits?.maxKbStorageMb ?? row.limits?.maxKbStorageMb ?? 0),
    maxInputTokens: Number(payload.limits?.maxInputTokens ?? row.limits?.maxInputTokens ?? 4096),
    maxTokensPerReply: Number(payload.limits?.maxTokensPerReply ?? row.limits?.maxTokensPerReply ?? 0),
  };
  row.renewalPolicy = {
    mode: payload.renewalPolicy?.mode || row.renewalPolicy?.mode || "auto_renew",
    expireUnusedCredits: payload.renewalPolicy?.expireUnusedCredits ?? row.renewalPolicy?.expireUnusedCredits ?? true,
  };
  row.sortOrder = Number(payload.sortOrder ?? row.sortOrder ?? 0);
  row.featured = payload.featured ?? row.featured;
  row.isDefault = payload.isDefault ?? row.isDefault;
  await row.save();
  if (row.isDefault) {
    await AiAddonPlan.updateMany({ _id: { $ne: row._id } }, { $set: { isDefault: false } });
  }
  return { success: true, item: mapPlan(row) };
}

async function changePlanStatus(planId, status) {
  const row = await AiAddonPlan.findByIdAndUpdate(planId, { $set: { status } }, { new: true });
  if (!row) throw new HttpError(404, "AI plan not found.");
  return { success: true, item: mapPlan(row) };
}

async function deletePlan(planId) {
  const row = await AiAddonPlan.findByIdAndDelete(planId);
  if (!row) throw new HttpError(404, "AI plan not found.");
  return { success: true, item: mapPlan(row) };
}

async function listTopupPacks() {
  const items = await AiTopupPack.find({}).sort({ featured: -1, sortOrder: 1, createdAt: -1 }).lean();
  return { success: true, items: items.map(mapPack) };
}

async function createTopupPack(payload) {
  const packId = sanitizeKey(payload.packId || payload.label || "ai_pack");
  if (!packId) throw new HttpError(400, "Pack id required.");
  const exists = await AiTopupPack.findOne({ packId }).lean();
  if (exists) throw new HttpError(409, "Pack id already exists.");
  const row = await AiTopupPack.create({
    packId,
    label: String(payload.label || "").trim(),
    description: String(payload.description || "").trim(),
    status: payload.status || "draft",
    currency: String(payload.currency || "INR").trim() || "INR",
    credits: Number(payload.credits || 0),
    price: Number(payload.price || 0),
    sortOrder: Number(payload.sortOrder || 0),
    featured: Boolean(payload.featured),
  });
  return { success: true, item: mapPack(row) };
}

async function updateTopupPack(packId, payload) {
  const row = await AiTopupPack.findById(packId);
  if (!row) throw new HttpError(404, "AI top-up pack not found.");
  if (payload.packId && sanitizeKey(payload.packId) !== row.packId) {
    const nextKey = sanitizeKey(payload.packId);
    const exists = await AiTopupPack.findOne({ _id: { $ne: row._id }, packId: nextKey }).lean();
    if (exists) throw new HttpError(409, "Pack id already exists.");
    row.packId = nextKey;
  }
  row.label = String(payload.label || row.label).trim();
  row.description = payload.description !== undefined ? String(payload.description || "").trim() : row.description;
  row.status = payload.status || row.status;
  row.currency = String(payload.currency || row.currency || "INR").trim() || "INR";
  row.credits = Number(payload.credits ?? row.credits ?? 0);
  row.price = Number(payload.price ?? row.price ?? 0);
  row.sortOrder = Number(payload.sortOrder ?? row.sortOrder ?? 0);
  row.featured = payload.featured ?? row.featured;
  await row.save();
  return { success: true, item: mapPack(row) };
}

async function changeTopupPackStatus(packId, status) {
  const row = await AiTopupPack.findByIdAndUpdate(packId, { $set: { status } }, { new: true });
  if (!row) throw new HttpError(404, "AI top-up pack not found.");
  return { success: true, item: mapPack(row) };
}

async function deleteTopupPack(packId) {
  const row = await AiTopupPack.findByIdAndDelete(packId);
  if (!row) throw new HttpError(404, "AI top-up pack not found.");
  return { success: true, item: mapPack(row) };
}

async function listSubscriptions({ query = {} }) {
  const page = Math.max(1, Number(query.page || 1) || 1);
  const limit = Math.min(Math.max(Number(query.limit || 20) || 20, 1), 100);
  const skip = (page - 1) * limit;
  const search = String(query.search || "").trim();
  const activeOnly = String(query.activeOnly || "").trim() === "true";
  const workspaceFilter = {};
  if (search) {
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const workspaceIds = await Workspace.find({ $or: [{ name: regex }, { businessName: regex }, { slug: regex }] }).select("_id").lean();
    workspaceFilter.workspaceId = { $in: workspaceIds.map((item) => item._id) };
  }
  if (activeOnly) workspaceFilter.status = "active";
  const [total, rows] = await Promise.all([
    AiSubscription.countDocuments(workspaceFilter),
    AiSubscription.find(workspaceFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  const workspaceIds = Array.from(new Set(rows.map((item) => String(item.workspaceId)).filter(Boolean)));
  const userIds = Array.from(new Set(rows.map((item) => String(item.userId)).filter(Boolean)));
  const [workspaces, users] = await Promise.all([
    Workspace.find({ _id: { $in: workspaceIds } }).select("name businessName slug").lean(),
    User.find({ _id: { $in: userIds } }).select("name email").lean(),
  ]);
  const workspaceMap = new Map(workspaces.map((item) => [String(item._id), item]));
  const userMap = new Map(users.map((item) => [String(item._id), item]));
  return {
    success: true,
    items: rows.map((row) => ({
      ...aiAddonService.serializeSubscription(row),
      workspace: workspaceMap.get(String(row.workspaceId)) || null,
      user: userMap.get(String(row.userId)) || null,
    })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function assignWorkspacePlan({ workspaceId, planId, userId, preserveTopups = true }) {
  if (!mongoose.Types.ObjectId.isValid(String(workspaceId || ""))) throw new HttpError(400, "Invalid workspace id.");
  const workspace = await Workspace.findById(workspaceId).lean();
  if (!workspace) throw new HttpError(404, "Workspace not found.");
  const plan = await AiAddonPlan.findById(planId).lean();
  if (!plan) throw new HttpError(404, "AI plan not found.");

  const ownerId = workspace.ownerUserId || workspace.ownerId || userId || null;
  const catalog = {
    planKey: plan.planKey,
    planName: plan.name,
    planId: String(plan._id),
    source: "admin_assignment",
    currency: plan.currency || "INR",
    monthlyPrice: Number(plan.monthlyPrice || 0),
    includedCredits: Number(plan.includedCredits || 0),
    tokensPerCredit: Number(plan.tokensPerCredit || 1000),
    durationDays: Number(plan.durationDays || 30),
    limits: {
      maxAgents: Number(plan.limits?.maxAgents || 0),
      maxKbStorageMb: Number(plan.limits?.maxKbStorageMb || 0),
      maxInputTokens: Number(plan.limits?.maxInputTokens || 4096),
      maxTokensPerReply: Number(plan.limits?.maxTokensPerReply || 0),
    },
    renewalPolicy: {
      mode: plan.renewalPolicy?.mode || "auto_renew",
      expireUnusedCredits: plan.renewalPolicy?.expireUnusedCredits !== false,
    },
  };
  const previous = await aiAddonService.findCurrentSubscription(workspaceId);
  const subscription = await aiAddonService.createOrReplaceWorkspaceSubscription({
    workspaceId,
    userId: ownerId,
    catalog,
    source: "admin_assignment",
    chargeAmount: 0,
    preserveTopupTokens: Boolean(preserveTopups),
    existingSubscription: previous,
  });
  await aiAddonService.createCreditTransaction({
    workspaceId,
    subscription,
    userId,
    type: "adjustment",
    direction: "credit",
    credits: Number(plan.includedCredits || 0),
    tokens: aiAddonService.creditsToTokens(Number(plan.includedCredits || 0), Number(plan.tokensPerCredit || 1000)),
    amount: 0,
    currency: plan.currency || "INR",
    description: "Workspace AI plan assigned by super admin",
    metadata: { planId: String(plan._id), planKey: plan.planKey },
  });
  return {
    success: true,
    subscription: aiAddonService.serializeSubscription(subscription),
    workspace: {
      id: String(workspace._id),
      name: workspace.name || workspace.businessName || workspace.slug || "Workspace",
    },
  };
}

async function workspaceLookup({ query = "" }) {
  const search = String(query || "").trim();
  const filter = search
    ? {
        $or: [
          { name: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
          { businessName: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
          { slug: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        ],
      }
    : {};
  const rows = await Workspace.find(filter).sort({ updatedAt: -1 }).limit(20).select("_id name businessName slug aiAgentEnabled aiAddonPlanKey").lean();
  return {
    success: true,
    items: rows.map((row) => ({
      id: String(row._id),
      name: row.name || "",
      businessName: row.businessName || "",
      slug: row.slug || "",
      aiAgentEnabled: Boolean(row.aiAgentEnabled),
      aiAddonPlanKey: row.aiAddonPlanKey || "",
    })),
  };
}

async function getFinancialDashboard({ query = {} }) {
  return aiBillingOperationsService.getAdminFinancialDashboard({ query });
}

async function getLedgerHistory({ query = {} }) {
  return aiBillingOperationsService.listAdminLedgerHistory({ query });
}

async function issueWorkspaceFinancialAction({ workspaceId, actorId, actorName, payload = {} }) {
  if (!mongoose.Types.ObjectId.isValid(String(workspaceId || ""))) {
    throw new HttpError(400, "Invalid workspace id.");
  }
  return aiBillingOperationsService.applyAdminFinancialAction({
    workspaceId,
    actorId,
    actorName,
    type: payload.type,
    credits: payload.credits,
    reason: payload.reason,
    reference: payload.reference,
  });
}

async function listWorkspaceStatements({ query = {} }) {
  const workspaceId = String(query.workspaceId || "").trim();
  if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
    throw new HttpError(400, "workspaceId is required.");
  }
  return aiBillingOperationsService.listBillingStatements({ workspaceId, query });
}

async function getAdminReport({ query = {} }) {
  return aiBillingOperationsService.getAdminReport({ query });
}

async function downloadAdminReport({ query = {} }) {
  return aiBillingOperationsService.downloadAdminReportCsv({ query });
}

module.exports = {
  assignWorkspacePlan,
  changePlanStatus,
  changeTopupPackStatus,
  createPlan,
  createTopupPack,
  deletePlan,
  deleteTopupPack,
  downloadAdminReport,
  getFinancialDashboard,
  getLedgerHistory,
  getAdminReport,
  issueWorkspaceFinancialAction,
  listPlans,
  listSubscriptions,
  listWorkspaceStatements,
  listTopupPacks,
  updatePlan,
  updateTopupPack,
  workspaceLookup,
};
