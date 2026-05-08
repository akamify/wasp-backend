const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

function loadEnv() {
  const root = process.cwd();
  const envLocalPath = path.join(root, ".env.local");
  const envPath = path.join(root, ".env");

  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath });
  }
  dotenv.config({ path: envPath });
}

module.exports = { loadEnv };

