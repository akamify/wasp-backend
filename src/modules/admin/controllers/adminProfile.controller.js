const Joi = require("joi");
const { User } = require("@infra/database/User");
const { AuditLog } = require("@infra/database/AuditLog");
const { HttpError } = require("@shared/utils/httpError");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { sendEmail } = require("@shared/services/emailService");
const { superAdminEmail } = require("@core/config/env");

function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const limitRaw = Number(req.query.limit || 25) || 25;
  const limit = Math.min(Math.max(limitRaw, 5), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

async function adminGetProfile(req, res) {
  const adminUser = await User.findById(req.user.id).select("email name phone role twoFactorEnabled createdAt updatedAt");
  if (!adminUser) throw new HttpError(404, "Admin account not found");
  res.json({
    success: true,
    profile: {
      id: String(adminUser._id),
      email: adminUser.email || "",
      displayName: adminUser.name || "Admin",
      phone: adminUser.phone || "",
      role: adminUser.role || "admin",
      twoFactorEnabled: !!adminUser.twoFactorEnabled,
      createdAt: adminUser.createdAt,
      updatedAt: adminUser.updatedAt,
    },
  });
}

const updateSchema = Joi.object({
  displayName: Joi.string().trim().min(2).max(80).required(),
});

async function adminUpdateProfile(req, res) {
  await updateSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  throw new HttpError(403, "Direct profile update is disabled. Submit a profile request for approval.");
}

async function adminListLoginEvents(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const loginActions = ["auth.login.success", "auth.logout", "auth.force_logout"];
  const [total, items] = await Promise.all([
    AuditLog.countDocuments({ actorId: req.user.id, action: { $in: loginActions } }),
    AuditLog.find({ actorId: req.user.id, action: { $in: loginActions } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("action ip userAgent location createdAt"),
  ]);

  res.json({
    success: true,
    items: items.map((e) => ({
      id: String(e._id),
      ip: e.ip || "",
      userAgent: e.userAgent || "",
      method: e.action === "auth.login.success" ? "login" : "logout",
      action: e.action,
      location: e.location || "",
      createdAt: e.createdAt,
    })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
}

const requestSchema = Joi.object({
  requestType: Joi.string().valid("name", "email", "phone", "password_reset", "2fa_enable", "2fa_disable").required(),
  newValue: Joi.string().allow("").optional(),
  reason: Joi.string().trim().min(3).max(400).required(),
});

async function adminCreateProfileRequest(req, res) {
  const payload = await requestSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const adminUser = await User.findById(req.user.id).select("email name role");
  if (!adminUser || String(adminUser.role || "") !== "admin") throw new HttpError(404, "Admin account not found");

  const requestedChanges = {};
  if (payload.requestType === "name") requestedChanges.name = String(payload.newValue || "").trim();
  if (payload.requestType === "email") requestedChanges.email = String(payload.newValue || "").trim().toLowerCase();
  if (payload.requestType === "phone") requestedChanges.phone = String(payload.newValue || "").trim();
  if (payload.requestType === "2fa_enable") requestedChanges.twoFactorEnabled = true;
  if (payload.requestType === "2fa_disable") requestedChanges.twoFactorEnabled = false;
  if (payload.requestType === "password_reset") requestedChanges.passwordReset = true;

  await writeAuditLog(req, {
    actorId: adminUser._id,
    targetId: adminUser._id,
    action: "profile.request.submitted",
    resourceType: "profile_request",
    metadata: {
      requestType: payload.requestType,
      requestedChanges,
      reason: payload.reason,
      status: "pending",
    },
  });

  await sendEmail({
    toEmail: adminUser.email,
    toName: adminUser.name || "Admin",
    subject: "Profile request submitted",
    htmlContent: `<p>Your profile request has been submitted successfully.</p><p><b>Type:</b> ${payload.requestType}</p><p><b>Reason:</b> ${payload.reason}</p>`,
    textContent: `Your profile request has been submitted. Type: ${payload.requestType}. Reason: ${payload.reason}`,
  });

  if (superAdminEmail) {
    await sendEmail({
      toEmail: superAdminEmail,
      toName: "Super Admin",
      subject: "New admin profile request submitted",
      htmlContent: `<p>A new admin profile request was submitted.</p><p><b>Admin:</b> ${adminUser.email}</p><p><b>Type:</b> ${payload.requestType}</p><p><b>Reason:</b> ${payload.reason}</p>`,
      textContent: `New admin profile request. Admin: ${adminUser.email}. Type: ${payload.requestType}. Reason: ${payload.reason}`,
    });
  }

  res.json({ success: true, message: "Profile update request submitted" });
}

async function adminListProfileRequests(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const [total, items] = await Promise.all([
    AuditLog.countDocuments({ actorId: req.user.id, action: { $regex: /^profile\.request\./i } }),
    AuditLog.find({ actorId: req.user.id, action: { $regex: /^profile\.request\./i } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
  ]);
  res.json({ success: true, items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
}

module.exports = { adminGetProfile, adminUpdateProfile, adminListLoginEvents, adminCreateProfileRequest, adminListProfileRequests };

