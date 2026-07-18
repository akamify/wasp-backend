const { HttpError } = require("@shared/utils/httpError");
const RUPEE_SYMBOL = "\u20b9";

function isAllowedHost(hostname, allowedHosts) {
  const host = String(hostname || "").toLowerCase();
  return allowedHosts.some((allowed) => {
    const base = String(allowed || "").toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  });
}

function parseHttpsPublicUrl(raw, def) {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "Enter a valid HTTPS URL");
  }

  const hostname = String(parsed.hostname || "").toLowerCase();
  if (parsed.protocol !== "https:") {
    throw new HttpError(400, "URL must start with https://");
  }
  if (!hostname || !hostname.includes(".")) {
    throw new HttpError(400, "URL must use a valid public domain");
  }
  if (!/[a-z]{2,}$/i.test(hostname.split(".").pop() || "")) {
    throw new HttpError(400, "URL must use a valid domain extension");
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)
  ) {
    throw new HttpError(400, "URL must use a public domain");
  }
  if (Array.isArray(def?.allowedHosts) && def.allowedHosts.length && !isAllowedHost(hostname, def.allowedHosts)) {
    throw new HttpError(400, `URL must use ${def.allowedHosts.join(" or ")}`);
  }

  parsed.hash = "";
  return parsed.toString();
}

function parseCurrencySymbol(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return RUPEE_SYMBOL;
  if (value.length > 8) {
    throw new HttpError(400, "Currency symbol must be 8 characters or fewer");
  }
  if (/[<>]/.test(value)) {
    throw new HttpError(400, "Currency symbol contains unsupported characters");
  }
  return value;
}

function parseSettingValue(raw, def) {
  const valueType = String(def?.valueType || "string");
  if (valueType === "string" || valueType === "secret") {
    if (def?.format === "social_url") return parseHttpsPublicUrl(raw, def);
    if (def?.format === "currency_symbol") return parseCurrencySymbol(raw);
    return String(raw ?? "").trim();
  }
  if (valueType === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new HttpError(400, "Invalid number value");
    if (typeof def?.min === "number" && n < def.min) throw new HttpError(400, `Value must be >= ${def.min}`);
    if (typeof def?.max === "number" && n > def.max) throw new HttpError(400, `Value must be <= ${def.max}`);
    return n;
  }
  if (valueType === "boolean") {
    if (typeof raw === "boolean") return raw;
    const v = String(raw ?? "").trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
    throw new HttpError(400, "Invalid boolean value");
  }
  if (valueType === "json") return raw ?? {};
  return raw;
}

module.exports = { parseSettingValue };
