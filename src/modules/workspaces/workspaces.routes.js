const express = require("express");
const { auth } = require("@core/middleware/auth");
const { validate } = require("@core/middleware/validate");
const { workspacesController } = require("@modules/workspaces/controllers/index");
const { workspacesValidation } = require("@modules/workspaces/validations/index");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { currentBilling, currentWallet } = require("@modules/workspaces/controllers/workspaceScopedBilling.controller");

const router = express.Router();

router.get("/", auth, workspacesController.listWorkspaces);
router.post("/", auth, validate(workspacesValidation.createWorkspaceSchema), workspacesController.createWorkspace);
router.get("/:workspaceId/overview", auth, asyncHandler(workspacesController.getWorkspaceOverview));
router.patch("/:workspaceId", auth, validate(workspacesValidation.updateWorkspaceSchema), asyncHandler(workspacesController.updateWorkspace));
router.get("/:workspaceId/members", auth, asyncHandler(workspacesController.listMembers));
router.post("/:workspaceId/members", auth, validate(workspacesValidation.inviteMemberSchema), asyncHandler(workspacesController.inviteMember));
router.patch("/:workspaceId/members/:memberId", auth, validate(workspacesValidation.updateMemberSchema), asyncHandler(workspacesController.updateMember));
router.get("/:workspaceId/usage", auth, asyncHandler(workspacesController.listUsage));
router.get("/:workspaceId/activity", auth, asyncHandler(workspacesController.listActivity));
router.get("/:workspaceId/billing/current", auth, asyncHandler(currentBilling));
router.get("/:workspaceId/wallet", auth, asyncHandler(currentWallet));

module.exports = router;

