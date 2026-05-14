const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

function loadEnv() {
  const root = process.cwd();
  const envLocalPath = path.join(root, ".env.local");
  const envPath = path.join(root, ".env");

  // Load base `.env` first, then allow `.env.local` to override it.
  // This matches common tooling expectations and avoids confusing "why didn't my .env change apply?" issues.
  dotenv.config({ path: envPath });
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true });
  }
}

module.exports = { loadEnv };
