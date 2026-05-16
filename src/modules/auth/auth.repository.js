const { User } = require("@infra/database/User");
const { Workspace } = require("@infra/database/Workspace");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { AdminAccount } = require("@infra/database/AdminAccount");
const { AdminLoginEvent } = require("@infra/database/AdminLoginEvent");

async function findUserIdByEmail(emailLower) {
  return User.findOne({ email: emailLower }).select("_id");
}

async function createUser({ email, passwordHash, name, phone }) {
  return User.create({ email, passwordHash, name, phone, status: "active" });
}

async function createWorkspaceForOwner({ ownerId, name }) {
  return Workspace.create({ ownerId, name });
}

async function findDefaultWorkspaceForOwner(ownerId) {
  return Workspace.findOne({ ownerId, isActive: true }).sort({ createdAt: 1 }).select("_id name plan");
}

async function findWorkspaceForUserAndId({ workspaceId, ownerId }) {
  return Workspace.findOne({ _id: workspaceId, ownerId, isActive: true }).select("_id name plan");
}

async function hasValidMetaCredentials(workspaceId) {
  return WhatsAppCredentials.exists({ workspaceId, isValid: true });
}

async function findUserForLoginByEmail(emailLower) {
  return User.findOne({ email: emailLower }).select(
    "+passwordHash role email name phone twoFactorEnabled accountBlocked tokenVersion +loginOtpCodeHash +loginOtpCodeExpiresAt"
  );
}

async function findUserForVerifyLoginOtp(userId) {
  return User.findById(userId).select(
    "+passwordHash role email name phone accountBlocked tokenVersion +loginOtpCodeHash +loginOtpCodeExpiresAt twoFactorEnabled"
  );
}

async function findUserForVerifyRegisterOtp(userId) {
  return User.findById(userId).select(
    "+passwordHash role email name phone accountBlocked tokenVersion twoFactorEnabled +registerOtpCodeHash +registerOtpCodeExpiresAt"
  );
}

async function findUserForResendLoginOtp(userId) {
  return User.findById(userId).select("email name twoFactorEnabled +loginOtpCodeHash +loginOtpCodeExpiresAt");
}

async function findUserForResendRegisterOtp(userId) {
  return User.findById(userId).select("email name +registerOtpCodeHash +registerOtpCodeExpiresAt");
}

async function findUserForMe(userId) {
  return User.findById(userId).select("email name phone role createdAt twoFactorEnabled");
}

async function findUserForApiKeyStatus(userId) {
  return User.findById(userId).select("+apiKeyEnc apiKeys");
}

async function findUserForApiKeyOtp(userId) {
  return User.findById(userId).select("email name apiKeys +apiKeyEnc +apiKeyOtpCodeHash +apiKeyOtpCodeExpiresAt +apiKeyOtpPurpose");
}

async function findUserForVerifyApiKeyOtp(userId) {
  return User.findById(userId).select(
    "email name apiKeys +apiKeyHash +apiKeyEnc +apiKeyOtpCodeHash +apiKeyOtpCodeExpiresAt +apiKeyOtpPurpose"
  );
}

async function updateUserById(userId, update, options = {}) {
  return User.findByIdAndUpdate(userId, update, options);
}

async function findUserWithPasswordHash(userId) {
  return User.findById(userId).select("+passwordHash email name");
}

async function findUserForEnable2faRequest(userId) {
  return User.findById(userId).select("email name +twoFactorCodeHash +twoFactorCodeExpiresAt");
}

async function findUserForEnable2faVerify(userId) {
  return User.findById(userId).select("+twoFactorCodeHash +twoFactorCodeExpiresAt twoFactorEnabled");
}

async function findUserForForgotPassword(emailLower) {
  return User.findOne({ email: emailLower }).select("email name");
}

async function setUserPasswordResetToken(userId, { tokenHash, expiresAt }) {
  return User.updateOne(
    { _id: userId },
    { $set: { passwordResetTokenHash: tokenHash, passwordResetTokenExpiresAt: expiresAt } }
  );
}

async function findUserByValidPasswordResetToken(tokenHash) {
  return User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetTokenExpiresAt: { $gt: new Date() },
  }).select("+passwordHash");
}

async function findAdminAccountForEnsure(username) {
  return AdminAccount.findOne({ username }).select("+passwordHash username displayName envLoginDisabled");
}

async function createAdminAccount({ username, displayName, passwordHash }) {
  return AdminAccount.create({ username, displayName, passwordHash, envLoginDisabled: false });
}

async function findAdminAccountForMe(adminId) {
  return AdminAccount.findById(adminId).select("username displayName");
}

async function findAdminAccountForResetByToken({ username, tokenHash }) {
  return AdminAccount.findOne({
    username,
    passwordResetTokenHash: tokenHash,
    passwordResetTokenExpiresAt: { $gt: new Date() },
  }).select("+passwordHash passwordResetTokenHash passwordResetTokenExpiresAt envLoginDisabled");
}

async function createAdminLoginEvent(data) {
  return AdminLoginEvent.create(data);
}

module.exports = {
  findUserIdByEmail,
  createUser,
  createWorkspaceForOwner,
  findDefaultWorkspaceForOwner,
  findWorkspaceForUserAndId,
  hasValidMetaCredentials,
  findUserForLoginByEmail,
  findUserForVerifyLoginOtp,
  findUserForVerifyRegisterOtp,
  findUserForResendLoginOtp,
  findUserForResendRegisterOtp,
  findUserForMe,
  findUserForApiKeyStatus,
  findUserForApiKeyOtp,
  findUserForVerifyApiKeyOtp,
  updateUserById,
  findUserWithPasswordHash,
  findUserForEnable2faRequest,
  findUserForEnable2faVerify,
  findUserForForgotPassword,
  setUserPasswordResetToken,
  findUserByValidPasswordResetToken,
  findAdminAccountForEnsure,
  createAdminAccount,
  findAdminAccountForMe,
  findAdminAccountForResetByToken,
  createAdminLoginEvent,
};

