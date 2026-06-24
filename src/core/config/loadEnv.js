const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

function loadEnv() {
  if (global.__WASPAKAMIFY_ENV_LOADED__) return;
  const root = path.resolve(__dirname, "../../..");
  const envLocalPath = path.join(root, ".env.local");
  const envPath = path.join(root, ".env");

  // Load base `.env` first, then allow `.env.local` to override it.
  // This matches common tooling expectations and avoids confusing "why didn't my .env change apply?" issues.
  dotenv.config({ path: envPath, quiet: true });
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true, quiet: true });
  }
  global.__WASPAKAMIFY_ENV_LOADED__ = true;
}

module.exports = { loadEnv };
