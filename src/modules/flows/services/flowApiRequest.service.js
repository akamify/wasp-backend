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
const SENSITIVE_CONTEXT_KEY_PATTERN = /(token|secret|password|apikey|api_key|authorization)/i;
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
  const forbidden = Object.keys(headers).find((name) =>
    FORBIDDEN_HEADERS.has(String(name || "").trim().toLowerCase())
  );
  if (forbidden) {
    const error = new Error(`Header '${forbidden}' is not allowed`);
    error.code = "HEADER_NOT_ALLOWED";
    throw error;
  }
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [String(name || "").trim(), value])
      .filter(([name, value]) => name && value !== null && value !== undefined)
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

function normalizePathSegments(path) {
  return String(path || "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPath(source, path) {
  if (String(path || "").trim() === "$") return source;
  const keys = normalizePathSegments(path);
  if (keys.some((key) => UNSAFE_OBJECT_KEYS.has(key))) return undefined;
  return keys.reduce((value, key) => value?.[key], source);
}

function isValidContextKey(key) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(key || ""));
}

function isSensitiveContextKey(key) {
  return SENSITIVE_CONTEXT_KEY_PATTERN.test(String(key || ""));
}

function safeUrlValue(value, fallback) {
  const candidate = String(value || fallback || "").trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol)
      ? parsed.toString()
      : String(fallback || "");
  } catch {
    return String(fallback || "");
  }
}

function coerceMappedValue(value, type, fallback) {
  const effective = value === undefined || value === null || value === "" ? fallback : value;
  if (type === "number") {
    const number = Number(effective);
    return Number.isFinite(number) ? number : Number(fallback || 0);
  }
  if (type === "boolean") {
    if (typeof effective === "boolean") return effective;
    return ["true", "1", "yes"].includes(String(effective).toLowerCase());
  }
  if (type === "json") return effective ?? fallback ?? null;
  if (type === "url") return safeUrlValue(effective, fallback);
  return effective === undefined || effective === null ? "" : String(effective);
}

function normalizeMappingEntry(entry) {
  if (typeof entry === "string") {
    return { path: entry, type: "string", fallback: "" };
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return {
      path: String(entry.path || ""),
      type: ["string", "number", "boolean", "url", "json"].includes(entry.type)
        ? entry.type
        : "string",
      fallback: entry.fallback,
    };
  }
  return { path: "", type: "string", fallback: "" };
}

function applyResponseMapping(context, responseData, responseMapping, meta = {}) {
  const mapped = { ...(context || {}) };
  const mappedKeys = [];
  if (
    !responseMapping ||
    typeof responseMapping !== "object" ||
    Array.isArray(responseMapping)
  ) {
    return { context: mapped, mappedKeys };
  }
  for (const [contextKey, rawMapping] of Object.entries(responseMapping)) {
    const key = String(contextKey || "").trim();
    if (
      !isValidContextKey(key) ||
      UNSAFE_OBJECT_KEYS.has(key) ||
      isSensitiveContextKey(key)
    ) {
      continue;
    }
    const mapping = normalizeMappingEntry(rawMapping);
    const value = getPath(responseData, mapping.path);
    if (value === undefined) {
      process.stdout.write(
        `[FLOW_API_MAPPING_MISSING] ${JSON.stringify({
          sessionId: meta.sessionId || null,
          nodeId: meta.nodeId || null,
          contextKey: key,
          path: mapping.path,
        })}\n`
      );
    }
    mapped[key] = coerceMappedValue(value, mapping.type, mapping.fallback);
    mappedKeys.push(key);
  }
  return { context: mapped, mappedKeys };
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

function parseJsonBody(body) {
  if (body === undefined || body === null || body === "") return undefined;
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("API request body must be valid JSON");
    error.code = "INVALID_JSON_BODY";
    throw error;
  }
}

function byteLength(value) {
  if (value === undefined || value === null) return 0;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(serialized || "", "utf8");
}

function parseResponseData(response) {
  const contentType = String(response?.headers?.["content-type"] || "").toLowerCase();
  const data = response?.data;
  if (Buffer.isBuffer(data)) {
    const text = data.toString("utf8");
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        const error = new Error("API response returned invalid JSON");
        error.code = "INVALID_JSON_RESPONSE";
        throw error;
      }
    }
    return text;
  }
  return data;
}

function normalizeQueryParams(queryParams) {
  if (!queryParams || typeof queryParams !== "object" || Array.isArray(queryParams)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(queryParams)
      .map(([key, value]) => [String(key || "").trim(), value])
      .filter(([key, value]) => key && value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function appendQueryParams(parsedUrl, queryParams) {
  for (const [key, value] of Object.entries(queryParams)) {
    parsedUrl.searchParams.set(key, value);
  }
}

async function runApiRequest({
  workspaceId,
  session,
  node,
  scope,
  config,
}) {
  const method = String(config.method || "").trim().toUpperCase();
  const startedAt = Date.now();
  const timeout = normalizedTimeout(config.timeoutMs);
  let resolvedHeaders = {};
  let parsedUrl;
  let response = null;
  let failure = null;

  try {
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error("API request method is not allowed");
    }
    const resolvedUrl = resolveVariables(config.url, scope);
    const resolvedQueryParams = normalizeQueryParams(
      resolveVariables(config.queryParams || {}, scope)
    );
    resolvedHeaders = normalizeHeaders(
      resolveVariables(config.headers || {}, scope)
    );
    const resolvedBody = resolveVariables(config.body, scope);
    parsedUrl = parseSafeUrl(resolvedUrl);
    appendQueryParams(parsedUrl, resolvedQueryParams);
    let requestBody;
    const canSendBody = ["POST", "PUT", "PATCH"].includes(method);
    if (canSendBody) {
      requestBody = parseJsonBody(resolvedBody);
      if (byteLength(requestBody) > MAX_REQUEST_BYTES) {
        const error = new Error("API request body is too large");
        error.code = "REQUEST_BODY_TOO_LARGE";
        throw error;
      }
      const hasContentType = Object.keys(resolvedHeaders).some(
        (name) => String(name || "").toLowerCase() === "content-type"
      );
      if (requestBody !== undefined && !hasContentType) {
        resolvedHeaders["Content-Type"] = "application/json";
      }
    }
    process.stdout.write(
      `[FLOW_API_REQUEST_START] ${JSON.stringify({
        sessionId: session?._id ? String(session._id) : null,
        nodeId: node?.id || null,
        method,
        urlHost: parsedUrl.hostname,
        urlPath: parsedUrl.pathname,
        timeoutMs: timeout,
      })}\n`
    );
    response = await axios.request({
      method,
      url: parsedUrl.toString(),
      headers: resolvedHeaders,
      ...(canSendBody ? { data: requestBody } : {}),
      timeout,
      maxRedirects: 3,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_REQUEST_BYTES,
      responseType: "arraybuffer",
      validateStatus: () => true,
      proxy: false,
      httpAgent,
      httpsAgent,
    });
  } catch (error) {
    failure = serializeApiError(error);
  }

  const durationMs = Date.now() - startedAt;
  let responseData;
  if (response) {
    try {
      responseData = parseResponseData(response);
    } catch (error) {
      failure = serializeApiError(error);
    }
  }
  const success =
    Boolean(response) && !failure && response.status >= 200 && response.status < 300;
  const status = response?.status || null;
  if (!success && !failure) {
    failure = {
      code: "API_HTTP_ERROR",
      message: `API request returned HTTP ${status}`,
      status,
    };
  }
  const mappingResult = success
    ? applyResponseMapping(session?.context || {}, responseData, config.responseMapping, {
        nodeId: node?.id,
        sessionId: session?._id ? String(session._id) : null,
      })
    : { context: { ...(session?.context || {}), lastApiError: failure }, mappedKeys: [] };
  if (success) {
    process.stdout.write(
      `[FLOW_API_REQUEST_SUCCESS] ${JSON.stringify({
        sessionId: session?._id ? String(session._id) : null,
        nodeId: node?.id || null,
        status,
        durationMs,
        mappedKeys: mappingResult.mappedKeys,
      })}\n`
    );
    process.stdout.write(
      `[FLOW_API_MAPPING_APPLIED] ${JSON.stringify({
        sessionId: session?._id ? String(session._id) : null,
        nodeId: node?.id || null,
        mappedKeys: mappingResult.mappedKeys,
      })}\n`
    );
  } else {
    process.stdout.write(
      `[FLOW_API_REQUEST_FAILURE] ${JSON.stringify({
        sessionId: session?._id ? String(session._id) : null,
        nodeId: node?.id || null,
        status,
        durationMs,
        reason: failure?.message || "API request failed",
      })}\n`
    );
  }

  return {
    success,
    context: mappingResult.context,
    status,
    error: failure,
    durationMs,
    responseData,
    requestSummary: {
      method,
      url: parsedUrl ? summarizeUrl(parsedUrl) : null,
      headers: redactHeaders(resolvedHeaders),
      timeoutMs: timeout,
    },
  };
}

async function executeApiRequestNode({
  workspaceId,
  session,
  node,
  scope,
}) {
  const config = node.config || {};
  const result = await runApiRequest({ workspaceId, session, node, scope, config });

  await writeEvent({
    workspaceId,
    session,
    eventType: result.success ? "api_success" : "api_failed",
    nodeId: node.id,
    data: {
      request: result.requestSummary,
      response: {
        status: result.status,
        body: summarizeBody(result.responseData),
      },
      error: result.error,
      durationMs: result.durationMs,
    },
  });

  return {
    success: result.success,
    context: result.context,
    status: result.status,
    error: result.error,
  };
}

async function testApiRequestNode({ workspaceId, flowId, nodeId, config, sampleContext, sampleContact, sampleAttributes }) {
  const session = {
    _id: "test-api-request",
    workspaceId,
    flowId,
    context: sampleContext || {},
  };
  const contact = {
    _id: "sample-contact",
    phone: sampleContact?.phone || "",
    name: sampleContact?.name || "",
    email: sampleContact?.email || "",
    attributes: sampleAttributes || {},
  };
  const scope = {
    context: sampleContext || {},
    attributes: sampleAttributes || {},
    contact,
    workspace: { id: String(workspaceId), name: sampleContext?.workspaceName || "" },
    flow: { id: String(flowId || ""), name: "" },
    static: sampleContext?.static || {},
    __meta: { sessionId: "test-api-request", flowId, nodeId },
  };
  const result = await runApiRequest({
    workspaceId,
    session,
    node: { id: nodeId || "api_request_test" },
    scope,
    config: config || {},
  });
  if (!result.success) {
    return {
      ok: false,
      status: result.status,
      errorCode: result.error?.code || "API_REQUEST_FAILED",
      message: result.error?.message || "API request failed",
      durationMs: result.durationMs,
    };
  }
  return {
    ok: true,
    status: result.status,
    durationMs: result.durationMs,
    responsePreview: result.responseData,
    mappedContext: result.context,
  };
}

module.exports = {
  executeApiRequestNode,
  testApiRequestNode,
  applyResponseMapping,
  getPath,
};
