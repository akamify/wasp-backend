const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { User } = require("@infra/database/User");
const { AuditLog } = require("@infra/database/AuditLog");
const { HttpError } = require("@shared/utils/httpError");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { sendEmail } = require("@shared/services/emailService");
const { appBaseUrl } = require("@core/config/env");
const { sha256Hex } = require("@shared/utils/hash");
const { base64Url } = require("@modules/auth/auth.utils");
const { superAdminEmail } = require("@core/config/env");
const { normalizeStatus, validateAdminStatusTransition } = require("@shared/utils/userStatus");
const STRONG_PASS_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{8}$/;

function generateStrongTempPassword(length = 8) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = `${upper}${lower}${digits}${special}`;

  const pick = (chars) => chars[Math.floor(Math.random() * chars.length)];
  let pass = [pick(upper), pick(lower), pick(digits), pick(special)];
  while (pass.length < length) pass.push(pick(all));
  for (let i = pass.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pass[i], pass[j]] = [pass[j], pass[i]];
  }
  const out = pass.join("");
  if (!STRONG_PASS_REGEX.test(out)) return generateStrongTempPassword(length);
  return out;
}

function createPasswordResetTokenPayload() {
  const rawToken = base64Url(crypto.randomBytes(32));
  return {
    rawToken,
    tokenHash: sha256Hex(rawToken),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  };
}

async function assignAdmin(req, res) {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  if (!email) throw new HttpError(400, "Email is required");

  let user = await User.findOne({ email }).select("_id email name role status accountBlocked adminPermissions twoFactorEnabled +passwordHash");
  if (user && String(user.role || "") !== "admin") {
    throw new HttpError(400, "Role migration is blocked. This email is already registered with another role.");
  }
  if (user && String(user.role || "") === "super_admin") throw new HttpError(400, "Super admin role cannot be changed");

  const passwordHash = await bcrypt.hash(generateStrongTempPassword(8), 12);
  const { rawToken, tokenHash, expiresAt } = createPasswordResetTokenPayload();

  if (!user) {
    user = await User.create({
      email,
      name: name || "Admin User",
      passwordHash,
      role: "admin",
      status: "active",
      terminationState: "",
      accountBlocked: false,
      twoFactorEnabled: true,
      adminPermissions: { pages: ["/admin/dashboard", "/admin/profile"], components: [], actions: [] },
      passwordResetTokenHash: tokenHash,
      passwordResetTokenExpiresAt: expiresAt,
    });
  } else {
    if (name) user.name = name;
    user.passwordHash = passwordHash;
    user.role = "admin";
    user.status = "active";
    user.terminationState = "";
    user.accountBlocked = false;
    user.twoFactorEnabled = true;
    if (!user.adminPermissions) {
      user.adminPermissions = { pages: ["/admin/dashboard", "/admin/profile"], components: [], actions: [] };
    }
    user.passwordResetTokenHash = tokenHash;
    user.passwordResetTokenExpiresAt = expiresAt;
    await user.save();
  }

  const resetLink = `${appBaseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    toEmail: email,
    toName: user.name || "",
    subject: "Admin account created - Set your password",
    htmlContent: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h2 style="margin:0 0 12px">Admin Access Assigned</h2>
        <p>Email: <b>${email}</b></p>
        <p>You have been added as an admin. Use the link below to create or reset your password:</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>2FA is enabled by default on your account.</p>
        <p style="font-size:12px;color:#64748b">This link expires in 30 minutes. If it expires, ask super admin to send a new link.</p>
      </div>
    `,
    textContent: `Admin Access Assigned\nEmail: ${email}\nSet password link: ${resetLink}\n2FA is enabled by default.\nThis link expires in 30 minutes.`,
  });

  await writeAuditLog(req, {
    action: "admin.assigned",
    targetId: user._id,
    resourceType: "user",
    resourceId: String(user._id),
    metadata: { email: user.email, twoFactorEnabled: true, passwordSetupLinkSent: true },
  });

  return res.json({
    success: true,
    user: { id: String(user._id), email: user.email, role: user.role, twoFactorEnabled: !!user.twoFactorEnabled },
    message: "Admin assigned. Password setup link sent on email.",
  });
}

async function removeAdmin(req, res) {
  const userId = String(req.body?.userId || "").trim();
  if (!userId) throw new HttpError(400, "userId is required");

  const user = await User.findById(userId).select("_id email role");
  if (!user) throw new HttpError(404, "User not found");
  if (String(user.role || "") !== "admin") throw new HttpError(400, "User is not an admin");
  throw new HttpError(400, "Role migration is blocked. Admin cannot be converted to user.");

  await writeAuditLog(req, {
    action: "admin.removed",
    targetId: user._id,
    resourceType: "user",
    resourceId: String(user._id),
    metadata: { email: user.email },
  });

  return res.json({ success: true, user: { id: String(user._id), email: user.email, role: user.role } });
}

async function suspendUser(req, res) {
  const userId = String(req.body?.userId || "").trim();
  const reason = String(req.body?.reason || "inactive").trim();
  if (!userId) throw new HttpError(400, "userId is required");

  const user = await User.findById(userId).select("_id email role accountBlocked status");
  if (!user) throw new HttpError(404, "User not found");
  if (String(user.role || "") === "super_admin") throw new HttpError(400, "Cannot suspend super admin");

  user.accountBlocked = true;
  user.status = "banned";
  user.terminationState = reason === "fired" ? "fired" : "retired";
  user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  await user.save();

  await writeAuditLog(req, {
    action: "user.suspended",
    targetId: user._id,
    resourceType: "user",
    resourceId: String(user._id),
    metadata: { email: user.email, reason: user.terminationState },
  });

  return res.json({ success: true });
}

async function resetUserPassword(req, res) {
  const userId = String(req.body?.userId || "").trim();
  if (!userId) throw new HttpError(400, "userId is required");

  const user = await User.findById(userId).select("_id email name role");
  if (!user) throw new HttpError(404, "User not found");
  if (String(user.role || "") === "super_admin") throw new HttpError(400, "Use super admin reset flow for root account");

  const { rawToken, tokenHash, expiresAt } = createPasswordResetTokenPayload();

  user.passwordResetTokenHash = tokenHash;
  user.passwordResetTokenExpiresAt = expiresAt;
  await user.save();

  const resetLink = `${appBaseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Password reset link",
    htmlContent: `<p>Your password reset link:</p><p><a href="${resetLink}">${resetLink}</a></p>`,
    textContent: `Your password reset link: ${resetLink}`,
  });

  await writeAuditLog(req, {
    action: "user.password_reset_requested",
    targetId: user._id,
    resourceType: "user",
    resourceId: String(user._id),
    metadata: { email: user.email },
  });

  return res.json({ success: true, message: "Password reset link sent" });
}

async function listAdmins(req, res) {
  const q = String(req.query?.q || "").trim();
  const filter = q
    ? { role: "admin", $or: [{ email: new RegExp(q, "i") }, { name: new RegExp(q, "i") }, { phone: new RegExp(q, "i") }] }
    : { role: "admin" };
  const items = await User.find(filter)
    .sort({ updatedAt: -1 })
    .limit(500)
    .select("email name phone role status terminationState accountBlocked twoFactorEnabled adminPermissions createdAt updatedAt");
  const adminIds = items.map((x) => x._id);
  const loginRows = adminIds.length
    ? await AuditLog.aggregate([
        { $match: { actorId: { $in: adminIds }, action: "auth.login.success" } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$actorId", lastLoginAt: { $first: "$createdAt" } } },
      ])
    : [];
  const loginMap = new Map(loginRows.map((x) => [String(x._id), x.lastLoginAt]));
  return res.json({
    success: true,
    items: items.map((u) => ({
      id: String(u._id),
      email: u.email || "",
      name: u.name || "",
      phone: u.phone || "",
      role: u.role,
      status: u.status || "active",
      terminationState: u.terminationState || "",
      accountBlocked: !!u.accountBlocked,
      twoFactorEnabled: !!u.twoFactorEnabled,
      permissions: u.adminPermissions || { pages: [], components: [], actions: [] },
      createdAt: u.createdAt,
      lastLoginAt: loginMap.get(String(u._id)) || null,
      updatedAt: u.updatedAt,
    })),
  });
}

async function getAdminDetail(req, res) {
  const id = String(req.params.id || "").trim();
  const admin = await User.findOne({ _id: id, role: "admin" }).select(
    "email name phone role status terminationState accountBlocked twoFactorEnabled adminPermissions createdAt updatedAt"
  );
  if (!admin) throw new HttpError(404, "Admin account not found");

  const [activities, requests] = await Promise.all([
    AuditLog.find({ actorId: admin._id }).sort({ createdAt: -1 }).limit(200),
    AuditLog.find({
      $or: [{ targetId: admin._id }, { actorId: admin._id }],
      action: { $regex: /^profile\.request/i },
    })
      .sort({ createdAt: -1 })
      .limit(200),
  ]);

  return res.json({
    success: true,
    admin: {
      id: String(admin._id),
      email: admin.email || "",
      name: admin.name || "",
      phone: admin.phone || "",
      role: admin.role,
      status: admin.status || "active",
      terminationState: admin.terminationState || "",
      accountBlocked: !!admin.accountBlocked,
      twoFactorEnabled: !!admin.twoFactorEnabled,
      permissions: admin.adminPermissions || { pages: [], components: [], actions: [] },
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt,
    },
    activity: activities,
    requests,
  });
}

async function updateAdmin(req, res) {
  const id = String(req.params.id || "").trim();
  const admin = await User.findOne({ _id: id, role: "admin" }).select(
    "email name phone role status terminationState accountBlocked twoFactorEnabled adminPermissions tokenVersion"
  );
  if (!admin) throw new HttpError(404, "Admin account not found");

  const patch = req.body || {};
  const previousStatus = normalizeStatus(admin.status);
  if (typeof patch.name === "string") admin.name = patch.name.trim();
  if (typeof patch.phone === "string") admin.phone = patch.phone.trim();
  const currentStatus = normalizeStatus(admin.status);
  const requestedStatus = typeof patch.status === "string" ? normalizeStatus(patch.status) : currentStatus;
  const transition = validateAdminStatusTransition(currentStatus, requestedStatus);
  if (!transition.ok) throw new HttpError(400, transition.message);

  admin.status = requestedStatus;
  if (requestedStatus === "active") {
    admin.accountBlocked = false;
    admin.terminationState = "";
  } else if (requestedStatus === "banned") {
    admin.accountBlocked = true;
    admin.terminationState = "";
  } else if (requestedStatus === "fired") {
    admin.accountBlocked = true;
    admin.terminationState = "fired";
  } else if (requestedStatus === "retired") {
    admin.accountBlocked = true;
    admin.terminationState = "retired";
  }

  if (typeof patch.accountBlocked === "boolean" && requestedStatus === "active") {
    admin.accountBlocked = Boolean(patch.accountBlocked);
  }
  if (typeof patch.twoFactorEnabled === "boolean") {
    admin.twoFactorEnabled = patch.twoFactorEnabled;
    admin.twoFactorCodeHash = undefined;
    admin.twoFactorCodeExpiresAt = undefined;
    admin.loginOtpCodeHash = undefined;
    admin.loginOtpCodeExpiresAt = undefined;
    admin.loginOtpAttempts = 0;
  }
  if (patch.permissions && typeof patch.permissions === "object") {
    admin.adminPermissions = {
      pages: Array.isArray(patch.permissions.pages) ? patch.permissions.pages.map((x) => String(x)) : [],
      components: Array.isArray(patch.permissions.components) ? patch.permissions.components.map((x) => String(x)) : [],
      actions: Array.isArray(patch.permissions.actions) ? patch.permissions.actions.map((x) => String(x)) : [],
    };
  }

  if (admin.accountBlocked || requestedStatus !== "active") {
    admin.tokenVersion = Number(admin.tokenVersion || 0) + 1;
    await writeAuditLog(req, {
      action: "auth.force_logout",
      actorId: req.user?.id,
      targetId: admin._id,
      resourceType: "auth",
      resourceId: String(admin._id),
      metadata: {
        status: "success",
        reason: requestedStatus === "active" ? "session_revoked_by_super_admin" : `status_changed_to_${requestedStatus}`,
      },
    });
  }
  await admin.save();

  if (["fired", "retired"].includes(requestedStatus) && previousStatus !== requestedStatus) {
    await sendEmail({
      toEmail: admin.email,
      toName: admin.name || "",
      subject: requestedStatus === "fired" ? "Admin account terminated (Fired)" : "Admin account retired",
      htmlContent: `<p>Your admin account status is now <b>${requestedStatus.toUpperCase()}</b>.</p><p>You can no longer sign in with this email.</p>`,
      textContent: `Your admin account status is now ${requestedStatus.toUpperCase()}. You can no longer sign in with this email.`,
    });
  }

  await writeAuditLog(req, {
    action: "admin.updated",
    targetId: admin._id,
    resourceType: "user",
    resourceId: String(admin._id),
    metadata: { email: admin.email },
  });

  return res.json({ success: true });
}

async function securityLogs(req, res) {
  const page = Math.max(1, Number(req.query?.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 20)));
  const skip = (page - 1) * limit;

  const [total, items] = await Promise.all([
    AuditLog.countDocuments({}),
    AuditLog.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit),
  ]);

  return res.json({ success: true, page, limit, total, items });
}

async function profile(req, res) {
  const user = await User.findById(req.user.id).select("email name phone role twoFactorEnabled createdAt updatedAt");
  if (!user || String(user.role || "") !== "super_admin") throw new HttpError(404, "Super admin not found");
  if (!user.twoFactorEnabled) {
    user.twoFactorEnabled = true;
    await user.save();
    await writeAuditLog(req, { action: "super_admin.2fa.enabled.default", targetId: user._id });
  }

  const loginEvents = await AuditLog.find({ actorId: user._id, action: { $in: ["auth.login.success", "auth.logout", "auth.force_logout"] } })
    .sort({ createdAt: -1 })
    .limit(200);

  return res.json({
    success: true,
    profile: {
      id: String(user._id),
      email: user.email || "",
      name: user.name || "",
      phone: user.phone || "",
      role: user.role,
      twoFactorEnabled: !!user.twoFactorEnabled,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    loginEvents,
  });
}

async function updateProfileName(req, res) {
  const name = String(req.body?.name || "").trim();
  if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters");
  const user = await User.findById(req.user.id).select("role name");
  if (!user || String(user.role || "") !== "super_admin") throw new HttpError(404, "Super admin not found");
  user.name = name;
  await user.save();
  await writeAuditLog(req, { action: "super_admin.profile.rename", targetId: user._id });
  return res.json({ success: true });
}

async function changeProfilePassword(req, res) {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (newPassword.length < 8) throw new HttpError(400, "New password must be at least 8 characters");
  const user = await User.findById(req.user.id).select("+passwordHash role tokenVersion");
  if (!user || String(user.role || "") !== "super_admin") throw new HttpError(404, "Super admin not found");
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new HttpError(401, "Current password is incorrect");
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  await user.save();
  await writeAuditLog(req, { action: "super_admin.profile.password_changed", targetId: user._id });
  return res.json({ success: true });
}

async function requestProfileOtp(req, res) {
  const purpose = String(req.body?.purpose || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const phone = String(req.body?.phone || "").trim();
  if (!["change_email", "change_phone"].includes(purpose)) throw new HttpError(400, "Invalid purpose");

  const user = await User.findById(req.user.id).select(
    "role email phone +profileOtpCodeHash +profileOtpCodeExpiresAt +profileOtpPurpose +pendingEmail +pendingPhone"
  );
  if (!user || String(user.role || "") !== "super_admin") throw new HttpError(404, "Super admin not found");

  if (!superAdminEmail || String(user.email || "").toLowerCase() !== String(superAdminEmail)) {
    throw new HttpError(403, "SUPER_ADMIN_EMAIL mismatch");
  }
  if (purpose === "change_email") {
    if (!email) throw new HttpError(400, "New email is required");
    user.pendingEmail = email;
  }
  if (purpose === "change_phone") {
    if (!phone) throw new HttpError(400, "New phone is required");
    user.pendingPhone = phone;
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  user.profileOtpCodeHash = sha256Hex(otp);
  user.profileOtpCodeExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
  user.profileOtpPurpose = purpose;
  await user.save();

  await sendEmail({
    toEmail: superAdminEmail,
    toName: user.name || "",
    subject: "Super admin profile OTP",
    htmlContent: `<p>Your OTP: <b>${otp}</b> (valid for 5 minutes)</p>`,
    textContent: `Your OTP is ${otp}. Valid for 5 minutes.`,
  });
  return res.json({ success: true, message: "OTP sent" });
}

async function verifyProfileOtp(req, res) {
  const otp = String(req.body?.otp || "").trim();
  const user = await User.findById(req.user.id).select(
    "role email phone +profileOtpCodeHash +profileOtpCodeExpiresAt +profileOtpPurpose +pendingEmail +pendingPhone"
  );
  if (!user || String(user.role || "") !== "super_admin") throw new HttpError(404, "Super admin not found");
  if (!user.profileOtpCodeHash || !user.profileOtpCodeExpiresAt || user.profileOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired");
  }
  if (sha256Hex(otp) !== user.profileOtpCodeHash) throw new HttpError(401, "Invalid OTP");

  if (String(user.profileOtpPurpose || "") === "change_email" && user.pendingEmail) {
    user.email = String(user.pendingEmail).toLowerCase();
  }
  if (String(user.profileOtpPurpose || "") === "change_phone" && user.pendingPhone) {
    user.phone = String(user.pendingPhone);
  }
  user.profileOtpCodeHash = undefined;
  user.profileOtpCodeExpiresAt = undefined;
  user.profileOtpPurpose = undefined;
  user.pendingEmail = undefined;
  user.pendingPhone = undefined;
  await user.save();
  await writeAuditLog(req, { action: "super_admin.profile.contact_changed", targetId: user._id });
  return res.json({ success: true });
}

async function setProfile2fa(req, res) {
  const enabled = !!req.body?.enabled;
  const user = await User.findById(req.user.id).select("role twoFactorEnabled");
  if (!user || String(user.role || "") !== "super_admin") throw new HttpError(404, "Super admin not found");
  user.twoFactorEnabled = enabled;
  await user.save();
  await writeAuditLog(req, { action: enabled ? "super_admin.2fa.enabled" : "super_admin.2fa.disabled", targetId: user._id });
  return res.json({ success: true, twoFactorEnabled: enabled });
}

async function decideAdminProfileRequest(req, res) {
  const adminId = String(req.params.id || "").trim();
  const requestId = String(req.params.requestId || "").trim();
  const decision = String(req.body?.decision || "").trim().toLowerCase();
  const reviewNote = String(req.body?.reviewNote || "").trim();
  if (!["approved", "rejected"].includes(decision)) throw new HttpError(400, "decision must be approved or rejected");

  const [admin, requestLog] = await Promise.all([
    User.findOne({ _id: adminId, role: "admin" }).select(
      "_id email name phone twoFactorEnabled tokenVersion +profileOtpCodeHash +profileOtpCodeExpiresAt +profileOtpPurpose +pendingEmail"
    ),
    AuditLog.findById(requestId),
  ]);
  if (!admin) throw new HttpError(404, "Admin account not found");
  if (!requestLog) throw new HttpError(404, "Profile request not found");
  if (String(requestLog.action || "") !== "profile.request.submitted") throw new HttpError(400, "Invalid profile request");
  if (String(requestLog.actorId || "") !== String(admin._id)) throw new HttpError(400, "Request does not belong to this admin");

  const meta = requestLog.metadata && typeof requestLog.metadata === "object" ? requestLog.metadata : {};
  if (String(meta.status || "") !== "pending") throw new HttpError(400, "Request already processed");

  if (decision === "approved") {
    const changes = meta.requestedChanges && typeof meta.requestedChanges === "object" ? meta.requestedChanges : {};
    if (typeof changes.name === "string" && changes.name.trim()) admin.name = changes.name.trim();

    let otpRequired = false;
    let otpPurpose = "";

    // Email change requires OTP verification by the admin after approval.
    if (typeof changes.email === "string" && changes.email.trim()) {
      admin.pendingEmail = changes.email.trim().toLowerCase();
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      admin.profileOtpCodeHash = sha256Hex(otp);
      admin.profileOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
      admin.profileOtpPurpose = "admin_profile_request_change_email";
      otpRequired = true;
      otpPurpose = "change_email";

      await sendEmail({
        toEmail: admin.email,
        toName: admin.name || "",
        subject: "Verify OTP to complete email change",
        htmlContent: `<p>Your OTP to complete admin email change is <b>${otp}</b>. It expires in 10 minutes.</p>`,
        textContent: `Your OTP to complete admin email change is ${otp}. It expires in 10 minutes.`,
      }).catch(() => {});
    }
    if (typeof changes.phone === "string") admin.phone = changes.phone.trim();

    // Enabling 2FA requires OTP verification by the admin after approval.
    if (typeof changes.twoFactorEnabled === "boolean") {
      if (changes.twoFactorEnabled === true) {
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        admin.profileOtpCodeHash = sha256Hex(otp);
        admin.profileOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
        admin.profileOtpPurpose = "admin_profile_request_enable_2fa";
        otpRequired = true;
        otpPurpose = "enable_2fa";

        await sendEmail({
          toEmail: admin.email,
          toName: admin.name || "",
          subject: "Verify OTP to enable 2FA",
          htmlContent: `<p>Your OTP to enable 2FA is <b>${otp}</b>. It expires in 10 minutes.</p>`,
          textContent: `Your OTP to enable 2FA is ${otp}. It expires in 10 minutes.`,
        }).catch(() => {});
      } else {
        admin.twoFactorEnabled = false;
      }
    }

    if (changes.passwordReset) {
      const rawToken = base64Url(crypto.randomBytes(32));
      const tokenHash = sha256Hex(rawToken);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      admin.passwordResetTokenHash = tokenHash;
      admin.passwordResetTokenExpiresAt = expiresAt;
      const resetLink = `${appBaseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
      await sendEmail({
        toEmail: admin.email,
        toName: admin.name || "",
        subject: "Password reset link",
        htmlContent: `<p>Your password reset link:</p><p><a href="${resetLink}">${resetLink}</a></p>`,
        textContent: `Your password reset link: ${resetLink}`,
      });
    }
    // If OTP is required, we don't apply the sensitive change yet. Admin must verify OTP.
    if (!otpRequired) {
      admin.tokenVersion = Number(admin.tokenVersion || 0) + 1;
      await admin.save();
      await writeAuditLog(req, {
        action: "auth.force_logout",
        actorId: req.user?.id,
        targetId: admin._id,
        resourceType: "auth",
        resourceId: String(admin._id),
        metadata: { status: "success", reason: "profile_request_approved_session_revoke" },
      });
    } else {
      await admin.save();
      meta.otpRequired = true;
      meta.otpPurpose = otpPurpose;
      meta.otpExpiresInSeconds = 600;
    }
  }

  requestLog.action = decision === "approved" ? "profile.request.approved" : "profile.request.rejected";
  requestLog.targetId = admin._id;
  requestLog.resourceType = "profile_request";
  requestLog.metadata = {
    ...(meta || {}),
    status: meta?.otpRequired ? "approved_pending_otp" : decision,
    reviewedBy: req.user?.id || "",
    reviewedAt: new Date().toISOString(),
    reviewNote,
  };
  await requestLog.save();

  await sendEmail({
    toEmail: admin.email,
    toName: admin.name || "",
    subject: decision === "approved" ? "Profile request approved" : "Profile request rejected",
    htmlContent: `<p>Your profile request has been <b>${decision}</b>.</p><p>${reviewNote || ""}</p>`,
    textContent: `Your profile request has been ${decision}. ${reviewNote || ""}`,
  });
  if (superAdminEmail) {
    await sendEmail({
      toEmail: superAdminEmail,
      toName: "Super Admin",
      subject: `Admin profile request ${decision}`,
      htmlContent: `<p>Admin profile request has been <b>${decision}</b>.</p><p><b>Admin:</b> ${admin.email}</p><p><b>Request Type:</b> ${String(meta.requestType || "-")}</p><p><b>Reason:</b> ${String(meta.reason || "-")}</p><p><b>Review Note:</b> ${reviewNote || "-"}</p>`,
      textContent: `Admin profile request ${decision}. Admin: ${admin.email}. Type: ${String(meta.requestType || "-")}. Reason: ${String(meta.reason || "-")}. Review note: ${reviewNote || "-"}`,
    });
  }

  await writeAuditLog(req, {
    action: decision === "approved" ? "admin.profile.request.approved.by_super_admin" : "admin.profile.request.rejected.by_super_admin",
    targetId: admin._id,
    resourceType: "profile_request",
    resourceId: String(requestLog._id),
    metadata: { decision, reviewNote },
  });

  return res.json({ success: true, decision });
}

module.exports = {
  assignAdmin,
  removeAdmin,
  suspendUser,
  resetUserPassword,
  listAdmins,
  getAdminDetail,
  updateAdmin,
  securityLogs,
  profile,
  updateProfileName,
  changeProfilePassword,
  requestProfileOtp,
  verifyProfileOtp,
  setProfile2fa,
  decideAdminProfileRequest,
};
