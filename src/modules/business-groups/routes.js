const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { auth } = require("@core/middleware/auth");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { HttpError } = require("@shared/utils/httpError");
const service = require("./service");
const { report } = require("./reports");
const router = express.Router();
router.use(auth, (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.user.accountType !== "user") return next(new HttpError(403, "A merchant user account is required"));
  next();
});
router.use(rateLimit({ windowMs: 60000, limit: 60, keyGenerator: (req) => req.user.id, standardHeaders: "draft-8", legacyHeaders: false }));
const mutateLimit = rateLimit({ windowMs: 3600000, limit: 60, keyGenerator: (req) => req.user.id, standardHeaders: "draft-8", legacyHeaders: false });
const body = (keys) => (req, res, next) => {
  if (!req.body || Array.isArray(req.body) || typeof req.body !== "object" || Object.keys(req.body).some((k) => !keys.includes(k))) return next(new HttpError(400, "Invalid request body"));
  next();
};
router.get("/", asyncHandler(async (req, res) => res.json(await service.overview(req.user.id))));
router.put("/", mutateLimit, body(["name"]), asyncHandler(async (req, res) => {
  await service.saveGroup(req.user.id, req.body.name); res.json({ success: true });
}));
router.get("/owned-workspaces", asyncHandler(async (req, res) => {
  const items = await service.ownedWorkspaces(req.user.id, req.query.after);
  res.json({ items: items.slice(0, 100).map((w) => ({ id: String(w._id), name: w.name })), next: items.length > 100 ? String(items[99]._id) : null });
}));
router.post("/links", mutateLimit, body(["workspaceId"]), asyncHandler(async (req, res) => res.json(await service.requestLink(req.user.id, req.body.workspaceId))));
router.get("/inbox/:workspaceId", asyncHandler(async (req, res) => res.json(await service.inbox(req.user.id, req.params.workspaceId, req.query.after))));
router.post("/:groupId/links/:workspaceId/decision", mutateLimit, body(["requestId", "decision"]), asyncHandler(async (req, res) =>
  res.json(await service.decideLink(req.user.id, req.params.groupId, req.params.workspaceId, req.body.requestId, req.body.decision))));
router.get("/report", asyncHandler(async (req, res) => {
  if (Object.keys(req.query).some((key) => !["environment", "from", "to", "after"].includes(key))) throw new HttpError(400, "Unsupported report filter");
  res.json(await report(req.user.id, req.query));
}));
module.exports = router;
