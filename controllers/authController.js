const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const {
  jwtSecret,
  jwtExpiresIn,
  adminSessionExpiresIn,
  adminEmail,
  adminPassword,
  adminName,
  appBaseUrl,
} = require("../config/env");
const { User } = require("../models/User");
const { Workspace } = require("../models/Workspace");
const { HttpError } = require("../utils/httpError");
const { sha256Hex } = require("../utils/hash");
const { sendEmail } = require("../services/emailService");
const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { encryptString, decryptString } = require("../utils/crypto");

function base64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function generateApiKey() {
  return base64Url(crypto.randomBytes(32));
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function signToken({ user, workspaceId }) {
  return jwt.sign({ role: user.role, workspaceId: String(workspaceId) }, jwtSecret, {
    subject: String(user._id),
    expiresIn: jwtExpiresIn,
  });
}

function signAdminToken() {
  return jwt.sign({ role: "admin", workspaceId: "admin" }, jwtSecret, {
    subject: "env-admin",
    expiresIn: adminSessionExpiresIn,
  });
}

function signLoginChallengeToken(userId) {
  return jwt.sign({ role: "user", purpose: "login_2fa" }, jwtSecret, {
    subject: String(userId),
    expiresIn: "15m",
  });
}

function signRegisterChallengeToken(userId) {
  return jwt.sign({ role: "user", purpose: "register_verify" }, jwtSecret, {
    subject: String(userId),
    expiresIn: "15m",
  });
}

function verifyLoginChallengeToken(token) {
  const payload = jwt.verify(token, jwtSecret);
  if (payload?.purpose !== "login_2fa") throw new Error("Invalid challenge token");
  return payload;
}

function verifyRegisterChallengeToken(token) {
  const payload = jwt.verify(token, jwtSecret);
  if (payload?.purpose !== "register_verify") throw new Error("Invalid challenge token");
  return payload;
}

function isEnvAdminLogin(email, password) {
  if (!adminEmail || !adminPassword) return false;
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const allowInProd = String(process.env.ALLOW_ENV_ADMIN_LOGIN || "").toLowerCase() === "true";
  if (isProd && !allowInProd) return false;
  return (
    String(email || "").trim().toLowerCase() === String(adminEmail).trim().toLowerCase() &&
    String(password || "") === String(adminPassword)
  );
}

function shouldReturnAuthDebugTokens() {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProd) return false;
  return String(process.env.AUTH_DEV_RETURN_EMAIL_TOKENS || "").toLowerCase() === "true";
}

async function ensureMetaSetupForWorkspace(workspaceId) {
  const hasValid = await WhatsAppCredentials.exists({ workspaceId, isValid: true });
  if (!hasValid) {
    throw new HttpError(409, "Meta/WhatsApp is not set up for this workspace yet. Connect WhatsApp first.");
  }
}

function normalizeApiKeyOtpPurpose(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "rotate") return "rotate";
  if (v === "reveal") return "reveal";
  return "";
}

function buildOtpEmailHtml({ code, title, subtitle }) {
  return `
    <div style="font-family: Inter, Arial, sans-serif; max-width: 520px; margin: 0 auto; color: #0f172a;">
      <h2 style="margin-bottom: 8px;">${title}</h2>
      <p style="margin: 0 0 16px; color: #475569;">${subtitle}</p>
      <div style="font-size: 28px; font-weight: 800; letter-spacing: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; text-align: center;">
        ${code}
      </div>
      <p style="margin-top: 16px; color: #64748b; font-size: 13px;">This code expires in 10 minutes.</p>
    </div>
  `;
}

async function ensureDefaultWorkspace(user) {
  let workspace = await Workspace.findOne({ ownerId: user._id, isActive: true })
    .sort({ createdAt: 1 })
    .select("_id name plan");

  if (!workspace) {
    workspace = await Workspace.create({
      ownerId: user._id,
      name: user.name ? `${String(user.name).trim()}'s workspace` : "My workspace",
    });
  }

  return workspace;
}

async function register(req, res) {
  const { email, password, name, phone } = req.body;

  const existing = await User.findOne({ email: String(email).toLowerCase() }).select("_id");
  if (existing) throw new HttpError(409, "Email already registered");

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ email, passwordHash, name, phone });
  const workspace = await Workspace.create({
    ownerId: user._id,
    name: name ? `${String(name).trim()}'s workspace` : "My workspace",
  });
  const otp = generateOtpCode();
  user.registerOtpCodeHash = sha256Hex(otp);
  user.registerOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Verify your account",
    htmlContent: buildOtpEmailHtml({
      code: otp,
      title: "Verify your email",
      subtitle: "Enter this OTP to finish creating your account.",
    }),
    textContent: `Your verification OTP is ${otp}. It expires in 10 minutes.`,
  });

  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProd && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  res.status(201).json({
    success: true,
    requiresOtp: true,
    challengeToken: signRegisterChallengeToken(user._id),
    workspace: { id: workspace._id, name: workspace.name, plan: workspace.plan },
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
    ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
  });
}

async function login(req, res) {
  const { email, password } = req.body;

  if (isEnvAdminLogin(email, password)) {
    const token = signAdminToken();
    return res.json({
      success: true,
      token,
      workspace: null,
      user: { id: "env-admin", email: adminEmail, name: adminName, role: "admin" },
    });
  }

  const user = await User.findOne({ email: String(email).toLowerCase() }).select(
    "+passwordHash role email name phone twoFactorEnabled +loginOtpCodeHash +loginOtpCodeExpiresAt"
  );
  if (!user) throw new HttpError(401, "Invalid credentials");

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new HttpError(401, "Invalid credentials");

  if (user.twoFactorEnabled) {
    const otp = generateOtpCode();
    user.loginOtpCodeHash = sha256Hex(otp);
    user.loginOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    const delivery = await sendEmail({
      toEmail: user.email,
      toName: user.name || "",
      subject: "Your login OTP code",
      htmlContent: buildOtpEmailHtml({
        code: otp,
        title: "Two-factor verification",
        subtitle: "Enter this one-time code to complete your sign-in.",
      }),
      textContent: `Your login OTP code is ${otp}. It expires in 10 minutes.`,
    });

    const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
    if (isProd && (delivery?.skipped || delivery?.failed)) {
      throw new HttpError(500, "Email service is not configured");
    }

    return res.json({
      success: true,
      requires2fa: true,
      challengeToken: signLoginChallengeToken(user._id),
      ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
        twoFactorEnabled: !!user.twoFactorEnabled,
      },
    });
  }

  const workspace = await ensureDefaultWorkspace(user);
  const token = signToken({ user, workspaceId: workspace._id });
  res.json({
    success: true,
    token,
    workspace: { id: workspace._id, name: workspace.name, plan: workspace.plan },
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
  });
}

async function verifyLoginOtp(req, res) {
  const { challengeToken, otp } = req.body;
  let payload = null;
  try {
    payload = verifyLoginChallengeToken(challengeToken);
  } catch {
    throw new HttpError(401, "Invalid or expired login challenge");
  }

  const user = await User.findById(payload.sub).select(
    "+passwordHash role email name phone +loginOtpCodeHash +loginOtpCodeExpiresAt twoFactorEnabled"
  );
  if (!user) throw new HttpError(404, "User not found");
  if (!user.loginOtpCodeHash || !user.loginOtpCodeExpiresAt || user.loginOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Please login again.");
  }
  if (sha256Hex(String(otp || "")) !== user.loginOtpCodeHash) throw new HttpError(401, "Invalid OTP code");

  user.loginOtpCodeHash = undefined;
  user.loginOtpCodeExpiresAt = undefined;
  await user.save();

  const workspace = await ensureDefaultWorkspace(user);
  const token = signToken({ user, workspaceId: workspace._id });

  res.json({
    success: true,
    token,
    workspace: { id: workspace._id, name: workspace.name, plan: workspace.plan },
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
  });
}

async function resendLoginOtp(req, res) {
  const { challengeToken } = req.body;
  let payload = null;
  try {
    payload = verifyLoginChallengeToken(challengeToken);
  } catch {
    throw new HttpError(401, "Invalid or expired login challenge");
  }

  const user = await User.findById(payload.sub).select("email name twoFactorEnabled +loginOtpCodeHash +loginOtpCodeExpiresAt");
  if (!user) throw new HttpError(404, "User not found");
  if (!user.twoFactorEnabled) throw new HttpError(400, "2FA is not enabled for this account");

  const otp = generateOtpCode();
  user.loginOtpCodeHash = sha256Hex(otp);
  user.loginOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Your login OTP code",
    htmlContent: buildOtpEmailHtml({
      code: otp,
      title: "Two-factor verification",
      subtitle: "Enter this one-time code to complete your sign-in.",
    }),
    textContent: `Your login OTP code is ${otp}. It expires in 10 minutes.`,
  });

  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProd && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  res.json({
    success: true,
    message: "OTP resent to your registered email.",
    ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
  });
}

async function verifyRegisterOtp(req, res) {
  const { challengeToken, otp } = req.body;
  let payload = null;
  try {
    payload = verifyRegisterChallengeToken(challengeToken);
  } catch {
    throw new HttpError(401, "Invalid or expired registration challenge");
  }

  const user = await User.findById(payload.sub).select(
    "+passwordHash role email name phone twoFactorEnabled +registerOtpCodeHash +registerOtpCodeExpiresAt"
  );
  if (!user) throw new HttpError(404, "User not found");
  if (!user.registerOtpCodeHash || !user.registerOtpCodeExpiresAt || user.registerOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Request a new code.");
  }
  if (sha256Hex(String(otp || "")) !== user.registerOtpCodeHash) throw new HttpError(401, "Invalid OTP code");

  user.registerOtpCodeHash = undefined;
  user.registerOtpCodeExpiresAt = undefined;
  await user.save();

  const workspace = await ensureDefaultWorkspace(user);
  const token = signToken({ user, workspaceId: workspace._id });

  res.json({
    success: true,
    token,
    workspace: { id: workspace._id, name: workspace.name, plan: workspace.plan },
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
  });
}

async function resendRegisterOtp(req, res) {
  const { challengeToken } = req.body;
  let payload = null;
  try {
    payload = verifyRegisterChallengeToken(challengeToken);
  } catch {
    throw new HttpError(401, "Invalid or expired registration challenge");
  }

  const user = await User.findById(payload.sub).select("email name +registerOtpCodeHash +registerOtpCodeExpiresAt");
  if (!user) throw new HttpError(404, "User not found");

  const otp = generateOtpCode();
  user.registerOtpCodeHash = sha256Hex(otp);
  user.registerOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Verify your account",
    htmlContent: buildOtpEmailHtml({
      code: otp,
      title: "Verify your email",
      subtitle: "Enter this OTP to finish creating your account.",
    }),
    textContent: `Your verification OTP is ${otp}. It expires in 10 minutes.`,
  });

  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProd && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  res.json({
    success: true,
    message: "OTP resent to your registered email.",
    ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
  });
}

async function me(req, res) {
  if (req.user.role === "admin" && req.user.id === "env-admin") {
    return res.json({
      success: true,
      user: {
        id: "env-admin",
        email: adminEmail,
        name: adminName,
        role: "admin",
      },
      workspace: null,
    });
  }

  const user = await User.findById(req.user.id).select("email name phone role createdAt twoFactorEnabled");
  if (!user) throw new HttpError(404, "User not found");
  let workspace = await Workspace.findOne({
    _id: req.user.workspaceId,
    ownerId: req.user.id,
    isActive: true,
  }).select("_id name plan");
  if (!workspace) {
    workspace = await ensureDefaultWorkspace(user);
  }
  res.json({
    success: true,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      createdAt: user.createdAt,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
    workspace: workspace ? { id: String(workspace._id), name: workspace.name, plan: workspace.plan } : null,
  });
}

async function apiKeyStatus(req, res) {
  await ensureMetaSetupForWorkspace(req.workspace.id);
  const user = await User.findById(req.user.id).select("+apiKeyEnc");
  if (!user) throw new HttpError(404, "User not found");
  const hasApiKey = !!user.apiKeyEnc;
  let maskedKey = "";
  if (hasApiKey) {
    try {
      const key = decryptString(user.apiKeyEnc);
      const start = key.slice(0, 4);
      const end = key.slice(-3);
      maskedKey = `${start}***${end}`;
    } catch {
      maskedKey = "";
    }
  }
  res.json({ success: true, hasApiKey, maskedKey });
}

async function requestApiKeyOtp(req, res) {
  const purpose = normalizeApiKeyOtpPurpose(req.body?.purpose);
  if (!purpose) throw new HttpError(400, "Invalid purpose");

  await ensureMetaSetupForWorkspace(req.workspace.id);

  const user = await User.findById(req.user.id).select(
    "email name +apiKeyEnc +apiKeyOtpCodeHash +apiKeyOtpCodeExpiresAt +apiKeyOtpPurpose"
  );
  if (!user) throw new HttpError(404, "User not found");

  if (purpose === "reveal" && !user.apiKeyEnc) {
    throw new HttpError(404, "No API key exists yet. Generate one first.");
  }

  const otp = generateOtpCode();
  user.apiKeyOtpCodeHash = sha256Hex(otp);
  user.apiKeyOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  user.apiKeyOtpPurpose = purpose;
  await user.save();

  const subject = purpose === "rotate" ? "Your API key generation OTP" : "Your API key reveal OTP";
  const title = purpose === "rotate" ? "API key verification" : "Reveal API key verification";
  const subtitle =
    purpose === "rotate"
      ? "Enter this OTP code to generate a new API key. The old key will stop working."
      : "Enter this OTP code to view your API key.";

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject,
    htmlContent: buildOtpEmailHtml({ code: otp, title, subtitle }),
    textContent: `Your OTP code is ${otp}. It expires in 10 minutes.`,
  });

  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProd && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  res.json({
    success: true,
    message: "OTP sent to your registered email.",
    ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
  });
}

async function verifyApiKeyOtp(req, res) {
  const purpose = normalizeApiKeyOtpPurpose(req.body?.purpose);
  const otp = String(req.body?.otp || "").trim();
  if (!purpose) throw new HttpError(400, "Invalid purpose");
  if (!/^\d{6}$/.test(otp)) throw new HttpError(400, "Invalid OTP code");

  await ensureMetaSetupForWorkspace(req.workspace.id);

  const user = await User.findById(req.user.id).select(
    "email name +apiKeyHash +apiKeyEnc +apiKeyOtpCodeHash +apiKeyOtpCodeExpiresAt +apiKeyOtpPurpose"
  );
  if (!user) throw new HttpError(404, "User not found");

  if (!user.apiKeyOtpCodeHash || !user.apiKeyOtpCodeExpiresAt || user.apiKeyOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Request a new code.");
  }
  if (String(user.apiKeyOtpPurpose || "") !== purpose) {
    throw new HttpError(400, "OTP purpose mismatch. Request a new code.");
  }
  if (sha256Hex(otp) !== user.apiKeyOtpCodeHash) {
    throw new HttpError(401, "Invalid OTP code");
  }

  user.apiKeyOtpCodeHash = undefined;
  user.apiKeyOtpCodeExpiresAt = undefined;
  user.apiKeyOtpPurpose = undefined;

  if (purpose === "rotate") {
    const apiKey = generateApiKey();
    user.apiKeyHash = sha256Hex(apiKey);
    user.apiKeyEnc = encryptString(apiKey);
    await user.save();
    return res.json({
      success: true,
      message: "API key generated successfully.",
      apiKey,
    });
  }

  if (!user.apiKeyEnc) {
    await user.save();
    throw new HttpError(404, "No API key exists yet. Generate one first.");
  }

  const apiKey = decryptString(user.apiKeyEnc);
  await user.save();
  return res.json({
    success: true,
    message: "API key revealed successfully.",
    apiKey,
  });
}

async function updateProfile(req, res) {
  const { name, phone } = req.body;

  const update = {};
  if (name !== undefined) update.name = name;
  if (phone !== undefined) update.phone = phone;

  const user = await User.findByIdAndUpdate(req.user.id, { $set: update }, { new: true }).select(
    "email name phone role createdAt twoFactorEnabled"
  );
  if (!user) throw new HttpError(404, "User not found");

  res.json({
    success: true,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      createdAt: user.createdAt,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
  });
}

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user.id).select("+passwordHash email name");
  if (!user) throw new HttpError(404, "User not found");

  const ok = await bcrypt.compare(String(currentPassword || ""), user.passwordHash);
  if (!ok) throw new HttpError(401, "Current password is incorrect");

  user.passwordHash = await bcrypt.hash(String(newPassword), 12);
  await user.save();
  res.json({ success: true });
}

async function requestEnable2fa(req, res) {
  const user = await User.findById(req.user.id).select("email name +twoFactorCodeHash +twoFactorCodeExpiresAt");
  if (!user) throw new HttpError(404, "User not found");

  const otp = generateOtpCode();
  user.twoFactorCodeHash = sha256Hex(otp);
  user.twoFactorCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Enable 2FA OTP code",
    htmlContent: buildOtpEmailHtml({
      code: otp,
      title: "Enable two-factor authentication",
      subtitle: "Use this code to enable 2FA on your account.",
    }),
    textContent: `Your code to enable 2FA is ${otp}. It expires in 10 minutes.`,
  });

  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProd && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  res.json({
    success: true,
    ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
  });
}

async function verifyEnable2fa(req, res) {
  const { otp } = req.body;
  const user = await User.findById(req.user.id).select("+twoFactorCodeHash +twoFactorCodeExpiresAt twoFactorEnabled");
  if (!user) throw new HttpError(404, "User not found");

  if (!user.twoFactorCodeHash || !user.twoFactorCodeExpiresAt || user.twoFactorCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Request a new code.");
  }
  if (sha256Hex(String(otp || "")) !== user.twoFactorCodeHash) throw new HttpError(401, "Invalid OTP code");

  user.twoFactorEnabled = true;
  user.twoFactorCodeHash = undefined;
  user.twoFactorCodeExpiresAt = undefined;
  await user.save();

  res.json({ success: true, twoFactorEnabled: true });
}

async function disable2fa(req, res) {
  const user = await User.findByIdAndUpdate(
    req.user.id,
    {
      $set: { twoFactorEnabled: false },
      $unset: { twoFactorCodeHash: 1, twoFactorCodeExpiresAt: 1, loginOtpCodeHash: 1, loginOtpCodeExpiresAt: 1 },
    },
    { new: true }
  ).select("twoFactorEnabled");

  if (!user) throw new HttpError(404, "User not found");
  res.json({ success: true, twoFactorEnabled: false });
}

async function forgotPassword(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();
  const user = await User.findOne({ email }).select("email name");
  if (user) {
    const rawToken = base64Url(crypto.randomBytes(32));
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await User.updateOne(
      { _id: user._id },
      { $set: { passwordResetTokenHash: tokenHash, passwordResetTokenExpiresAt: expiresAt } }
    );

    const resetLink = `${appBaseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
    const delivery = await sendEmail({
      toEmail: user.email,
      toName: user.name || "",
      subject: "Reset your password",
      htmlContent: `
        <div style="font-family: Inter, Arial, sans-serif; max-width: 520px; margin: 0 auto; color: #0f172a;">
          <h2 style="margin-bottom: 8px;">Password reset request</h2>
          <p style="margin: 0 0 16px; color: #475569;">Click the button below to reset your password.</p>
          <a href="${resetLink}" style="display:inline-block; background:#06b77e; color:white; text-decoration:none; padding:12px 16px; border-radius:8px; font-weight:700;">Reset Password</a>
          <p style="margin-top: 16px; color: #64748b; font-size: 13px;">This link expires in 30 minutes.</p>
        </div>
      `,
      textContent: `Reset your password using this link: ${resetLink}`,
    });

    if (shouldReturnAuthDebugTokens()) {
      res.set("X-Debug-Reset-Link", resetLink);
      res.set("X-Debug-Email-Delivery", String(delivery?.sent ? "sent" : delivery?.skipped ? "skipped" : "failed"));
    }
  }

  res.json({ success: true, message: "If your email is registered, a reset link has been sent." });
}

async function resetPassword(req, res) {
  const { token, password } = req.body;
  const tokenHash = sha256Hex(String(token || ""));
  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetTokenExpiresAt: { $gt: new Date() },
  }).select("+passwordHash");

  if (!user) throw new HttpError(400, "Invalid or expired reset token");

  user.passwordHash = await bcrypt.hash(String(password), 12);
  user.passwordResetTokenHash = undefined;
  user.passwordResetTokenExpiresAt = undefined;
  await user.save();

  res.json({ success: true });
}

module.exports = {
  register,
  login,
  verifyLoginOtp,
  resendLoginOtp,
  verifyRegisterOtp,
  resendRegisterOtp,
  me,
  apiKeyStatus,
  requestApiKeyOtp,
  verifyApiKeyOtp,
  updateProfile,
  changePassword,
  requestEnable2fa,
  verifyEnable2fa,
  disable2fa,
  forgotPassword,
  resetPassword,
};
