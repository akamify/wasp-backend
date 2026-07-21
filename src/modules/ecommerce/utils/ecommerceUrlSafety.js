const dns = require("dns").promises;
const net = require("net");
const { HttpError } = require("@shared/utils/httpError");

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isUnsafeIp(address) {
  const value = String(address || "").trim().toLowerCase();
  const family = net.isIP(value);
  if (family === 4) return isPrivateIpv4(value);
  if (family === 6) {
    return (
      value === "::1" ||
      value === "::" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe80:") ||
      value.startsWith("::ffff:127.") ||
      value.startsWith("::ffff:10.") ||
      value.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

async function validatePublicStoreUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input || "").trim());
  } catch {
    throw new HttpError(400, "Invalid store URL");
  }

  if (parsed.protocol !== "https:") throw new HttpError(400, "Store URL must use HTTPS");
  if (parsed.username || parsed.password) throw new HttpError(400, "Store URL must not include credentials");

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new HttpError(400, "Store URL host is not allowed");
  }

  if (net.isIP(hostname)) {
    if (isUnsafeIp(hostname)) throw new HttpError(400, "Store URL host is not allowed");
  } else {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!records.length || records.some((record) => isUnsafeIp(record.address))) {
      throw new HttpError(400, "Store URL resolves to a private or unsafe network");
    }
  }

  return {
    storeUrl: `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, ""),
    storeDomain: hostname,
  };
}

module.exports = { validatePublicStoreUrl, isUnsafeIp };
