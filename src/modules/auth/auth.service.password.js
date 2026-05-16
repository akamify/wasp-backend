const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { appBaseUrl } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { sendEmail } = require("@shared/services/emailService");
const repo = require("@modules/auth/auth.repository");
const { base64Url, shouldReturnAuthDebugTokens } = require("@modules/auth/auth.utils");

async function forgotPassword({ email }) {
  const normalized = String(email || "").trim().toLowerCase();
  const user = await repo.findUserForForgotPassword(normalized);

  const headers = {};
  if (user) {
    const rawToken = base64Url(crypto.randomBytes(32));
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await repo.setUserPasswordResetToken(user._id, { tokenHash, expiresAt });

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
      headers["X-Debug-Reset-Link"] = resetLink;
      headers["X-Debug-Email-Delivery"] = String(delivery?.sent ? "sent" : delivery?.skipped ? "skipped" : "failed");
    }
  }

  return {
    headers,
    body: { success: true, message: "If your email is registered, a reset link has been sent." },
  };
}

async function resetPassword({ token, password }) {
  const tokenHash = sha256Hex(String(token || ""));
  const user = await repo.findUserByValidPasswordResetToken(tokenHash);
  if (!user) throw new HttpError(400, "Invalid or expired reset token");

  user.passwordHash = await bcrypt.hash(String(password), 12);
  user.passwordResetTokenHash = undefined;
  user.passwordResetTokenExpiresAt = undefined;
  await user.save();

  return { success: true };
}

module.exports = {
  forgotPassword,
  resetPassword,
};


