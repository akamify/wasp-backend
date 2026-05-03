const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");
const { auth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/requireAdmin");
const {
  adminOverview,
  adminUsers,
  adminTemplates,
  adminCredentials,
  adminWallets,
} = require("../controllers/adminController");

const router = express.Router();

router.use(auth, requireAdmin);
router.get("/overview", asyncHandler(adminOverview));
router.get("/users", asyncHandler(adminUsers));
router.get("/templates", asyncHandler(adminTemplates));
router.get("/credentials", asyncHandler(adminCredentials));
router.get("/wallets", asyncHandler(adminWallets));

module.exports = router;
