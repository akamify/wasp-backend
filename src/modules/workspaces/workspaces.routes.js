const express = require("express");
const { auth } = require("@core/middleware/auth");
const { validate } = require("@core/middleware/validate");
const { workspacesController } = require("@modules/workspaces/controllers/index");
const { workspacesValidation } = require("@modules/workspaces/validations/index");

const router = express.Router();

router.get("/", auth, workspacesController.listWorkspaces);
router.post("/", auth, validate(workspacesValidation.createWorkspaceSchema), workspacesController.createWorkspace);

module.exports = router;

