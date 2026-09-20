// Read-only configuration preflight. Never loads .env, connects to a service or prints values.
const CORE_FLAGS = ["COMMERCE_CATALOG_ENABLED", "COMMERCE_ORDERS_ENABLED", "COMMERCE_GATEWAY_ENABLED", "COMMERCE_PAYMENTS_ENABLED"];
const OPTIONAL_FLAGS = ["COMMERCE_CHECKOUT_ENABLED", "COMMERCE_LIVE_CHECKOUT_ENABLED", "COMMERCE_RAZORPAY_OAUTH_ENABLED", "COMMERCE_NATIVE_PAYMENTS_ENABLED"];
const REQUIRED = ["MONGODB_URI", "REDIS_URL", "JWT_SECRET", "CREDENTIALS_ENCRYPTION_KEY", "FRONTEND_BASE_URL", "META_WEBHOOK_VERIFY_TOKEN"];
function inspect(env) {
  const checks = [], add = (name, pass, message) => checks.push({ name, pass: Boolean(pass), message });
  const url = (value, protocols) => { try { const parsed = new URL(value); return protocols.includes(parsed.protocol) && !!parsed.hostname; } catch { return false; } };
  const https = (value) => { try { const parsed = new URL(value); return parsed.protocol === "https:" && !!parsed.hostname && !parsed.username && !parsed.password && !parsed.search && !parsed.hash; } catch { return false; } };
  // Use the application's driver parser: standard URL rejects valid replica-set seed lists.
  const mongo = (value) => { try { const { MongoClient } = require("mongoose").mongo; new MongoClient(value); return true; } catch { return false; } };
  add("NODE_ENV", env.NODE_ENV === "production", "Use production mode on the host.");
  add("MONGODB_URI", mongo(env.MONGODB_URI), "Configure the intended MongoDB URI; replica-set topology and indexes need the separate connected index check.");
  add("REDIS_URL", url(env.REDIS_URL, ["redis:", "rediss:"]) && String(env.DISABLE_REDIS).toLowerCase() !== "true", "Commerce workers require enabled Redis.");
  add("JWT_SECRET", typeof env.JWT_SECRET === "string" && env.JWT_SECRET.length >= 32 && env.JWT_SECRET !== "dev_jwt_secret_change_me", "Use the host's strong JWT signing secret.");
  add("CREDENTIALS_ENCRYPTION_KEY", typeof env.CREDENTIALS_ENCRYPTION_KEY === "string" && /^[A-Za-z0-9+/]{43}=$/.test(env.CREDENTIALS_ENCRYPTION_KEY)
    && Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, "base64").length === 32, "Provide the existing 32-byte base64 encryption key consistently to API and worker; never replace it casually.");
  add("LOOKUP_SECRET", Boolean(env.LOOKUP_SECRET || env.CREDENTIALS_LOOKUP_SECRET), "Provide the existing credential lookup secret to API and worker.");
  add("META_APP", Boolean(env.META_APP_ID || env.APP_ID) && Boolean(env.META_APP_SECRET || env.APP_SECRET) && Boolean(env.META_WEBHOOK_VERIFY_TOKEN), "Configure Meta application and webhook signature/verification settings.");
  add("FRONTEND_BASE_URL", https(env.FRONTEND_BASE_URL), "Use the intended HTTPS frontend URL.");
  add("META_GRAPH_VERSION", /^v\d+\.\d+$/.test(env.META_GRAPH_VERSION || ""), "Explicitly pin the Graph version accepted by your Meta app and merchant pilot.");
  for (const name of CORE_FLAGS) add(name, env[name] === "true", "Enable this capability for the complete Commerce flow on the selected host.");
  for (const name of OPTIONAL_FLAGS) add(name, env[name] === undefined || ["true", "false"].includes(env[name]), "Use literal true or false; unset defaults to disabled.");
  if (env.COMMERCE_LIVE_CHECKOUT_ENABLED === "true") add("LIVE_CHECKOUT_DEPENDENCY", env.COMMERCE_CHECKOUT_ENABLED === "true", "Live checkout requires the new-checkout switch.");
  if (env.COMMERCE_NATIVE_PAYMENTS_ENABLED === "true") {
    add("NATIVE_LIVE_DEPENDENCY", env.COMMERCE_LIVE_CHECKOUT_ENABLED === "true" && env.COMMERCE_CHECKOUT_ENABLED === "true", "Native checkout requires live checkout switches.");
    const bindings = String(env.COMMERCE_NATIVE_ACCEPTED_BINDINGS || "").split(",").map((s) => s.trim());
    add("COMMERCE_NATIVE_ACCEPTED_BINDINGS", bindings.length > 0 && bindings.every((s) => /^[a-f0-9]{24}:\d{1,30}:\d{1,30}:[a-f0-9]{24}$/.test(s)), "Supply exact workspace:WABA:phone:gateway bindings accepted for the pilot.");
  }
  if (env.COMMERCE_RAZORPAY_OAUTH_ENABLED === "true") {
    let configured = 0;
    for (const mode of ["TEST", "LIVE"]) {
      const prefix = `COMMERCE_RAZORPAY_OAUTH_${mode}_`, names = ["CLIENT_ID", "CLIENT_SECRET", "REDIRECT_URI", "WEBHOOK_SECRET"];
      if (!names.some((key) => env[prefix + key])) continue;
      configured++;
      const redirect = env[prefix + "REDIRECT_URI"];
      add(prefix + "CONFIGURATION", Boolean(env[prefix + "CLIENT_ID"]) && Boolean(env[prefix + "CLIENT_SECRET"])
        && https(redirect) && /^\/(api\/)?commerce\/gateways\/oauth\/callback$/.test(new URL(redirect).pathname)
        && (env[prefix + "WEBHOOK_SECRET"] || "").length >= 16, "Complete all OAuth settings for this enabled environment.");
    }
    add("OAUTH_ENVIRONMENTS", configured > 0, "Configure at least one supported OAuth environment or leave OAuth disabled.");
  }
  return { result: checks.every((c) => c.pass) ? "PASS" : "FAIL", scope: "configuration-only", checks,
    checkoutEnabled: env.COMMERCE_CHECKOUT_ENABLED === "true", liveCheckoutEnabled: env.COMMERCE_LIVE_CHECKOUT_ENABLED === "true",
    externalVerification: "Not performed: database/indexes, Redis, workers, Meta/Razorpay, browser, TLS routing and deployment." };
}
function main(args = process.argv.slice(2), env = process.env) {
  if (args.length > 1 || (args.length && !["--plan", "--check"].includes(args[0]))) throw new Error("Use --plan or --check.");
  if (args[0] !== "--check") return { mode: "plan", required: [...REQUIRED, "META_APP_ID or APP_ID", "META_APP_SECRET or APP_SECRET", "LOOKUP_SECRET or CREDENTIALS_LOOKUP_SECRET", "META_GRAPH_VERSION", ...CORE_FLAGS],
    optional: OPTIONAL_FLAGS, services: ["API: node index.js", "Worker: node worker.js", "MongoDB replica set", "Redis", "HTTPS frontend and API"],
    next: "Run --check under the explicitly configured host environment, then the separate Commerce index --check. This command performs no deployment." };
  return inspect(env);
}
if (require.main === module) {
  try { const result = main(); console.log(JSON.stringify(result, null, 2)); if (result.result === "FAIL") process.exitCode = 1; }
  catch { console.error("Commerce hosting preflight failed. Use --plan or --check; no configuration values are printed."); process.exitCode = 1; }
}
module.exports = { inspect, main };
