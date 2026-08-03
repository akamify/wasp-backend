const { Conversation } = require("@infra/database/Conversation");
const { ConversationEvent } = require("@infra/database/ConversationEvent");
const { Employee } = require("@infra/database/Employee");
const { HttpError } = require("@shared/utils/httpError");
const { normalizePhone } = require("@shared/services/contactService");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

function parseLimit(req) {
  const raw = Number(req.query.limit || 50);
  return Math.min(Math.max(Number.isFinite(raw) ? raw : 50, 1), 200);
}

async function buildEmployeeNameMap(workspaceId, items) {
  const employeeIds = new Set();
  for (const item of items || []) {
    const actorId = item?.actor?.actorId ? String(item.actor.actorId) : "";
    if (actorId) employeeIds.add(actorId);
    ["assignedEmployeeId", "toEmployeeId", "fromEmployeeId"].forEach((key) => {
      const value = item?.payload?.[key] ? String(item.payload[key]) : "";
      if (value) employeeIds.add(value);
    });
  }
  if (!employeeIds.size) return new Map();
  const employees = await Employee.find({
    workspaceId,
    _id: { $in: Array.from(employeeIds) },
  })
    .select("_id name email")
    .lean();
  return new Map(
    employees.map((employee) => [
      String(employee._id),
      String(employee.name || employee.email || employee._id),
    ])
  );
}

function mapEvent(doc, employeeNames = new Map()) {
  const actorId = doc?.actor?.actorId ? String(doc.actor.actorId) : "";
  const payload = doc?.payload || null;
  const resolvedPayload = payload
    ? {
        ...payload,
        fromEmployeeName: payload?.fromEmployeeId ? employeeNames.get(String(payload.fromEmployeeId)) || null : null,
        toEmployeeName: payload?.toEmployeeId ? employeeNames.get(String(payload.toEmployeeId)) || null : null,
        assignedEmployeeName: payload?.assignedEmployeeId ? employeeNames.get(String(payload.assignedEmployeeId)) || null : null,
      }
    : null;
  return {
    id: String(doc._id),
    type: doc.type,
    actor: doc.actor
      ? {
          ...doc.actor,
          resolvedName: actorId ? employeeNames.get(actorId) || doc.actor?.nameSnapshot || null : doc.actor?.nameSnapshot || null,
        }
      : null,
    payload: resolvedPayload,
    createdAt: doc.createdAt,
  };
}

async function listOwnerConversationEvents(req, res) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  const conversation = await Conversation.findOne({ workspaceId: req.workspace.id, wabaId: scope.wabaId, phone }).select("_id phone");
  if (!conversation) throw new HttpError(404, "Conversation not found");

  const limit = parseLimit(req);
  const items = await ConversationEvent.find({
    workspaceId: req.workspace.id,
    conversationId: conversation._id,
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit);

  const employeeNames = await buildEmployeeNameMap(req.workspace.id, items);
  res.json({ success: true, items: items.map((item) => mapEvent(item, employeeNames)) });
}

async function listEmployeeConversationEvents(req, res) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  const conversation = await Conversation.findOne({ workspaceId: req.workspace.id, wabaId: scope.wabaId, phone }).select(
    "_id phone assignedEmployeeId"
  );
  if (!conversation) throw new HttpError(404, "Conversation not found");

  const assignedId = conversation.assignedEmployeeId ? String(conversation.assignedEmployeeId) : "";
  if (!assignedId || assignedId !== String(req.employee.id)) {
    throw new HttpError(403, "Forbidden");
  }

  const limit = parseLimit(req);
  const items = await ConversationEvent.find({
    workspaceId: req.workspace.id,
    conversationId: conversation._id,
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit);

  const employeeNames = await buildEmployeeNameMap(req.workspace.id, items);
  res.json({ success: true, items: items.map((item) => mapEvent(item, employeeNames)) });
}

module.exports = { listOwnerConversationEvents, listEmployeeConversationEvents };
