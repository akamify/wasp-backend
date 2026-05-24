const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { Message } = require("@infra/database/Message");
const { campaignsRepository, messagesRepository, contactsRepository, transactionsRepository } = require("@modules/campaigns/repositories/index");

async function listCampaigns(req) {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const items = await campaignsRepository.listCampaignsByWorkspace(req.workspace.id, limit);
    return { success: true, campaigns: items };
}

async function getCampaign(req) {
    const item = await campaignsRepository.getCampaignById({ id: req.params.id, workspaceId: req.workspace.id });
    if (!item) throw new HttpError(404, "Campaign not found");
    return { success: true, campaign: item };
}

async function getCampaignMetrics(req) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
    const campaign = await campaignsRepository.getCampaignById({ id, workspaceId: req.workspace.id });
    if (!campaign) throw new HttpError(404, "Campaign not found");

    const match = { workspaceId: campaign.workspaceId, campaignId: campaign._id, direction: "outbound" };
    const statusRankExpr = {
        $switch: {
            branches: [
                { case: { $in: ["$status", ["failed", "timeout_unknown"]] }, then: 0 },
                { case: { $in: ["$status", ["sent", "accepted"]] }, then: 1 },
                { case: { $eq: ["$status", "delivered"] }, then: 2 },
                { case: { $eq: ["$status", "read"] }, then: 3 },
            ],
            default: 1,
        },
    };
    const contactAgg = await messagesRepository.aggregateMessages([
        { $match: match },
        { $addFields: { statusRank: statusRankExpr } },
        { $group: { _id: "$phone", statusRank: { $max: "$statusRank" } } },
        { $group: { _id: "$statusRank", count: { $sum: 1 } } },
    ]);
    const countsByRank = Object.fromEntries(contactAgg.map((row) => [String(row._id), Number(row.count || 0)]));
    const phones = await Message.distinct("phone", match);
    const repliedPhones = phones.length
        ? await Message.distinct("phone", { workspaceId: campaign.workspaceId, direction: "inbound", phone: { $in: phones }, createdAt: { $gte: campaign.createdAt } })
        : [];

    return {
        success: true,
        campaignId: String(campaign._id),
        audienceTotal: campaign.totals?.total || phones.length || 0,
        counts: {
            queued: Number(campaign.totals?.queued || 0),
            accepted: 0,
            sent: countsByRank["1"] || 0,
            delivered: countsByRank["2"] || 0,
            read: countsByRank["3"] || 0,
            failed: countsByRank["0"] || 0,
            replied: repliedPhones.length || 0,
        },
        updatedAt: new Date().toISOString(),
    };
}

async function listCampaignMessages(req) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
    const campaign = await campaignsRepository.getCampaignById({ id, workspaceId: req.workspace.id });
    if (!campaign) throw new HttpError(404, "Campaign not found");

    const tab = String(req.query.tab || "overview");
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const page = Math.min(Math.max(Number(req.query.page || 1), 1), 50000);
    const skip = (page - 1) * limit;
    const tabRankMap = { sent: 1, delivered: 2, read: 3, failed: 0 };
    const tabRank = tabRankMap[String(tab || "").toLowerCase()];
    if (typeof tabRank !== "number") return { success: true, tab, page, limit, total: 0, items: [] };

    const baseMatch = { workspaceId: campaign.workspaceId, campaignId: campaign._id, direction: "outbound" };
    const statusRankExpr = {
        $switch: {
            branches: [
                { case: { $in: ["$status", ["failed", "timeout_unknown"]] }, then: 0 },
                { case: { $in: ["$status", ["sent", "accepted"]] }, then: 1 },
                { case: { $eq: ["$status", "delivered"] }, then: 2 },
                { case: { $eq: ["$status", "read"] }, then: 3 },
            ],
            default: 1,
        },
    };
    const statusFromRankExpr = {
        $switch: {
            branches: [
                { case: { $eq: ["$statusRank", 0] }, then: "failed" },
                { case: { $eq: ["$statusRank", 1] }, then: "sent" },
                { case: { $eq: ["$statusRank", 2] }, then: "delivered" },
                { case: { $eq: ["$statusRank", 3] }, then: "read" },
            ],
            default: "sent",
        },
    };
    const basePipeline = [
        { $match: baseMatch },
        { $addFields: { statusRank: statusRankExpr } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$phone", phone: { $first: "$phone" }, statusRank: { $max: "$statusRank" }, createdAt: { $first: "$createdAt" }, whatsappMessageId: { $first: "$whatsappMessageId" }, error: { $first: "$error" }, statusTimestamps: { $first: "$statusTimestamps" } } },
        { $addFields: { status: statusFromRankExpr } },
    ];
    const [countAgg, itemsAgg] = await Promise.all([
        messagesRepository.aggregateMessages([...basePipeline, { $match: { statusRank: tabRank } }, { $count: "total" }]),
        messagesRepository.aggregateMessages([...basePipeline, { $match: { statusRank: tabRank } }, { $sort: { createdAt: -1 } }, { $skip: skip }, { $limit: limit }]),
    ]);
    const total = Number(countAgg?.[0]?.total || 0);
    const phones = itemsAgg.map((m) => m.phone).filter(Boolean);
    const contacts = phones.length ? await contactsRepository.findContactsByPhones({ workspaceId: campaign.workspaceId, phones, select: "phone name" }) : [];
    const contactMap = new Map(contacts.map((c) => [String(c.phone), String(c.name || "")]));
    return { success: true, tab, page, limit, total, items: itemsAgg.map((m) => ({ id: String(m._id || m.phone || ""), phone: m.phone, name: contactMap.get(String(m.phone)) || "", status: m.status, createdAt: m.createdAt, whatsappMessageId: m.whatsappMessageId || null, error: m.error || null, statusTimestamps: m.statusTimestamps || null })) };
}

async function listCampaignReplies(req) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
    const campaign = await campaignsRepository.getCampaignById({ id, workspaceId: req.workspace.id });
    if (!campaign) throw new HttpError(404, "Campaign not found");
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const page = Math.min(Math.max(Number(req.query.page || 1), 1), 50000);
    const skip = (page - 1) * limit;
    const phones = await messagesRepository.distinctPhones({ workspaceId: campaign.workspaceId, campaignId: campaign._id, direction: "outbound" });
    if (!phones.length) return { success: true, page, limit, total: 0, items: [] };
    const pipeline = [{ $match: { workspaceId: campaign.workspaceId, direction: "inbound", phone: { $in: phones }, createdAt: { $gte: campaign.createdAt } } }, { $sort: { createdAt: -1 } }, { $group: { _id: "$phone", phone: { $first: "$phone" }, text: { $first: "$text" }, createdAt: { $first: "$createdAt" } } }];
    const [grouped, totalAgg] = await Promise.all([
        messagesRepository.aggregateMessages([...pipeline, { $skip: skip }, { $limit: limit }]),
        messagesRepository.aggregateMessages([...pipeline, { $count: "total" }]),
    ]);
    const total = Number(totalAgg?.[0]?.total || 0);
    const replyPhones = grouped.map((r) => String(r.phone || "")).filter(Boolean);
    const contacts = replyPhones.length ? await contactsRepository.findContactsByPhones({ workspaceId: campaign.workspaceId, phones: replyPhones, select: "phone name" }) : [];
    const contactMap = new Map(contacts.map((c) => [String(c.phone), String(c.name || "")]));
    return { success: true, page, limit, total, items: grouped.map((r) => ({ phone: String(r.phone || ""), name: contactMap.get(String(r.phone)) || "", text: String(r.text || ""), createdAt: r.createdAt })) };
}

async function getCampaignCreditUsage(req) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
    const campaign = await campaignsRepository.getCampaignById({ id, workspaceId: req.workspace.id });
    if (!campaign) throw new HttpError(404, "Campaign not found");
    const rows = await transactionsRepository.aggregateTransactions([{ $match: { workspaceId: campaign.workspaceId, "meta.campaignId": String(campaign._id) } }, { $group: { _id: "$type", amount: { $sum: "$amount" } } }]);
    const debits = Number(rows.find((r) => r._id === "debit")?.amount || 0);
    const credits = Number(rows.find((r) => r._id === "credit")?.amount || 0);
    return { success: true, campaignId: String(campaign._id), currency: "INR", debits, credits, net: Math.max(debits - credits, 0) };
}

module.exports = { listCampaigns, getCampaign, getCampaignMetrics, listCampaignMessages, listCampaignReplies, getCampaignCreditUsage };
