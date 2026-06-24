const {
  findLatestWaitingInteractiveMessage,
  findMessageByWamid,
} = require("../repositories/inboundReplyContext.repository");

function previewFromMessage(message) {
  return String(
    message?.displayText || message?.previewText || message?.text ||
    message?.payload?.interactive?.body?.text || message?.payload?.template?.name || ""
  ).trim().slice(0, 240);
}

async function resolveInboundReplyContext({ workspaceId, wabaId, phone, inboundMessage, inboundAt }) {
  const buttonReply = inboundMessage?.interactive?.button_reply;
  const listReply = inboundMessage?.interactive?.list_reply;
  if (!buttonReply && !listReply) return {};

  const contextWamid = String(inboundMessage?.context?.id || "").trim();
  let original = contextWamid
    ? await findMessageByWamid({ workspaceId, wabaId, wamid: contextWamid })
    : null;
  if (!original && !contextWamid) {
    original = await findLatestWaitingInteractiveMessage({
      workspaceId,
      wabaId,
      phone,
      since: new Date(inboundAt.getTime() - 24 * 60 * 60 * 1000),
    });
  }

  const reply = buttonReply || listReply;
  return {
    interactiveReplyId: String(reply?.id || "").trim() || null,
    interactiveReplyTitle: String(reply?.title || "").trim() || null,
    contextWamid: contextWamid || String(original?.whatsappMessageId || "").trim() || null,
    replyToMessageId: String(original?.whatsappMessageId || contextWamid || "").trim() || null,
    replyToPreview: previewFromMessage(original) || null,
    replyToType: String(original?.type || original?.payload?.interactive?.type || "").trim() || null,
  };
}

module.exports = { resolveInboundReplyContext };
