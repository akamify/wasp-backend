const { Conversation } = require("@infra/database/Conversation");

async function reconcileServiceWindow({ workspaceId, wabaId, customerPhone, inboundAt, expiresAt, updatedAt }) {
  return Conversation.findOneAndUpdate(
    { workspaceId, wabaId, phone: customerPhone },
    {
      $max: {
        lastInboundAt: inboundAt,
        lastInboundMessageAt: inboundAt,
        lastCustomerMessageAt: inboundAt,
        customerServiceWindowExpiresAt: expiresAt,
      },
      $set: {
        serviceWindowStatus: "open",
        canReply: true,
        serviceWindowUpdatedAt: updatedAt,
      },
      $setOnInsert: {
        workspaceId,
        wabaId,
        phone: customerPhone,
        normalizedPhone: customerPhone,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

async function findConversationWindow({ workspaceId, wabaId, customerPhone }) {
  return Conversation.findOne({ workspaceId, wabaId, phone: customerPhone })
    .select("customerServiceWindowExpiresAt lastCustomerMessageAt serviceWindowStatus canReply")
    .lean();
}

module.exports = { reconcileServiceWindow, findConversationWindow };
