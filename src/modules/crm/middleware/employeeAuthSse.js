const jwt = require("jsonwebtoken");
const { jwtSecret } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { Employee } = require("@infra/database/Employee");

// SSE clients (EventSource) cannot set custom Authorization headers reliably.
// This middleware accepts token via query param `?token=` (or Authorization header as fallback)
// and applies the same validation as employeeAuth.
async function employeeAuthSse(req, res, next) {
  const header = String(req.headers.authorization || "");
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const queryToken = String(req.query?.token || "").trim();
  const token = bearer || queryToken;
  if (!token) return next(new HttpError(401, "Missing or invalid Authorization token"));

  try {
    const payload = jwt.verify(token, jwtSecret);
    if (String(payload?.typ || "") !== "crm_employee") return next(new HttpError(401, "Invalid or expired token"));
    if (!payload?.sub || !payload?.workspaceId) return next(new HttpError(401, "Invalid or expired token"));

    const employeeId = String(payload.sub);
    const workspaceId = String(payload.workspaceId);
    const sessionVersion = Number(payload.sessionVersion || 0);

    const employee = await Employee.findOne({ _id: employeeId, workspaceId }).select(
      "_id workspaceId email name role status permissions sessionVersion deletedAt"
    );
    if (!employee) return next(new HttpError(401, "Invalid or expired token"));
    if (employee.deletedAt) return next(new HttpError(403, "Employee account is inactive"));
    const status = String(employee.status || "ACTIVE").toUpperCase();
    if (status === "DELETED" || status === "DISABLED") return next(new HttpError(403, "Employee account is inactive"));
    if (status === "BLOCKED") return next(new HttpError(403, "Employee account is blocked"));
    if (Number(employee.sessionVersion || 0) !== sessionVersion) {
      return next(new HttpError(401, "Session expired. Please login again."));
    }

    req.employee = {
      id: String(employee._id),
      workspaceId: String(employee.workspaceId),
      sessionVersion,
      permissions: employee.permissions || {},
      role: employee.role || "employee",
      name: employee.name || "",
      email: employee.email,
    };
    req.employeeDoc = employee;
    return next();
  } catch {
    return next(new HttpError(401, "Invalid or expired token"));
  }
}

module.exports = { employeeAuthSse };

