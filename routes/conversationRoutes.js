const express = require("express");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { asyncHandler } = require("../utils/asyncHandler");
const {
  listConversations,
  getConversation,
  readConversation,
  clearConversation,
} = require("../controllers/conversationController");

const router = express.Router();

router.get("/", auth, requireWorkspace, asyncHandler(listConversations));
router.post("/:phone/read", auth, requireWorkspace, asyncHandler(readConversation));
router.get("/:phone", auth, requireWorkspace, asyncHandler(getConversation));
router.delete("/:phone", auth, requireWorkspace, asyncHandler(clearConversation));
module.exports = router;
