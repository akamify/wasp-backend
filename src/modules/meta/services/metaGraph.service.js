const axios = require("axios");
const { metaGraphVersion } = require("@core/config/env");

function getMetaGraphVersion(overrideVersion) {
  return String(overrideVersion || metaGraphVersion || "v22.0").trim();
}

function graphBaseUrl(overrideVersion) {
  return `https://graph.facebook.com/${getMetaGraphVersion(overrideVersion)}`;
}

function createMetaClient({ graphApiVersion, timeout = 20000 } = {}) {
  return axios.create({
    baseURL: graphBaseUrl(graphApiVersion),
    timeout,
  });
}

function authHeaders(accessToken, extraHeaders = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...extraHeaders,
  };
}

module.exports = {
  authHeaders,
  createMetaClient,
  getMetaGraphVersion,
  graphBaseUrl,
};
