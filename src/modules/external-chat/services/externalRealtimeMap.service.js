const { Conversation } = require("@infra/database/Conversation");
const { Message } = require("@infra/database/Message");
const { toExternalMessageDto } = require("@modules/external-chat/dto/externalMessage.dto");
const { toExternalConversationDto } = require("@modules/external-chat/dto/externalConversation.dto");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

async function findMessageForEvent(workspaceId, wabaId, event) {
  if (event?.messageId) {
    const byId = await Message.findOne({ _id: event.messageId, workspaceId, wabaId });
    if (byId) return byId;
  }

  if (event?.whatsappMessageId) {
    const byWaId = await Message.findOne({ workspaceId, wabaId, whatsappMessageId: event.whatsappMessageId });
    if (byWaId) return byWaId;
  }

  if (event?.phone) {
    return Message.findOne({ workspaceId, wabaId, phone: String(event.phone) }).sort({ createdAt: -1, _id: -1 });
  }

  return null;
}

async function findConversationForEvent(workspaceId, wabaId, event) {
  if (event?.conversationId) {
    const byId = await Conversation.findOne({ _id: event.conversationId, workspaceId, wabaId });
    if (byId) return byId;
  }

  if (event?.phone) {
    return Conversation.findOne({ workspaceId, wabaId, phone: String(event.phone) });
  }

  return null;
}

async function mapExternalRealtimeEvent(workspaceId, event) {
  const scope = await requireActiveWabaScope(workspaceId);
  const eventType = String(event?.type || "").toLowerCase();

  if (["message_inbound", "message_outbound"].includes(eventType)) {
    const message = await findMessageForEvent(workspaceId, scope.wabaId, event);
    if (!message) return null;
    return {
      type: "message.created",
      data: {
        message: toExternalMessageDto(message),
      },
    };
  }

  if (eventType === "message_status") {
    const message = await findMessageForEvent(workspaceId, scope.wabaId, event);
    if (!message) return null;
    return {
      type: "message.status_updated",
      data: {
        message: toExternalMessageDto(message),
      },
    };
  }

  if (eventType === "conversation.updated") {
    const conversation = await findConversationForEvent(workspaceId, scope.wabaId, event);
    if (!conversation) return null;
    return {
      type: "conversation.updated",
      data: {
        conversation: toExternalConversationDto(conversation),
      },
    };
  }

  return null;
}

module.exports = { mapExternalRealtimeEvent };
