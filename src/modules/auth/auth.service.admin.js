const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { adminEmail, adminPassword, adminName, appBaseUrl } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { sendEmail } = require("@shared/services/emailService");
const repo = require("@modules/auth/auth.repository");
const { base64Url, isProdEnv, shouldReturnAuthDebugTokens } = require("@modules/auth/auth.utils");
const { signAdminToken } = require("@modules/auth/auth.tokens");

async function isEnvAdminLogin(email, password) {
  if (!adminEmail || !adminPassword) return false;
  const allowInProd = String(process.env.ALLOW_ENV_ADMIN_LOGIN || "").toLowerCase() === "true";
  if (isProdEnv() && !allowInProd) return false;

  try {
    const existing = await repo.findAdminAccountForEnsure("admin");
    if (existing?.envLoginDisabled) return false;
  } catch {}

  return (
    String(email || "").trim().toLowerCase() === String(adminEmail).trim().toLowerCase() &&
    String(password || "") === String(adminPassword)
  );
}

async function ensureLocalAdminAccount() {
  const username = "admin";
  const existing = await repo.findAdminAccountForEnsure(username);
  if (existing) return existing;

  const seedPassword = String(adminPassword || "").trim();
  if (isProdEnv() && !seedPassword) {
    throw new HttpError(500, "Admin account is not initialized. Set ADMIN_PASSWORD and restart the server.");
  }

  const passwordToUse = seedPassword || "admin";
  const passwordHash = await bcrypt.hash(passwordToUse, 12);
  return repo.createAdminAccount({
    username,
    displayName: adminName || "Demo Admin",
    passwordHash,
  });
}

async function adminLogin({ email, password, req }) {
  const adminAccount = await ensureLocalAdminAccount();
  const okDb = await bcrypt.compare(String(password || ""), adminAccount.passwordHash);
  const okEnv = await isEnvAdminLogin(email, password);
  if (!okDb && !okEnv) throw new HttpError(401, "Invalid credentials");

  if (!okDb && okEnv) {
    adminAccount.passwordHash = await bcrypt.hash(String(password || ""), 12);
    await adminAccount.save();
  }

  const token = signAdminToken(adminAccount._id);
  try {
    const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = forwarded || String(req?.ip || "").trim();
    const userAgent = String(req?.headers?.["user-agent"] || "").trim();
    await repo.createAdminLoginEvent({
      adminAccountId: adminAccount._id,
      ip,
      userAgent,
      method: okEnv && !okDb ? "env" : "password",
    });
  } catch {}

  return {
    success: true,
    token,
    workspace: null,
    user: {
      id: String(adminAccount._id),
      email: adminEmail || "admin",
      name: adminAccount.displayName || "Admin",
      role: "admin",
    },
  };
}

async function adminMe(adminId) {
  const adminAccount = await repo.findAdminAccountForMe(adminId);
  if (!adminAccount) throw new HttpError(401, "Invalid or expired token");
  return {
    success: true,
    user: {
      id: String(adminAccount._id),
      email: adminAccount.username,
      name: adminAccount.displayName || "Admin",
      role: "admin",
    },
    workspace: null,
  };
}

async function adminForgotPassword({ email }) {
  const normalized = String(email || "").trim().toLowerCase();
  const configured = String(adminEmail || "").trim().toLowerCase();

  if (!configured || normalized !== configured) {
    return { success: true, message: "If the email is valid, a reset link has been sent." };
  }

  const adminAccount = await ensureLocalAdminAccount();
  const rawToken = base64Url(crypto.randomBytes(32));
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  adminAccount.passwordResetTokenHash = tokenHash;
  adminAccount.passwordResetTokenExpiresAt = expiresAt;
  await adminAccount.save();

  const resetLink = `${appBaseUrl}/admin/reset-password?token=${encodeURIComponent(rawToken)}`;
  const delivery = await sendEmail({
    toEmail: configured,
    toName: adminName || "Admin",
    subject: "Reset your admin password",
    htmlContent: `
      <div style="font-family: Inter, Arial, sans-serif; max-width: 520px; margin: 0 auto; color: #0f172a;">
        <h2 style="margin-bottom: 8px;">Admin password reset</h2>
        <p style="margin: 0 0 16px; color: #475569;">Click the button below to reset your admin password.</p>
        <a href="${resetLink}" style="display:inline-block; background:#06b77e; color:white; text-decoration:none; padding:12px 16px; border-radius:8px; font-weight:700;">Reset Admin Password</a>
        <p style="margin-top: 16px; color: #64748b; font-size: 13px;">This link expires in 30 minutes.</p>
      </div>
    `,
    textContent: `Reset your admin password using this link: ${resetLink}`,
  });

  const headers = {};
  if (shouldReturnAuthDebugTokens()) {
    headers["X-Debug-Admin-Reset-Link"] = resetLink;
    headers["X-Debug-Email-Delivery"] = String(delivery?.sent ? "sent" : delivery?.skipped ? "skipped" : "failed");
  }

  return {
    headers,
    body: { success: true, message: "If the email is valid, a reset link has been sent." },
  };
}

async function adminResetPassword({ token, password }) {
  const tokenHash = sha256Hex(String(token || ""));
  const adminAccount = await repo.findAdminAccountForResetByToken({ username: "admin", tokenHash });
  if (!adminAccount) throw new HttpError(400, "Invalid or expired reset token");

  adminAccount.passwordHash = await bcrypt.hash(String(password), 12);
  adminAccount.passwordResetTokenHash = undefined;
  adminAccount.passwordResetTokenExpiresAt = undefined;
  adminAccount.envLoginDisabled = true;
  await adminAccount.save();

  return { success: true };
}

module.exports = {
  ensureLocalAdminAccount,
  isEnvAdminLogin,
  adminLogin,
  adminMe,
  adminForgotPassword,
  adminResetPassword,
};


