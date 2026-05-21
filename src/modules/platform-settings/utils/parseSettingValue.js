const { HttpError } = require("@shared/utils/httpError");

function parseSettingValue(raw, def) {
  const valueType = String(def?.valueType || "string");
  if (valueType === "string" || valueType === "secret") {
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

