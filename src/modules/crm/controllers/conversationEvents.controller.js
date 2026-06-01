const { Conversation } = require("@infra/database/Conversation");
const { ConversationEvent } = require("@infra/database/ConversationEvent");
const { HttpError } = require("@shared/utils/httpError");
const { normalizePhone } = require("@shared/services/contactService");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

function parseLimit(req) {
  const raw = Number(req.query.limit || 50);
  return Math.min(Math.max(Number.isFinite(raw) ? raw : 50, 1), 200);
}

function mapEvent(doc) {
  return {
    id: String(doc._id),
    type: doc.type,
    actor: doc.actor || null,
    payload: doc.payload || null,
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

  res.json({ success: true, items: items.map(mapEvent) });
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

  res.json({ success: true, items: items.map(mapEvent) });
}

module.exports = { listOwnerConversationEvents, listEmployeeConversationEvents };
