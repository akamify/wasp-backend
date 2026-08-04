const { HttpError } = require("@shared/utils/httpError");
const { createMetaClient } = require("@modules/meta/services/metaGraph.service");
const { getToken, META_TOKEN_TYPES } = require("@modules/meta/services/tokenProvider.service");
const settingsResolver = require("@modules/platform-settings/services/platformSettingsResolver.service");
const { PLATFORM_SETTING_KEYS } = require("@modules/platform-settings/constants/platformSettingKeys");
const { sanitizeMetaError } = require("@modules/meta/services/metaError.service");

async function getConfiguredSystemUserId() {
  const value = await settingsResolver.getSetting(
    PLATFORM_SETTING_KEYS.SYSTEM_USER_ID,
    process.env.SYSTEM_USER_ID || ""
  );
  return String(value || "").trim();
}

async function fetchWabaOwnerBusinessInfo({ client, accessToken, wabaId }) {
  const response = await client.get(`/${wabaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { fields: "id,name,owner_business_info" },
  });
  const owner = response?.data?.owner_business_info || null;
  return {
    wabaName: String(response?.data?.name || "").trim() || null,
    businessManagerId: owner?.id ? String(owner.id).trim() : null,
  };
}

async function addSystemUserToWaba({ client, accessToken, wabaId, systemUserId }) {
  return client.post(`/${wabaId}/assigned_users`, null, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      user: systemUserId,
      tasks: "['MANAGE']",
    },
  });
}

async function fetchAssignedUsers({ client, accessToken, wabaId, businessManagerId }) {
  const response = await client.get(`/${wabaId}/assigned_users`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      business: businessManagerId,
    },
  });
  return Array.isArray(response?.data?.data) ? response.data.data : [];
}

async function ensureSystemUserProvisionedOnWaba({ wabaId, graphApiVersion, customerAccessToken = "" }) {
  const accessToken = await getToken({ tokenType: META_TOKEN_TYPES.SYSTEM_USER });
  const systemUserId = await getConfiguredSystemUserId();
  if (!systemUserId) {
    throw new HttpError(500, "Missing Meta system user ID configuration.");
  }

  const client = createMetaClient({ graphApiVersion, timeout: 20000 });
  const waba = await fetchWabaOwnerBusinessInfo({
    client,
    accessToken: customerAccessToken || accessToken,
    wabaId,
  }).catch((err) => {
    const statusCode = Number(err?.response?.status || err?.statusCode || 400);
    throw new HttpError(statusCode >= 400 && statusCode < 600 ? statusCode : 400, "Could not fetch WABA ownership details.", {
      step: "fetch_waba_owner_business_info",
      endpoint: `/${wabaId}`,
      message: sanitizeMetaError(err, "WABA ownership lookup failed"),
      status: err?.response?.status || null,
      code: err?.response?.data?.error?.code || null,
      subcode: err?.response?.data?.error?.error_subcode || null,
      fbtraceId: err?.response?.data?.error?.fbtrace_id || null,
    });
  });

  await addSystemUserToWaba({
    client,
    accessToken,
    wabaId,
    systemUserId,
  }).catch((err) => {
    const message = sanitizeMetaError(err, "System user could not be added to the selected WABA");
    if (/already|duplicate|exists/i.test(String(message))) {
      return null;
    }
    const statusCode = Number(err?.response?.status || err?.statusCode || 400);
    throw new HttpError(statusCode >= 400 && statusCode < 600 ? statusCode : 400, "Could not provision the selected WABA for messaging.", {
      step: "assign_system_user_to_waba",
      endpoint: `/${wabaId}/assigned_users`,
      message,
      status: err?.response?.status || null,
      code: err?.response?.data?.error?.code || null,
      subcode: err?.response?.data?.error?.error_subcode || null,
      fbtraceId: err?.response?.data?.error?.fbtrace_id || null,
    });
  });

  if (waba.businessManagerId) {
    const assignedUsers = await fetchAssignedUsers({
      client,
      accessToken,
      wabaId,
      businessManagerId: waba.businessManagerId,
    }).catch((err) => {
      const statusCode = Number(err?.response?.status || err?.statusCode || 400);
      throw new HttpError(statusCode >= 400 && statusCode < 600 ? statusCode : 400, "Could not verify WABA system user assignment.", {
        step: "verify_waba_assigned_users",
        endpoint: `/${wabaId}/assigned_users`,
        message: sanitizeMetaError(err, "WABA assigned users lookup failed"),
        status: err?.response?.status || null,
        code: err?.response?.data?.error?.code || null,
        subcode: err?.response?.data?.error?.error_subcode || null,
        fbtraceId: err?.response?.data?.error?.fbtrace_id || null,
      });
    });

    const isAssigned = assignedUsers.some((row) => String(row?.id || "").trim() === systemUserId);
    if (!isAssigned) {
      throw new HttpError(400, "Meta did not confirm system user assignment on the selected WABA.");
    }
  }

  return {
    businessManagerId: waba.businessManagerId,
    wabaName: waba.wabaName,
    systemUserId,
  };
}

module.exports = {
  ensureSystemUserProvisionedOnWaba,
};
