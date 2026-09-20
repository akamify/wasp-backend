// Only deployment-configured frontend origins can receive the browser callback.
function oauthReturnUrl(result, base = process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL) {
  try {
    const origin = new URL(base);
    if (origin.username || origin.password || (origin.protocol !== "https:"
        && !(process.env.NODE_ENV !== "production" && origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))) return null;
    const target = new URL("/app/commerce/settings", origin.origin);
    target.searchParams.set("oauth", result.cancelled ? "cancelled" : "connected");
    return target.href;
  } catch { return null; }
}
module.exports = { oauthReturnUrl };
