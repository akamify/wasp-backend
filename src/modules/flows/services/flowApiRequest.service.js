const axios = require("axios");
const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const {
  resolveVariables,
  writeEvent,
} = require("@modules/flows/services/flowRuntime.utils");

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_EVENT_BODY_CHARS = 4000;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
]);
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIp(address) {
  const normalized = String(address || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
    const groups = mapped.split(":");
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIpv4(
          `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
        );
      }
    }
  }
  return false;
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    if (Array.isArray(address)) {
      if (address.some((entry) => isPrivateIp(entry?.address))) {
        return callback(
          new Error("Private or local network destinations are blocked")
        );
      }
      return callback(null, address);
    }
    if (isPrivateIp(address)) {
      return callback(new Error("Private or local network destinations are blocked"));
    }
    return callback(null, address, family);
  });
}

const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

function parseSafeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("API request URL is invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("API request URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("API request URL credentials are not allowed");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Localhost destinations are blocked");
  }
  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw new Error("Private or local network destinations are blocked");
  }
  return parsed;
}

function normalizedTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(timeout), 1000), MAX_TIMEOUT_MS);
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [String(name || "").trim(), value])
      .filter(
        ([name, value]) =>
          name &&
          !FORBIDDEN_HEADERS.has(name.toLowerCase()) &&
          value !== null &&
          value !== undefined
      )
      .map(([name, value]) => [name, String(value)])
  );
}

function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : String(value).slice(0, 500),
    ])
  );
}

function summarizeUrl(parsed) {
  return {
    origin: parsed.origin,
    pathname: parsed.pathname,
    queryKeys: Array.from(parsed.searchParams.keys()),
  };
}

function getPath(source, path) {
  const keys = String(path || "").split(".").filter(Boolean);
  if (keys.some((key) => UNSAFE_OBJECT_KEYS.has(key))) return undefined;
  return keys.reduce((value, key) => value?.[key], source);
}

function applyResponseMapping(context, responseData, responseMapping) {
  const mapped = { ...(context || {}) };
  if (
    !responseMapping ||
    typeof responseMapping !== "object" ||
    Array.isArray(responseMapping)
  ) {
    return mapped;
  }
  for (const [contextKey, responsePath] of Object.entries(responseMapping)) {
    const key = String(contextKey || "").trim();
    if (
      !key ||
      key.includes(".") ||
      key.startsWith("$") ||
      UNSAFE_OBJECT_KEYS.has(key)
    ) {
      continue;
    }
    const value = getPath(responseData, responsePath);
    if (value !== undefined) mapped[key] = value;
  }
  return mapped;
}

function summarizeBody(data) {
  if (data === undefined) return null;
  try {
    const serialized =
      typeof data === "string" ? data : JSON.stringify(data);
    return {
      value: serialized.slice(0, MAX_EVENT_BODY_CHARS),
      truncated: serialized.length > MAX_EVENT_BODY_CHARS,
    };
  } catch {
    return { value: "[Unserializable response body]", truncated: false };
  }
}

function serializeApiError(error) {
  const code = String(error?.code || "");
  return {
    code: code || "API_REQUEST_FAILED",
    message:
      code === "ECONNABORTED"
        ? "API request timed out"
        : String(error?.message || "API request failed").slice(0, 1000),
  };
}

async function executeApiRequestNode({
  workspaceId,
  session,
  node,
  scope,
}) {
  const config = node.config || {};
  const method = String(config.method || "").trim().toUpperCase();
  const resolvedUrl = resolveVariables(config.url, scope);
  const resolvedHeaders = normalizeHeaders(
    resolveVariables(config.headers || {}, scope)
  );
  const resolvedBody = resolveVariables(config.body, scope);
  const timeout = normalizedTimeout(config.timeoutMs);
  let parsedUrl;
  let response = null;
  let failure = null;

  try {
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error("API request method is not allowed");
    }
    parsedUrl = parseSafeUrl(resolvedUrl);
    response = await axios.request({
      method,
      url: parsedUrl.toString(),
      headers: resolvedHeaders,
      ...(method === "GET" ? {} : { data: resolvedBody }),
      timeout,
      maxRedirects: 3,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_REQUEST_BYTES,
      responseType: "json",
      transitional: { silentJSONParsing: true, forcedJSONParsing: true },
      validateStatus: () => true,
      proxy: false,
      httpAgent,
      httpsAgent,
    });
  } catch (error) {
    failure = serializeApiError(error);
  }

  const success =
    Boolean(response) && response.status >= 200 && response.status < 300;
  const status = response?.status || null;
  if (!success && !failure) {
    failure = {
      code: "API_HTTP_ERROR",
      message: `API request returned HTTP ${status}`,
      status,
    };
  }

  const context = success
    ? applyResponseMapping(
        session.context,
        response.data,
        config.responseMapping
      )
    : {
        ...(session.context || {}),
        lastApiError: failure,
      };

  await writeEvent({
    workspaceId,
    session,
    eventType: success ? "api_request_succeeded" : "api_request_failed",
    nodeId: node.id,
    data: {
      request: {
        method,
        url: parsedUrl ? summarizeUrl(parsedUrl) : null,
        headers: redactHeaders(resolvedHeaders),
        timeoutMs: timeout,
      },
      response: {
        status,
        body: summarizeBody(response?.data),
      },
      error: failure,
    },
  });

  return { success, context, status, error: failure };
}

module.exports = {
  executeApiRequestNode,
};
