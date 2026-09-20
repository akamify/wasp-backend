const axios = require("axios");
const { HttpError } = require("@shared/utils/httpError");
const modes = Object.freeze({ car: "DRIVE", motorcycle: "TWO_WHEELER", bicycle: "BICYCLE" });
const validPoint = (p) => p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
const waypoint = (p) => ({ waypoint: { location: { latLng: { latitude: p.latitude, longitude: p.longitude } } } });
function decode(data, origins, destinations) {
  if (!Array.isArray(data) || data.length > origins * destinations) throw new Error("Invalid route matrix");
  const entries = new Map();
  for (const entry of data) {
    const i = entry.originIndex ?? 0, j = entry.destinationIndex ?? 0;
    if (!Number.isInteger(i) || i < 0 || i >= origins || !Number.isInteger(j) || j < 0 || j >= destinations || entries.has(`${i}:${j}`)) throw new Error("Invalid matrix index");
    const seconds = typeof entry.duration === "string" && /^\d+(\.\d+)?s$/.test(entry.duration) ? Number(entry.duration.slice(0, -1)) : NaN;
    const ok = entry.condition === "ROUTE_EXISTS" && (!entry.status?.code || entry.status.code === 0) && Number.isFinite(seconds) && seconds >= 0
      && Number.isSafeInteger(entry.distanceMeters) && entry.distanceMeters >= 0;
    entries.set(`${i}:${j}`, ok ? { seconds: Math.ceil(seconds), metres: entry.distanceMeters, fallback: Boolean(entry.fallbackInfo) } : null);
  }
  return entries; // Missing and per-element failed routes stay unavailable, never zero ETA.
}
function createGoogleRoutes({ request = (config) => axios.request(config), key = () => process.env.COMMERCE_GOOGLE_ROUTES_API_KEY } = {}) {
  return async function matrix(origins, destinations, vehicle) {
    if (!key()) throw new HttpError(503, "Google Routes is not configured. Manual dispatch remains available.");
    if (!modes[vehicle] || !origins.length || origins.length > 21 || !destinations.length || destinations.length > 2
        || !origins.every(validPoint) || !destinations.every(validPoint)) throw new HttpError(400, "Invalid route shortlist.");
    try {
      const response = await request({ method: "POST", url: "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key(), "X-Goog-FieldMask": "originIndex,destinationIndex,status,condition,distanceMeters,duration,fallbackInfo" },
        data: { origins: origins.map(waypoint), destinations: destinations.map(waypoint), travelMode: modes[vehicle],
          ...(vehicle === "bicycle" ? {} : { routingPreference: "TRAFFIC_AWARE" }), regionCode: "IN" },
        timeout: 8000, signal: AbortSignal.timeout(9000), maxRedirects: 0, maxContentLength: 262144, maxBodyLength: 32768 });
      return decode(response.data, origins.length, destinations.length);
    } catch { throw new HttpError(503, "Road ETA is unavailable. Retry later or use manual dispatch."); }
  };
}
module.exports = { createGoogleRoutes, matrix: createGoogleRoutes(), decode, validPoint };
