const { AuditLog } = require("@infra/database/AuditLog");

function readIp(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const realIp = String(req?.headers?.["x-real-ip"] || "").trim();
  return forwarded || realIp || String(req?.ip || "").trim();
}

function readLocation(req) {
  const city = String(req?.headers?.["x-vercel-ip-city"] || "").trim();
  const region = String(req?.headers?.["x-vercel-ip-country-region"] || "").trim();
  const country = String(req?.headers?.["x-vercel-ip-country"] || "").trim();
  const parts = [city, region, country].filter(Boolean);
  if (parts.length) return parts.join(", ");
  const ip = readIp(req);
  if (ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1") return "Localhost";
  return "";
}

async function writeAuditLog(req, payload) {
  try {
    await AuditLog.create({
      actorId: req?.user?.id || undefined,
      ip: readIp(req),
      location: readLocation(req),
      userAgent: String(req?.headers?.["user-agent"] || "").trim(),
      ...payload,
    });
  } catch {
    // Never break primary flow for audit failures.
  }
}

module.exports = { writeAuditLog };
