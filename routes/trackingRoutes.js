const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");
const { redirect } = require("../controllers/linkController");

const router = express.Router();

router.get("/t/:code", asyncHandler(redirect));

module.exports = router;

