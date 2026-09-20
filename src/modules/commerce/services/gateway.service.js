const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const { encryptCommerceSecret, decryptCommerceSecret } = require("./commerceSecrets.service");
const { hash, randomToken, SESSION_MS, gatewayDto, tokenFields, validSignature } = require("../domain/gateway");
const validators = require("../validators/gateway.validators");
const configService = require("./gatewayConfig.service");
const repository = require("../repositories/gateway.repository");
const providerService = require("./razorpayGateway.service");

function createGatewayService({ repo = repository, provider = providerService, config = configService,
  now = () => new Date(), newId = () => new mongoose.Types.ObjectId(), random = randomToken,
  authorize = (workspaceId, userId) => requireWorkspacePermission(workspaceId, "commerce.gateway.manage", userId) } = {}) {
  const conflict = () => new HttpError(409, "Gateway changed or is busy. Refresh its status and retry.");
  const context = (record, field) => ({ workspaceId: record.workspaceId, recordId: record._id, field });
  const seal = (record, field, value) => encryptCommerceSecret(value, context(record, field));
  const open = (record, field) => decryptCommerceSecret(record[field], context(record, field));
  async function available(workspaceId, environment) {
    if (await repo.active(workspaceId, environment)) throw new HttpError(409, "Disconnect the existing gateway for this environment first.");
  }
  async function save(record) {
    try { return await repo.create(record); }
    catch (error) {
      if (error.code === 11000) throw new HttpError(409, "This gateway or environment already has an active connection.");
      throw new HttpError(503, "Gateway connection could not be saved. Check connection status before reconnecting.");
    }
  }
  async function owned(workspaceId, id) {
    const record = await repo.find(workspaceId, id);
    if (!record) throw new HttpError(404, "Gateway connection not found.");
    return record;
  }
  async function list(workspaceId) { return (await repo.list(workspaceId)).map(gatewayDto); }
  async function get(workspaceId, id) { return gatewayDto(await owned(workspaceId, id)); }
  async function connectManual(workspaceId, userId, input) {
    const { environment, keyId, keySecret } = validators.parse(validators.manual, input);
    await available(workspaceId, environment);
    await provider.probe({ authType: "api_keys", keyId, keySecret });
    await authorize(workspaceId, userId);
    const record = { _id: newId(), workspaceId, provider: "razorpay", environment, authType: "api_keys",
      createdBy: userId, keyFingerprint: hash(keyId), keyLabel: `••••${keyId.slice(-4)}`, credentialsVerifiedAt: now(),
      identityVerified: false, nativePaymentStatus: "unverified", webhookStatus: "needs_setup" };
    record.keyIdEnc = seal(record, "keyIdEnc", keyId);
    record.keySecretEnc = seal(record, "keySecretEnc", keySecret);
    return gatewayDto(await save(record));
  }
  async function startOAuth(workspaceId, userId, input) {
    const { environment } = validators.parse(validators.oauthStart, input);
    const oauth = config.oauthConfig(environment);
    // Do not issue grants unless revocation authentication has also been configured.
    config.webhookConfig(environment, now());
    await available(workspaceId, environment);
    const state = random(), nonce = random();
    const record = { _id: newId(), workspaceId, kind: "oauth", userId, environment,
      tokenHash: hash(state), expiresAt: new Date(now().getTime() + SESSION_MS) };
    record.dataEnc = seal(record, "dataEnc", JSON.stringify({ nonceHash: hash(nonce), clientId: oauth.clientId, redirectUri: oauth.redirectUri }));
    await repo.createSession(record);
    const url = new URL("https://auth.razorpay.com/authorize");
    url.search = new URLSearchParams({ client_id: oauth.clientId, response_type: "code", redirect_uri: oauth.redirectUri,
      scope: "read_write", state }).toString();
    return { authorizationUrl: url.toString(), state, nonce, expiresAt: record.expiresAt };
  }
  async function finishOAuth(userId, input, nonce) {
    const query = validators.parse(validators.callback, input);
    if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) throw new HttpError(400, "OAuth browser session is invalid. Restart the connection.");
    const session = await repo.findSession(hash(query.state), userId, now());
    if (!session) throw new HttpError(400, "OAuth state expired or was already used. Restart the connection.");
    const binding = JSON.parse(open(session, "dataEnc"));
    const oauth = config.oauthConfig(session.environment);
    if (binding.nonceHash !== hash(nonce) || binding.clientId !== oauth.clientId || binding.redirectUri !== oauth.redirectUri)
      throw new HttpError(400, "OAuth session does not match this browser or configuration.");
    await authorize(session.workspaceId, userId);
    if (!await repo.consumeSession(session, now())) throw new HttpError(409, "OAuth state was already consumed.");
    if (query.error) return { cancelled: true, workspaceId: String(session.workspaceId) };
    await available(session.workspaceId, session.environment);
    const authorizedAt = now();
    const tokens = tokenFields(await provider.exchange(oauth, query.code, session.environment), session.environment, now());
    await authorize(session.workspaceId, userId);
    const record = { _id: newId(), workspaceId: session.workspaceId, provider: "razorpay", environment: session.environment,
      authType: "oauth", createdBy: userId, oauthClientId: oauth.clientId, oauthAuthorizedAt: authorizedAt,
      merchantAccountId: tokens.merchantAccountId, identityVerified: true, credentialsVerifiedAt: null,
      keyLabel: tokens.keyLabel, tokenExpiresAt: tokens.tokenExpiresAt, refreshAfter: tokens.refreshAfter,
      nativePaymentStatus: "unverified", webhookStatus: "needs_setup", status: "error", lastErrorCode: "verification_pending" };
    record.accessTokenEnc = seal(record, "accessTokenEnc", tokens.accessToken);
    record.refreshTokenEnc = seal(record, "refreshTokenEnc", tokens.refreshToken);
    const saved = await save(record);
    // Persist an unusable connection before probing: revocation during onboarding can now
    // fence this final CAS, while an earlier revocation is caught by the credential probe.
    await provider.probe({ authType: "oauth", accessToken: tokens.accessToken });
    await authorize(session.workspaceId, userId);
    const verified = await repo.update(record.workspaceId, record._id,
      { active: true, revision: saved.revision, status: "error", lastErrorCode: "verification_pending" },
      { status: "connected", lastErrorCode: "", credentialsVerifiedAt: now() });
    if (!verified) throw conflict();
    return { gateway: gatewayDto(verified), workspaceId: String(session.workspaceId) };
  }
  async function refreshRecord(record) {
    const oauth = config.oauthConfig(record.environment);
    if (record.oauthClientId !== oauth.clientId) throw new HttpError(409, "OAuth application changed. Reconnect the gateway.");
    // Decryption/config failures occur before claiming a potentially destructive refresh.
    const refreshToken = open(record, "refreshTokenEnc");
    const owner = random();
    const claimed = await repo.claimRefresh(record, owner, now());
    if (!claimed) throw conflict();
    try {
      const tokens = tokenFields(await provider.refresh(oauth, refreshToken), record.environment, now(), record.merchantAccountId);
      const updated = await repo.update(record.workspaceId, record._id,
        { active: true, status: "connected", refreshState: "refreshing", refreshLeaseOwner: owner, revision: claimed.revision },
        { accessTokenEnc: seal(record, "accessTokenEnc", tokens.accessToken), refreshTokenEnc: seal(record, "refreshTokenEnc", tokens.refreshToken),
          tokenExpiresAt: tokens.tokenExpiresAt, refreshAfter: tokens.refreshAfter, credentialsVerifiedAt: now(), keyLabel: tokens.keyLabel,
          refreshState: "idle", refreshLeaseOwner: "", refreshLeaseUntil: null, lastErrorCode: "" });
      if (!updated) throw conflict();
      return updated;
    } catch {
      // Timeout, invalid response or persistence loss may follow a successful remote rotation.
      // Mark uncertain; even an expired lease must not resubmit the previous refresh token.
      await repo.update(record.workspaceId, record._id, { refreshState: "refreshing", refreshLeaseOwner: owner, revision: claimed.revision },
        { refreshState: "unknown", status: "error", lastErrorCode: "oauth_reconnect_required", refreshLeaseOwner: "", refreshLeaseUntil: null });
      throw new HttpError(409, "OAuth refresh could not be confirmed. Reconnect the gateway.");
    }
  }
  async function usableRecord(workspaceId, id, environment) {
    let record = await owned(workspaceId, id);
    if (record.environment !== environment || !record.active || record.status !== "connected")
      throw new HttpError(409, "Merchant gateway is unavailable for this environment.");
    if (record.authType === "oauth") {
      if (record.refreshState !== "idle") throw new HttpError(409, "OAuth refresh is pending or requires reconnection.");
      const oauth = config.oauthConfig(environment);
      if (record.oauthClientId !== oauth.clientId) throw new HttpError(409, "OAuth application changed. Reconnect the gateway.");
      if (!record.refreshAfter || !record.tokenExpiresAt) throw new HttpError(409, "OAuth token expiry is unavailable. Reconnect the gateway.");
      if (new Date(record.refreshAfter) <= now()) record = await refreshRecord(record);
      if (new Date(record.tokenExpiresAt).getTime() <= now().getTime() + 30000) throw new HttpError(409, "OAuth token has expired. Reconnect the gateway.");
    }
    return record;
  }
  function authentication(record) {
    try {
      return record.authType === "api_keys"
        ? { authType: "api_keys", keyId: open(record, "keyIdEnc"), keySecret: open(record, "keySecretEnc") }
        : { authType: "oauth", accessToken: open(record, "accessTokenEnc") };
    } catch { throw new HttpError(503, "Merchant credentials could not be read."); }
  }
  // Server-only capability; never return its result from a controller or fall back to billing keys.
  async function getMerchantAuthentication(workspaceId, id, environment) {
    if (!config.gatewayEnabled()) throw new HttpError(503, "Commerce gateways are not enabled.");
    return authentication(await usableRecord(workspaceId, id, environment));
  }
  // Recovery survives the new-checkout kill switches and local disconnect. Never
  // substitute another connection or refresh a disconnected/revoked OAuth grant.
  async function getReconciliationAuthentication(workspaceId, id, environment) {
    let record = await owned(workspaceId, id);
    if (record.environment !== environment || record.status === "revoked")
      throw new HttpError(409, "Original merchant authorization is unavailable.");
    if (record.authType === "oauth") {
      if (record.active && record.status === "connected" && config.oauthEnabled())
        record = await usableRecord(workspaceId, id, environment);
      if (record.refreshState !== "idle" || !record.tokenExpiresAt || new Date(record.tokenExpiresAt).getTime() <= now().getTime() + 30000)
        throw new HttpError(409, "Historical merchant authorization expired or requires inspection.");
    }
    return authentication(record);
  }
  async function verify(workspaceId, id, input) {
    const { revision } = validators.parse(validators.revisionBody, input);
    let record = await owned(workspaceId, id);
    if (!record.active || record.revision !== revision) throw conflict();
    if (record.authType === "oauth") record = await usableRecord(workspaceId, id, record.environment);
    try { await provider.probe(authentication(record)); }
    catch (error) {
      if (error.authenticationRejected) await repo.update(workspaceId, id, { active: true, revision: record.revision },
        { status: "error", lastErrorCode: "credentials_rejected" });
      throw error;
    }
    const updated = await repo.update(workspaceId, id, { active: true, revision: record.revision },
      { status: "connected", credentialsVerifiedAt: now(), lastErrorCode: "" });
    if (!updated) throw conflict();
    return gatewayDto(updated);
  }
  async function disconnect(workspaceId, id, input) {
    const { revision } = validators.parse(validators.revisionBody, input);
    const record = await owned(workspaceId, id);
    if (record.revision !== revision) throw conflict();
    if (!record.active) return gatewayDto(record);
    if (record.refreshState === "refreshing" && new Date(record.refreshLeaseUntil) > now()) throw conflict();
    const updated = await repo.update(workspaceId, id, { active: true, revision },
      { active: false, status: "disconnected", refreshState: record.refreshState === "refreshing" ? "unknown" : record.refreshState,
        refreshLeaseOwner: "", refreshLeaseUntil: null });
    if (!updated) throw conflict();
    return gatewayDto(updated);
  }
  async function receiveRevocation(environment, rawBody, signature) {
    validators.parse(validators.environment, environment);
    const oauth = config.webhookConfig(environment, now());
    if (!validSignature(rawBody, signature, oauth.secrets)) throw new HttpError(401, "Invalid OAuth webhook signature.");
    let payload;
    try { payload = JSON.parse(rawBody.toString("utf8")); } catch { throw new HttpError(400, "Invalid OAuth webhook JSON."); }
    // Authenticated unrelated partner events have no gateway effect.
    if (payload?.event !== "account.app.authorization_revoked") return;
    const event = validators.parse(validators.revocation, payload);
    if (event.created_at > Math.floor(now().getTime() / 1000) + 300) throw new HttpError(400, "Invalid OAuth webhook timestamp.");
    // Durable idempotent effect before acknowledgement; no payment event processing in Stage 3.
    await repo.revokeAccount(environment, oauth.clientId, event.account_id, event.created_at);
  }
  async function maintain() {
    if (!config.oauthEnabled()) return { skipped: true };
    await repo.expireRefreshes(now());
    const candidates = await repo.dueRefreshes(now());
    let refreshed = 0, deferred = 0;
    for (const candidate of candidates) {
      try { await usableRecord(candidate.workspaceId, candidate._id, candidate.environment); refreshed++; }
      catch { deferred++; }
    }
    return { refreshed, deferred };
  }
  return { list, get, connectManual, startOAuth, finishOAuth, verify, disconnect, getMerchantAuthentication, getReconciliationAuthentication, receiveRevocation, maintain };
}
module.exports = { createGatewayService, ...createGatewayService() };
