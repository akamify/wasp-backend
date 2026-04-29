const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../config/env");
const { HttpError } = require("../utils/httpError");

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return next(new HttpError(401, "Missing or invalid Authorization header"));
  }

  const token = header.slice("Bearer ".length).trim();
  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = { id: payload.sub, role: payload.role, workspaceId: payload.workspaceId };
    return next();
  } catch {
    return next(new HttpError(401, "Invalid or expired token"));
  }
}

module.exports = { auth };

