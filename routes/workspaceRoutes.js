const express = require("express");
const Joi = require("joi");
const { auth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { listWorkspaces, createWorkspace } = require("../controllers/workspaceController");

const router = express.Router();

router.get("/", auth, listWorkspaces);
router.post(
  "/",
  auth,
  validate(
    Joi.object({
      name: Joi.string().trim().min(2).max(80).required(),
    })
  ),
  createWorkspace
);

module.exports = router;
