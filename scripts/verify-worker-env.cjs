require("module-alias/register");
require("../src/core/config/loadEnv").loadEnv();

const required = ["MONGODB_URI"];
const optional = ["REDIS_URL", "JWT_SECRET", "SMTP_HOST", "SMTP_USER"];

function mask(value) {
  const v = String(value || "");
  if (!v) return "";
  if (v.length <= 6) return "***";
  return `${v.slice(0, 3)}***${v.slice(-3)}`;
}

function printKey(name, requiredFlag) {
  const value = process.env[name];
  const ok = Boolean(String(value || "").trim());
  const label = requiredFlag ? "required" : "optional";
  const state = ok ? "OK" : "MISSING";
  // eslint-disable-next-line no-console
  console.log(`[${state}] ${name} (${label}) ${ok ? `= ${mask(value)}` : ""}`);
  return ok;
}

function main() {
  // eslint-disable-next-line no-console
  console.log("Worker env verification");
  const requiredOk = required.every((name) => printKey(name, true));
  optional.forEach((name) => printKey(name, false));
  if (!requiredOk) {
    // eslint-disable-next-line no-console
    console.error("Worker env check failed. Set missing required variables in backend/.env.local or backend/.env.");
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log("Worker env check passed.");
}

main();
