const jwt = require("jsonwebtoken");
const { jwtSecret } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { Employee } = require("@infra/database/Employee");

async function employeeAuth(req, res, next) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) {
    return next(new HttpError(401, "Missing or invalid Authorization header"));
  }

  const token = header.slice("Bearer ".length).trim();
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (String(payload?.typ || "") !== "crm_employee") {
      return next(new HttpError(401, "Invalid or expired token"));
    }
    if (!payload?.sub || !payload?.workspaceId) {
      return next(new HttpError(401, "Invalid or expired token"));
    }

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
      role: employee.role || "agent",
      name: employee.name || "",
      email: employee.email,
    };
    req.employeeDoc = employee;
    return next();
  } catch {
    return next(new HttpError(401, "Invalid or expired token"));
  }
}

module.exports = { employeeAuth };
