const { Contact } = require("@infra/database/Contact");
const { FlowSession } = require("@infra/database/FlowSession");
const { Message } = require("@infra/database/Message");

async function findMessageByWamid({ workspaceId, wabaId, wamid }) {
  return Message.findOne({ workspaceId, wabaId, whatsappMessageId: wamid }).lean();
}

async function findLatestWaitingInteractiveMessage({ workspaceId, wabaId, phone, since }) {
  const contact = await Contact.findOne({ workspaceId, wabaId, phone }).select("_id").lean();
  if (!contact?._id) return null;
  const waitingSession = await FlowSession.findOne({
    workspaceId,
    contactId: contact._id,
    status: "active",
    "waitingFor.type": { $in: ["button_reply", "list_reply"] },
  }).select("_id").lean();
  if (!waitingSession) return null;
  return Message.findOne({
    workspaceId,
    wabaId,
    phone,
    direction: "outbound",
    sortAt: { $gte: since },
    $or: [
      { type: { $in: ["interactive_buttons", "interactive_list"] } },
      { "payload.interactive.type": { $in: ["button", "list"] } },
    ],
  }).sort({ sortAt: -1, createdAt: -1 }).lean();
}

module.exports = { findLatestWaitingInteractiveMessage, findMessageByWamid };
