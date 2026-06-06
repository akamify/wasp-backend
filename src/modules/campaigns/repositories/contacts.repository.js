const { Contact } = require("@infra/database/Contact");

function findContactsByPhones({ workspaceId, wabaId, phones, select }) {
    return Contact.find({ workspaceId, wabaId, phone: { $in: phones } }).select(select || undefined);
}

function findContactsByTags({ workspaceId, wabaId, tags, tagMatch, select, limit }) {
    const normalizedTags = Array.from(new Set((tags || []).map((tag) => String(tag || "").trim()).filter(Boolean)));
    if (!normalizedTags.length) return [];
    const tagQuery = String(tagMatch || "all") === "any" ? { $in: normalizedTags } : { $all: normalizedTags };
    return Contact.find({ workspaceId, wabaId, tags: tagQuery })
        .select(select || "phone name email company language attributes")
        .sort({ updatedAt: -1, _id: 1 })
        .limit(Math.min(Math.max(Number(limit || 50000), 1), 50000))
        .lean();
}

function findContactsByAttributeFilters({ workspaceId, wabaId, filters, limit }) {
    const query = { workspaceId, wabaId };
    if (filters?.length) query.$and = filters;
    return Contact.find(query)
        .select("phone name email company language attributes tags")
        .sort({ updatedAt: -1, _id: 1 })
        .limit(Math.min(Math.max(Number(limit || 50000), 1), 50000))
        .lean();
}

module.exports = { findContactsByPhones, findContactsByTags, findContactsByAttributeFilters };
