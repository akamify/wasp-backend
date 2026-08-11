const express = require("express");
const { authOrApiKey } = require("@core/middleware/authOrApiKey");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { blockInternalChatForApiKey } = require("@core/middleware/blockInternalChatForApiKey");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { requireApiPermission } = require("@modules/api-keys/middleware/requireApiPermission");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const {
  listConversations,
  getConversation,
  readConversation,
  clearConversation,
  takeOverAiConversation,
  returnAiConversation,
  releaseAiFlowBlock,
} = require("@modules/conversations/controllers/conversation.controller");

const router = express.Router();
const requireInboxAccess = requireBillingFeature("inboxPageAccess", {
  message: "Your current plan does not include inbox access.",
});

router.get("/", authOrApiKey, blockInternalChatForApiKey, requireWorkspace, requireWorkspacePermission("inbox.view"), requireInboxAccess, requireApiPermission("chatAccess"), asyncHandler(listConversations));
router.post("/:phone/read", authOrApiKey, blockInternalChatForApiKey, requireWorkspace, requireWorkspacePermission("inbox.reply"), requireInboxAccess, requireApiPermission("chatAccess"), asyncHandler(readConversation));
router.post("/:phone/take-over", authOrApiKey, blockInternalChatForApiKey, requireWorkspace, requireWorkspacePermission("inbox.reply"), requireInboxAccess, requireApiPermission("chatAccess"), asyncHandler(takeOverAiConversation));
router.post("/:phone/return-to-ai", authOrApiKey, blockInternalChatForApiKey, requireWorkspace, requireWorkspacePermission("inbox.reply"), requireInboxAccess, requireApiPermission("chatAccess"), asyncHandler(returnAiConversation));
router.post("/:phone/release-flow-block", authOrApiKey, blockInternalChatForApiKey, requireWorkspace, requireWorkspacePermission("inbox.reply"), requireInboxAccess, requireApiPermission("chatAccess"), asyncHandler(releaseAiFlowBlock));
router.get("/:phone", authOrApiKey, blockInternalChatForApiKey, requireWorkspace, requireWorkspacePermission("inbox.view"), requireInboxAccess, requireApiPermission("chatAccess"), asyncHandler(getConversation));
router.delete("/:phone", authOrApiKey, blockInternalChatForApiKey, requireWorkspace, requireWorkspacePermission("inbox.reply"), requireInboxAccess, requireApiPermission("chatAccess"), asyncHandler(clearConversation));
module.exports = router;

