const apiKeyService = require("@modules/api-keys/services/apiKey.service");
const otpService = require("@modules/api-keys/services/apiKeyOtp.service");
const permissionService = require("@modules/api-keys/services/apiKeyPermission.service");

async function listApiKeys(req, res) {
  res.json(await apiKeyService.listMyApiKeys({ userId: req.user.id }));
}

async function listUserApiKeys(req, res) {
  res.json(await apiKeyService.listMyApiKeys({ userId: req.params.id }));
}

async function generateApiKey(req, res) {
  res.json(await apiKeyService.generateApiKey({ userId: req.user.id, name: req.body?.name }));
}

async function regenerateApiKey(req, res) {
  res.json(await apiKeyService.regenerateApiKey({ userId: req.user.id, keyId: req.body?.keyId, name: req.body?.name }));
}

async function deleteApiKey(req, res) {
  res.json(await apiKeyService.deleteApiKey({ userId: req.user.id, keyId: req.params.id }));
}

async function sendChatAccessOtp(req, res) {
  res.json(await otpService.sendSecurityOtp({
    userId: req.params.id,
    purpose: "admin_enable_chat_access",
    title: "Admin chat access verification",
    subtitle: "Enter this OTP to allow chat API access.",
  }));
}

async function verifyChatAccessOtp(req, res) {
  await otpService.verifySecurityOtp({
    userId: req.params.id,
    purpose: "admin_enable_chat_access",
    otp: req.body?.otp,
  });
  res.json(await permissionService.enableChatAccess({ req, adminUserId: req.user.id, userId: req.params.id }));
}

async function disableChatAccess(req, res) {
  res.json(await permissionService.disableChatAccess({ req, userId: req.params.id }));
}

async function enableChatAccess(req, res) {
  res.json(await permissionService.enableChatAccess({ req, adminUserId: req.user.id, userId: req.params.id }));
}

async function enableCampaignSend(req, res) {
  res.json(await permissionService.enableCampaignSend({ userId: req.params.id }));
}

async function disableCampaignSend(req, res) {
  res.json(await permissionService.disableCampaignSend({ userId: req.params.id }));
}

async function enableKey(req, res) {
  res.json(await permissionService.setUserApiKeyState({ userId: req.params.id, keyId: req.params.keyId, revoked: false }));
}

async function disableKey(req, res) {
  res.json(await permissionService.setUserApiKeyState({ userId: req.params.id, keyId: req.params.keyId, revoked: true }));
}

async function setApiKeyChatAccess(req, res) {
  res.json(
    await permissionService.setApiKeyChatAccess({
      req,
      userId: req.params.id,
      keyId: req.params.keyId,
      enabled: Boolean(req.body?.enabled),
    })
  );
}

async function syncUserApiKeysChatAccess(req, res) {
  res.json(
    await permissionService.bulkSyncApiKeysChatAccess({
      req,
      userId: req.params.id,
      enabled: Boolean(req.body?.enabled),
    })
  );
}

async function blockUser(req, res) {
  res.json(await permissionService.blockUser({ userId: req.params.id }));
}

async function unblockUser(req, res) {
  res.json(await permissionService.unblockUser({ userId: req.params.id }));
}

module.exports = {
  listApiKeys,
  listUserApiKeys,
  generateApiKey,
  regenerateApiKey,
  deleteApiKey,
  sendChatAccessOtp,
  verifyChatAccessOtp,
  disableChatAccess,
  enableChatAccess,
  enableCampaignSend,
  disableCampaignSend,
  enableKey,
  disableKey,
  setApiKeyChatAccess,
  syncUserApiKeysChatAccess,
  blockUser,
  unblockUser,
};
