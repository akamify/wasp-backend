const { User } = require("@infra/database/User");
const { Workspace } = require("@infra/database/Workspace");
const { WorkspaceMember } = require("@infra/database/WorkspaceMember");
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
  const existing = await Workspace.findOne({ ownerId }).sort({ createdAt: 1 }).select("_id ownerId ownerUserId name plan createdAt");
  if (existing) return existing;
  const workspace = await Workspace.create({
    ownerId,
    ownerUserId: ownerId,
    name,
    allowedApiPermissions: {
      campaignSend: true,
      chatAccess: false,
    },
  });
  await WorkspaceMember.create({
    workspaceId: workspace._id,
    userId: ownerId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  return workspace;
}

async function findDefaultWorkspaceForOwner(ownerId) {
  return Workspace.findOne({ ownerId, isActive: true }).sort({ createdAt: 1 }).select("_id ownerId ownerUserId name plan createdAt");
}

async function findWorkspaceForUserAndId({ workspaceId, ownerId }) {
  const membership = await WorkspaceMember.findOne({ workspaceId, userId: ownerId, status: "active" }).select("workspaceId role");
  if (membership) return Workspace.findOne({ _id: workspaceId, isActive: true, status: { $ne: "deleted" } }).select("_id name plan");
  const owned = await Workspace.findOne({ _id: workspaceId, ownerId, isActive: true, status: { $ne: "deleted" } }).select("_id name plan");
  if (!owned) return null;
  await WorkspaceMember.updateOne(
    { workspaceId: owned._id, userId: ownerId },
    { $setOnInsert: { role: "owner", status: "active", joinedAt: owned.createdAt || new Date() } },
    { upsert: true }
  );
  return owned;
}

async function hasValidMetaCredentials(workspaceId) {
  return WhatsAppCredentials.exists({ workspaceId, isValid: true, isActive: { $ne: false } });
}

async function findUserForLoginByEmail(emailLower) {
  return User.findOne({ email: emailLower }).select(
    "+passwordHash role email name phone twoFactorEnabled accountBlocked tokenVersion adminPermissions +loginOtpCodeHash +loginOtpCodeExpiresAt +loginOtpAttempts +loginOtpLastSentAt"
  );
}

async function findUserForVerifyLoginOtp(userId) {
  return User.findById(userId).select(
    "+passwordHash role email name phone accountBlocked tokenVersion +loginOtpCodeHash +loginOtpCodeExpiresAt +loginOtpAttempts +loginOtpLastSentAt twoFactorEnabled"
  );
}

async function findUserForVerifyRegisterOtp(userId) {
  return User.findById(userId).select(
    "+passwordHash role email name phone accountBlocked tokenVersion twoFactorEnabled +registerOtpCodeHash +registerOtpCodeExpiresAt"
  );
}

async function findUserForResendLoginOtp(userId) {
  return User.findById(userId).select(
    "email name role twoFactorEnabled +loginOtpCodeHash +loginOtpCodeExpiresAt +loginOtpAttempts +loginOtpLastSentAt"
  );
}

async function findUserForResendRegisterOtp(userId) {
  return User.findById(userId).select("email name +registerOtpCodeHash +registerOtpCodeExpiresAt");
}

async function findUserForMe(userId) {
  return User.findById(userId).select("email name phone role createdAt twoFactorEnabled adminPermissions");
}

async function findUserForApiKeyStatus(userId) {
  return User.findById(userId).select("+apiKeyEnc apiKeys +apiKeys.keyEnc");
}

async function findUserForApiKeyOtp(userId) {
  return User.findById(userId).select("email name apiKeys +apiKeyEnc +apiKeys.keyEnc +apiKeyOtpCodeHash +apiKeyOtpCodeExpiresAt +apiKeyOtpPurpose");
}

async function findUserForVerifyApiKeyOtp(userId) {
  return User.findById(userId).select(
    "email name apiKeys +apiKeyHash +apiKeyEnc +apiKeys.keyEnc +apiKeyOtpCodeHash +apiKeyOtpCodeExpiresAt +apiKeyOtpPurpose"
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

async function findUserForProfileOtp(userId) {
  return User.findById(userId).select(
    "email name phone role +profileOtpCodeHash +profileOtpCodeExpiresAt +profileOtpPurpose +pendingEmail +pendingPhone +pendingName"
  );
}

async function findUserForForgotPassword(emailLower) {
  return User.findOne({ email: emailLower }).select("email name role");
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
  findUserForProfileOtp,
  findUserForForgotPassword,
  setUserPasswordResetToken,
  findUserByValidPasswordResetToken,
  findAdminAccountForEnsure,
  createAdminAccount,
  findAdminAccountForMe,
  findAdminAccountForResetByToken,
  createAdminLoginEvent,
};

