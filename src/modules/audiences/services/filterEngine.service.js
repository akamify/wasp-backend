const mongoose = require("mongoose");
const { Contact } = require("@infra/database/Contact");
const { ContactAttributeDefinition } = require("@infra/database/ContactAttributeDefinition");
const { HttpError } = require("@shared/utils/httpError");

const STATIC_FIELD_CATALOG = [
  { field: "contact.name", label: "Name", category: "Contact Information", type: "text", path: "name" },
  { field: "contact.phone", label: "Mobile Number", category: "Contact Information", type: "text", path: "phone" },
  { field: "contact.email", label: "Email", category: "Contact Information", type: "text", path: "email" },
  { field: "contact.company", label: "Company", category: "Contact Information", type: "text", path: "company" },
  { field: "contact.country", label: "Country", category: "Contact Information", type: "text", path: "attributes.country" },
  { field: "contact.state", label: "State", category: "Contact Information", type: "text", path: "attributes.state" },
  { field: "contact.city", label: "City", category: "Contact Information", type: "text", path: "attributes.city" },
  { field: "contact.pincode", label: "Pincode", category: "Contact Information", type: "text", path: "attributes.pincode" },
  { field: "contact.language", label: "Language", category: "Contact Information", type: "text", path: "language" },
  { field: "contact.gender", label: "Gender", category: "Contact Information", type: "text", path: "attributes.gender" },
  { field: "contact.birthday", label: "Birthday", category: "Contact Information", type: "date", path: "attributes.birthday" },
  { field: "contact.createdAt", label: "Created Date", category: "Contact Information", type: "date", path: "createdAt" },
  { field: "contact.updatedAt", label: "Updated Date", category: "Contact Information", type: "date", path: "updatedAt" },
  { field: "tags", label: "Tags", category: "Tags & Attributes", type: "multi_select", path: "tags" },
  { field: "whatsapp.optedIn", label: "Opted In", category: "WhatsApp", type: "boolean", path: "whatsapp.optedIn" },
  { field: "whatsapp.optedOut", label: "Opted Out", category: "WhatsApp", type: "boolean", path: "whatsapp.optedOut" },
  { field: "whatsapp.blocked", label: "Blocked", category: "WhatsApp", type: "boolean", path: "whatsapp.blocked" },
  { field: "whatsapp.conversationOpen", label: "Conversation Open", category: "WhatsApp", type: "boolean", path: "conversation.serviceWindowStatus" },
  { field: "whatsapp.conversationClosed", label: "Conversation Closed", category: "WhatsApp", type: "boolean", path: "conversation.closedAt" },
  { field: "whatsapp.lastIncomingMessage", label: "Last Incoming Message", category: "WhatsApp", type: "date", path: "lastInboundAt" },
  { field: "whatsapp.lastOutgoingMessage", label: "Last Outgoing Message", category: "WhatsApp", type: "date", path: "lastOutboundAt" },
  { field: "whatsapp.lastReply", label: "Last Reply", category: "WhatsApp", type: "date", path: "conversation.lastCustomerMessageAt" },
  { field: "whatsapp.lastSeen", label: "Last Seen", category: "WhatsApp", type: "date", path: "conversation.lastMessageAt" },
  { field: "whatsapp.window24h", label: "24 Hour Window", category: "WhatsApp", type: "boolean", path: "conversation.canReply" },
  { field: "whatsapp.templateEligible", label: "Template Eligible", category: "WhatsApp", type: "boolean", path: "computed.templateEligible" },
  { field: "campaign.received", label: "Received Campaign", category: "Campaign", type: "boolean", path: "campaignFacts.anyReceived" },
  { field: "campaign.delivered", label: "Delivered", category: "Campaign", type: "boolean", path: "campaignFacts.anyDelivered" },
  { field: "campaign.read", label: "Read", category: "Campaign", type: "boolean", path: "campaignFacts.anyRead" },
  { field: "campaign.failed", label: "Failed", category: "Campaign", type: "boolean", path: "campaignFacts.anyFailed" },
  { field: "campaign.replied", label: "Replied", category: "Campaign", type: "boolean", path: "campaignFacts.anyReplied" },
  { field: "campaign.clickedButton", label: "Clicked Button", category: "Campaign", type: "boolean", path: "campaignFacts.anyButtonReply" },
  { field: "campaign.clickedUrl", label: "Clicked URL", category: "Campaign", type: "boolean", path: "campaignFacts.anyClickedUrl" },
  { field: "campaign.name", label: "Campaign Name", category: "Campaign", type: "text", path: "campaignFacts.lastCampaignName" },
  { field: "campaign.date", label: "Campaign Date", category: "Campaign", type: "date", path: "campaignFacts.lastCampaignDate" },
  { field: "crm.leadStatus", label: "Lead Status", category: "CRM", type: "text", path: "crm.status" },
  { field: "crm.leadStage", label: "Lead Stage", category: "CRM", type: "text", path: "crm.stage" },
  { field: "crm.assignedUser", label: "Assigned User", category: "CRM", type: "text", path: "crm.assignedEmployeeId" },
  { field: "crm.salesOwner", label: "Sales Owner", category: "CRM", type: "text", path: "crm.assignedEmployeeId" },
  { field: "crm.pipeline", label: "Pipeline", category: "CRM", type: "text", path: "crm.pipeline" },
  { field: "crm.dealValue", label: "Deal Value", category: "CRM", type: "number", path: "crm.dealValue" },
  { field: "crm.lastFollowUp", label: "Last Follow-up", category: "CRM", type: "date", path: "crm.lastFollowUpAt" },
  { field: "crm.nextFollowUp", label: "Next Follow-up", category: "CRM", type: "date", path: "crm.nextFollowUpAt" },
  { field: "crm.won", label: "Won", category: "CRM", type: "boolean", path: "crm.isWon" },
  { field: "crm.lost", label: "Lost", category: "CRM", type: "boolean", path: "crm.isLost" },
  { field: "ecommerce.totalOrders", label: "Total Orders", category: "Ecommerce", type: "number", path: "engagement.purchaseCount" },
  { field: "ecommerce.totalSpend", label: "Total Spend", category: "Ecommerce", type: "number", path: "engagement.totalRevenue" },
  { field: "ecommerce.averageOrder", label: "Average Order", category: "Ecommerce", type: "number", path: "commerce.averageOrder" },
  { field: "ecommerce.lastOrderDate", label: "Last Order Date", category: "Ecommerce", type: "date", path: "engagement.lastConversionAt" },
  { field: "ecommerce.productPurchased", label: "Product Purchased", category: "Ecommerce", type: "text", path: "commerce.lastProductName" },
  { field: "ecommerce.categoryPurchased", label: "Category Purchased", category: "Ecommerce", type: "text", path: "commerce.lastCategoryName" },
  { field: "ecommerce.couponUsed", label: "Coupon Used", category: "Ecommerce", type: "text", path: "commerce.lastCouponCode" },
  { field: "ecommerce.paymentMethod", label: "Payment Method", category: "Ecommerce", type: "text", path: "commerce.lastPaymentMethod" },
  { field: "ecommerce.abandonedCart", label: "Abandoned Cart", category: "Ecommerce", type: "boolean", path: "commerce.abandonedCart" },
  { field: "automation.enteredFlow", label: "Entered Flow", category: "AI & Automation", type: "boolean", path: "flowFacts.enteredFlow" },
  { field: "automation.completedFlow", label: "Completed Flow", category: "AI & Automation", type: "boolean", path: "flowFacts.completedFlow" },
  { field: "automation.exitedFlow", label: "Exited Flow", category: "AI & Automation", type: "boolean", path: "flowFacts.exitedFlow" },
  { field: "automation.aiReplied", label: "AI Replied", category: "AI & Automation", type: "boolean", path: "flowFacts.aiReplied" },
  { field: "automation.humanReplied", label: "Human Replied", category: "AI & Automation", type: "boolean", path: "flowFacts.humanReplied" },
  { field: "automation.assignedAiAgent", label: "Assigned AI Agent", category: "AI & Automation", type: "text", path: "flowFacts.aiAgentId" },
  { field: "automation.assignedHumanAgent", label: "Assigned Human Agent", category: "AI & Automation", type: "text", path: "conversation.assignedEmployeeId" },
  { field: "automation.escalated", label: "Escalated", category: "AI & Automation", type: "boolean", path: "flowFacts.escalated" },
  { field: "automation.liveChat", label: "Live Chat", category: "AI & Automation", type: "boolean", path: "flowFacts.liveChat" },
  { field: "automation.botConversation", label: "Bot Conversation", category: "AI & Automation", type: "boolean", path: "flowFacts.botConversation" },
];

const OPERATORS_BY_TYPE = {
  text: ["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "empty", "not_empty"],
  number: ["equals", "not_equals", "gt", "gte", "lt", "lte", "between"],
  date: ["today", "yesterday", "last_7_days", "last_30_days", "last_90_days", "between", "before", "after", "empty", "not_empty"],
  boolean: ["yes", "no"],
  multi_select: ["contains_any", "contains_all", "contains_none", "empty", "not_empty"],
};

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function normalizeNode(input, depth = 0) {
  if (depth > 8) throw new HttpError(400, "Filter nesting is too deep");
  const kind = String(input?.kind || "group").trim().toLowerCase();
  if (kind === "condition") {
    const field = String(input?.field || "").trim();
    const operator = String(input?.operator || "").trim().toLowerCase();
    if (!field || !operator) throw new HttpError(400, "Every filter condition needs field and operator");
    return {
      kind: "condition",
      field,
      fieldType: input?.fieldType ? String(input.fieldType).trim().toLowerCase() : null,
      operator,
      value: input?.value ?? null,
      secondaryValue: input?.secondaryValue ?? null,
    };
  }
  const operator = String(input?.operator || "and").trim().toLowerCase() === "or" ? "or" : "and";
  const conditions = (Array.isArray(input?.conditions) ? input.conditions : [])
    .map((item) => normalizeNode(item, depth + 1))
    .filter(Boolean);
  return { kind: "group", operator, conditions };
}

async function buildFilterCatalog({ workspaceId }) {
  const definitions = await ContactAttributeDefinition.find({ workspaceId })
    .sort({ label: 1, key: 1 })
    .lean();
  const dynamicFields = definitions.map((definition) => ({
    field: `attribute.${definition.key}`,
    label: definition.label,
    category: "Tags & Attributes",
    type: String(definition.type || "text"),
    path: `attributes.${definition.key}`,
    attributeKey: definition.key,
  }));
  return [...STATIC_FIELD_CATALOG, ...dynamicFields];
}

async function resolveFieldMeta({ workspaceId, field, fallbackType = null }) {
  const catalog = await buildFilterCatalog({ workspaceId });
  const direct = catalog.find((item) => item.field === field);
  if (direct) return direct;
  if (String(field || "").startsWith("attribute.")) {
    return {
      field,
      label: field.replace(/^attribute\./, ""),
      category: "Tags & Attributes",
      type: fallbackType || "text",
      path: `attributes.${field.replace(/^attribute\./, "")}`,
      attributeKey: field.replace(/^attribute\./, ""),
    };
  }
  throw new HttpError(400, `Unsupported filter field '${field}'`);
}

function collectDependencies(node, deps = new Set()) {
  if (!node) return deps;
  if (node.kind === "condition") {
    const field = String(node.field || "");
    if (field.startsWith("whatsapp.") || field.startsWith("crm.") || field.startsWith("automation.")) deps.add("conversation");
    if (field.startsWith("crm.")) deps.add("crm");
    if (field.startsWith("campaign.")) deps.add("campaign");
    if (field.startsWith("automation.")) deps.add("flow");
    return deps;
  }
  for (const child of node.conditions || []) collectDependencies(child, deps);
  return deps;
}

function castNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, "Filter value must be a number");
  return n;
}

function castDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "Filter value must be a valid date");
  return d;
}

function isBooleanPath(path) {
  return path.endsWith(".optedIn") || path.endsWith(".optedOut") || path.endsWith(".blocked") || path.startsWith("computed.") || path.startsWith("flowFacts.") || path === "conversation.canReply";
}

function buildConditionQuery(meta, condition) {
  const operator = String(condition.operator || "").toLowerCase();
  const path = meta.path;
  const type = String(meta.type || condition.fieldType || "text").toLowerCase();
  if (type === "text") {
    const value = String(condition.value ?? "").trim();
    if (operator === "equals") return { [path]: value };
    if (operator === "not_equals") return { [path]: { $ne: value } };
    if (operator === "contains") return { [path]: { $regex: value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } };
    if (operator === "not_contains") return { [path]: { $not: { $regex: value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } };
    if (operator === "starts_with") return { [path]: { $regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" } };
    if (operator === "ends_with") return { [path]: { $regex: `${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } };
    if (operator === "empty") return { $or: [{ [path]: null }, { [path]: "" }, { [path]: { $exists: false } }] };
    if (operator === "not_empty") return { [path]: { $nin: [null, ""] } };
  }
  if (type === "number") {
    if (operator === "between") {
      return { [path]: { $gte: castNumber(condition.value), $lte: castNumber(condition.secondaryValue) } };
    }
    const value = castNumber(condition.value);
    if (operator === "equals") return { [path]: value };
    if (operator === "not_equals") return { [path]: { $ne: value } };
    if (operator === "gt") return { [path]: { $gt: value } };
    if (operator === "gte") return { [path]: { $gte: value } };
    if (operator === "lt") return { [path]: { $lt: value } };
    if (operator === "lte") return { [path]: { $lte: value } };
  }
  if (type === "date") {
    const now = new Date();
    if (operator === "today") return { [path]: { $gte: startOfDay(now), $lte: endOfDay(now) } };
    if (operator === "yesterday") {
      const start = startOfDay(new Date(now.getTime() - 86400000));
      const end = endOfDay(new Date(now.getTime() - 86400000));
      return { [path]: { $gte: start, $lte: end } };
    }
    if (operator === "last_7_days") return { [path]: { $gte: startOfDay(new Date(now.getTime() - 6 * 86400000)), $lte: endOfDay(now) } };
    if (operator === "last_30_days") return { [path]: { $gte: startOfDay(new Date(now.getTime() - 29 * 86400000)), $lte: endOfDay(now) } };
    if (operator === "last_90_days") return { [path]: { $gte: startOfDay(new Date(now.getTime() - 89 * 86400000)), $lte: endOfDay(now) } };
    if (operator === "between") return { [path]: { $gte: castDate(condition.value), $lte: castDate(condition.secondaryValue) } };
    if (operator === "before") return { [path]: { $lt: castDate(condition.value) } };
    if (operator === "after") return { [path]: { $gt: castDate(condition.value) } };
    if (operator === "empty") return { $or: [{ [path]: null }, { [path]: { $exists: false } }] };
    if (operator === "not_empty") return { [path]: { $ne: null } };
  }
  if (type === "boolean" || isBooleanPath(path)) {
    if (operator === "yes") {
      if (path === "conversation.serviceWindowStatus") return { [path]: "open" };
      if (path === "conversation.closedAt") return { [path]: { $ne: null } };
      return { [path]: true };
    }
    if (operator === "no") {
      if (path === "conversation.serviceWindowStatus") return { [path]: { $ne: "open" } };
      if (path === "conversation.closedAt") return { $or: [{ [path]: null }, { [path]: { $exists: false } }] };
      return { [path]: { $ne: true } };
    }
  }
  if (type === "multi_select") {
    const values = Array.isArray(condition.value) ? condition.value : String(condition.value || "").split(",").map((item) => item.trim()).filter(Boolean);
    if (operator === "contains_any") return { [path]: { $in: values } };
    if (operator === "contains_all") return { [path]: { $all: values } };
    if (operator === "contains_none") return { [path]: { $nin: values } };
    if (operator === "empty") return { $or: [{ [path]: { $exists: false } }, { [path]: { $size: 0 } }] };
    if (operator === "not_empty") return { [path]: { $exists: true, $not: { $size: 0 } } };
  }
  throw new HttpError(400, `Operator '${operator}' is not supported for field '${meta.label}'`);
}

async function buildMatchQuery({ workspaceId, filterTree }) {
  const normalizedTree = normalizeNode(filterTree || { kind: "group", operator: "and", conditions: [] });

  async function compile(node) {
    if (node.kind === "condition") {
      const meta = await resolveFieldMeta({ workspaceId, field: node.field, fallbackType: node.fieldType });
      return buildConditionQuery(meta, node);
    }
    const compiledChildren = [];
    for (const child of node.conditions || []) {
      compiledChildren.push(await compile(child));
    }
    const validChildren = compiledChildren.filter(Boolean);
    if (!validChildren.length) return {};
    if (validChildren.length === 1) return validChildren[0];
    return { [node.operator === "or" ? "$or" : "$and"]: validChildren };
  }

  return {
    normalizedTree,
    dependencies: Array.from(collectDependencies(normalizedTree)),
    matchQuery: await compile(normalizedTree),
  };
}

function buildLookupStages({ dependencies }) {
  const stages = [];
  if (dependencies.includes("conversation")) {
    stages.push(
      {
        $lookup: {
          from: "conversations",
          let: { workspaceId: "$workspaceId", phone: "$phone", wabaId: "$wabaId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$workspaceId", "$$workspaceId"] },
                    { $eq: ["$phone", "$$phone"] },
                    { $eq: ["$wabaId", "$$wabaId"] },
                  ],
                },
              },
            },
            { $sort: { updatedAt: -1 } },
            { $limit: 1 },
          ],
          as: "conversationDocs",
        },
      },
      {
        $addFields: {
          conversation: {
            $ifNull: [{ $arrayElemAt: ["$conversationDocs", 0] }, {}],
          },
          computed: {
            templateEligible: {
              $and: [
                { $ne: ["$whatsapp.optedOut", true] },
                { $ne: ["$whatsapp.blocked", true] },
              ],
            },
          },
        },
      }
    );
  } else {
    stages.push({
      $addFields: {
        computed: {
          templateEligible: {
            $and: [
              { $ne: ["$whatsapp.optedOut", true] },
              { $ne: ["$whatsapp.blocked", true] },
            ],
          },
        },
      },
    });
  }

  if (dependencies.includes("crm")) {
    stages.push(
      {
        $lookup: {
          from: "crmleads",
          let: { workspaceId: "$workspaceId", phone: "$phone" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$workspaceId", "$$workspaceId"] },
                    { $eq: ["$phone", "$$phone"] },
                  ],
                },
              },
            },
            { $sort: { updatedAt: -1 } },
            { $limit: 1 },
          ],
          as: "crmDocs",
        },
      },
      { $addFields: { crm: { $ifNull: [{ $arrayElemAt: ["$crmDocs", 0] }, {}] } } }
    );
  }

  if (dependencies.includes("campaign")) {
    stages.push(
      {
        $lookup: {
          from: "messages",
          let: { workspaceId: "$workspaceId", phone: "$phone" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$workspaceId", "$$workspaceId"] },
                    { $eq: ["$phone", "$$phone"] },
                    { $ne: ["$campaignId", null] },
                  ],
                },
              },
            },
            {
              $lookup: {
                from: "campaigns",
                localField: "campaignId",
                foreignField: "_id",
                as: "campaignDoc",
              },
            },
            {
              $addFields: {
                campaignName: {
                  $ifNull: [{ $getField: { field: "name", input: { $arrayElemAt: ["$campaignDoc", 0] } } }, null],
                },
              },
            },
            {
              $project: {
                _id: 1,
                status: 1,
                direction: 1,
                createdAt: 1,
                sentAt: 1,
                "tracking.clicked": 1,
                buttonReply: 1,
                campaignName: 1,
              },
            },
            { $sort: { createdAt: -1 } },
          ],
          as: "campaignMessageDocs",
        },
      },
      {
        $addFields: {
          campaignFacts: {
            anyReceived: { $gt: [{ $size: "$campaignMessageDocs" }, 0] },
            anyDelivered: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: "$campaignMessageDocs",
                      as: "item",
                      cond: { $in: ["$$item.status", ["delivered", "read"]] },
                    },
                  },
                },
                0,
              ],
            },
            anyRead: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: "$campaignMessageDocs",
                      as: "item",
                      cond: { $eq: ["$$item.status", "read"] },
                    },
                  },
                },
                0,
              ],
            },
            anyFailed: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: "$campaignMessageDocs",
                      as: "item",
                      cond: { $eq: ["$$item.status", "failed"] },
                    },
                  },
                },
                0,
              ],
            },
            anyClickedUrl: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: "$campaignMessageDocs",
                      as: "item",
                      cond: { $eq: ["$$item.tracking.clicked", true] },
                    },
                  },
                },
                0,
              ],
            },
            anyButtonReply: false,
            anyReplied: {
              $cond: [
                { $and: [{ $gt: [{ $size: "$campaignMessageDocs" }, 0] }, { $ne: ["$lastInboundAt", null] }] },
                {
                  $gt: [
                    "$lastInboundAt",
                    { $ifNull: [{ $getField: { field: "createdAt", input: { $arrayElemAt: ["$campaignMessageDocs", 0] } } }, new Date(0)] },
                  ],
                },
                false,
              ],
            },
            lastCampaignName: { $ifNull: [{ $getField: { field: "campaignName", input: { $arrayElemAt: ["$campaignMessageDocs", 0] } } }, null] },
            lastCampaignDate: { $ifNull: [{ $getField: { field: "createdAt", input: { $arrayElemAt: ["$campaignMessageDocs", 0] } } }, null] },
          },
        },
      }
    );
  }

  if (dependencies.includes("flow")) {
    stages.push(
      {
        $lookup: {
          from: "flowsessions",
          let: { workspaceId: "$workspaceId", contactId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$workspaceId", "$$workspaceId"] },
                    { $eq: ["$contactId", "$$contactId"] },
                  ],
                },
              },
            },
            { $sort: { updatedAt: -1, createdAt: -1 } },
          ],
          as: "flowDocs",
        },
      },
      {
        $addFields: {
          flowFacts: {
            enteredFlow: { $gt: [{ $size: "$flowDocs" }, 0] },
            completedFlow: {
              $gt: [
                { $size: { $filter: { input: "$flowDocs", as: "item", cond: { $eq: ["$$item.status", "completed"] } } } },
                0,
              ],
            },
            exitedFlow: {
              $gt: [
                { $size: { $filter: { input: "$flowDocs", as: "item", cond: { $in: ["$$item.status", ["failed", "expired", "handover"]] } } } },
                0,
              ],
            },
            aiReplied: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: "$flowDocs",
                      as: "item",
                      cond: { $ne: ["$$item.currentNodeId", null] },
                    },
                  },
                },
                0,
              ],
            },
            humanReplied: { $gt: [{ $ifNull: ["$conversation.lastEmployeeReplyAt", null] }, null] },
            aiAgentId: "$ai.agentId",
            escalated: {
              $gt: [
                { $size: { $filter: { input: "$flowDocs", as: "item", cond: { $eq: ["$$item.status", "handover"] } } } },
                0,
              ],
            },
            liveChat: { $gt: [{ $ifNull: ["$conversation.assignedEmployeeId", null] }, null] },
            botConversation: { $gt: [{ $size: "$flowDocs" }, 0] },
          },
        },
      }
    );
  }

  return stages;
}

async function buildPreviewPipeline({ workspaceId, wabaId, filterTree, page = 1, limit = 25, contactIds = null }) {
  const workspaceObjectId = new mongoose.Types.ObjectId(String(workspaceId));
  const { normalizedTree, dependencies, matchQuery } = await buildMatchQuery({ workspaceId, filterTree });
  const baseMatch = { workspaceId: workspaceObjectId, wabaId: String(wabaId || "").trim() };
  if (Array.isArray(contactIds) && contactIds.length) {
    const validIds = contactIds
      .map((id) => String(id || "").trim())
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    baseMatch._id = { $in: validIds };
  }
  const skip = Math.max(Number(page || 1) - 1, 0) * Math.max(Number(limit || 25), 1);
  const safeLimit = Math.min(Math.max(Number(limit || 25), 1), 100);
  return {
    normalizedTree,
    pipeline: [
      { $match: baseMatch },
      ...buildLookupStages({ dependencies }),
      Object.keys(matchQuery || {}).length ? { $match: matchQuery } : null,
      {
        $facet: {
          contacts: [
            { $sort: { updatedAt: -1, createdAt: -1 } },
            { $skip: skip },
            { $limit: safeLimit },
          ],
          totals: [{ $count: "count" }],
        },
      },
    ].filter(Boolean),
  };
}

async function previewContacts({ workspaceId, wabaId, filterTree, page = 1, limit = 25, contactIds = null }) {
  const { normalizedTree, pipeline } = await buildPreviewPipeline({ workspaceId, wabaId, filterTree, page, limit, contactIds });
  const [result] = await Contact.aggregate(pipeline);
  const contacts = Array.isArray(result?.contacts) ? result.contacts : [];
  const total = Number(result?.totals?.[0]?.count || 0);
  return {
    filterTree: normalizedTree,
    contacts,
    total,
    page: Math.max(Number(page || 1), 1),
    limit: Math.min(Math.max(Number(limit || 25), 1), 100),
    totalPages: Math.max(1, Math.ceil(total / Math.min(Math.max(Number(limit || 25), 1), 100))),
  };
}

async function countContacts({ workspaceId, wabaId, filterTree, contactIds = null }) {
  const preview = await previewContacts({ workspaceId, wabaId, filterTree, page: 1, limit: 1, contactIds });
  return {
    filterTree: preview.filterTree,
    total: preview.total,
  };
}

module.exports = {
  OPERATORS_BY_TYPE,
  STATIC_FIELD_CATALOG,
  buildFilterCatalog,
  normalizeNode,
  previewContacts,
  countContacts,
};
