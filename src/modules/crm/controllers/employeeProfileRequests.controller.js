const Joi = require("joi");
const bcrypt = require("bcryptjs");
const { HttpError } = require("@shared/utils/httpError");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { sendEmail } = require("@shared/services/emailService");
const { sha256Hex } = require("@shared/utils/hash");
const { Workspace } = require("@infra/database/Workspace");
const { User } = require("@infra/database/User");
const { Employee } = require("@infra/database/Employee");
const { AuditLog } = require("@infra/database/AuditLog");
const employeeAuthService = require("@modules/crm/services/employeeAuth.service");

async function requireActiveCrmWorkspaceForOwner({ workspaceId, ownerId }) {
  const workspace = await Workspace.findOne({ _id: workspaceId, ownerId, isActive: true }).select("_id ownerId name crmEnabled");
  if (!workspace) throw new HttpError(404, "Workspace not found");
  if (!workspace.crmEnabled) throw new HttpError(403, "CRM is disabled for this workspace");
  return workspace;
}

async function requireActiveCrmWorkspaceForEmployee({ workspaceId, employeeId }) {
  const workspace = await Workspace.findOne({ _id: workspaceId, isActive: true }).select("_id ownerId name crmEnabled");
  if (!workspace) throw new HttpError(404, "Workspace not found");
  if (!workspace.crmEnabled) throw new HttpError(403, "CRM is disabled for this workspace");
  const employee = await Employee.findOne({ _id: employeeId, workspaceId }).select("_id email name status deletedAt");
  if (!employee) throw new HttpError(404, "Employee not found");
  return { workspace, employee };
}

const submitSchema = Joi.object({
  requestType: Joi.string().valid("change_name", "change_email", "password_reset").required(),
  requestedName: Joi.string().max(120).allow("").optional(),
  requestedEmail: Joi.string().email().optional(),
  reason: Joi.string().max(500).allow("").optional(),
});

async function submitEmployeeRequest(req, res) {
  const payload = await submitSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const { workspace, employee } = await requireActiveCrmWorkspaceForEmployee({
    workspaceId: req.workspace.id,
    employeeId: req.employee.id,
  });

  const owner = await User.findById(workspace.ownerId).select("email name");
  if (!owner) throw new HttpError(404, "Workspace owner not found");

  const meta = {
    status: "pending",
    workspaceId: String(workspace._id),
    employeeId: String(employee._id),
    employeeEmail: employee.email,
    employeeName: employee.name || "",
    requestType: payload.requestType,
    requestedName: payload.requestedName || "",
    requestedEmail: payload.requestedEmail ? String(payload.requestedEmail).trim().toLowerCase() : "",
    reason: payload.reason || "",
  };

  const log = await AuditLog.create({
    actorId: undefined,
    action: "crm.employee.request.submitted",
    resourceType: "crm_employee_request",
    resourceId: "",
    metadata: meta,
  });

  // Email both employee and owner.
  const subject = "CRM employee profile change request";
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
      <h3 style="margin:0 0 12px">Employee Request Submitted</h3>
      <p><b>Workspace:</b> ${String(workspace.name || "")}</p>
      <p><b>Employee:</b> ${employee.email}</p>
      <p><b>Type:</b> ${payload.requestType}</p>
      <p><b>Requested Name:</b> ${meta.requestedName || "-"}</p>
      <p><b>Requested Email:</b> ${meta.requestedEmail || "-"}</p>
      <p><b>Reason:</b> ${meta.reason || "-"}</p>
      <p style="font-size:12px;color:#64748b">Request ID: ${String(log._id)}</p>
    </div>
  `;
  const text = `Employee request submitted.\nWorkspace: ${workspace.name}\nEmployee: ${employee.email}\nType: ${payload.requestType}\nRequested Name: ${
    meta.requestedName || "-"
  }\nRequested Email: ${meta.requestedEmail || "-"}\nReason: ${meta.reason || "-"}\nRequest ID: ${String(log._id)}\n`;

  await Promise.allSettled([
    sendEmail({ toEmail: owner.email, toName: owner.name || "", subject, htmlContent: html, textContent: text }),
    sendEmail({ toEmail: employee.email, toName: employee.name || "", subject, htmlContent: html, textContent: text }),
  ]);

  await writeAuditLog(req, {
    action: "crm.employee.request.submit",
    resourceType: "crm_employee",
    resourceId: String(employee._id),
    metadata: { requestId: String(log._id), requestType: payload.requestType },
  });

  res.json({ success: true, request: { id: String(log._id), ...meta, createdAt: log.createdAt } });
}

async function listEmployeeRequests(req, res) {
  const { workspace, employee } = await requireActiveCrmWorkspaceForEmployee({
    workspaceId: req.workspace.id,
    employeeId: req.employee.id,
  });
  const items = await AuditLog.find({
    action: "crm.employee.request.submitted",
    "metadata.workspaceId": String(workspace._id),
    "metadata.employeeId": String(employee._id),
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  res.json({
    success: true,
    items: (items || []).map((x) => ({
      id: String(x._id),
      createdAt: x.createdAt,
      metadata: x.metadata || {},
    })),
  });
}

async function listOwnerRequests(req, res) {
  const workspace = await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const status = String(req.query?.status || "").trim().toLowerCase();
  const employeeId = String(req.query?.employeeId || "").trim();

  const q = {
    action: "crm.employee.request.submitted",
    "metadata.workspaceId": String(workspace._id),
  };
  if (employeeId) q["metadata.employeeId"] = employeeId;
  if (status) q["metadata.status"] = status;

  const items = await AuditLog.find(q).sort({ createdAt: -1 }).limit(300).lean();
  res.json({
    success: true,
    items: (items || []).map((x) => ({
      id: String(x._id),
      createdAt: x.createdAt,
      metadata: x.metadata || {},
    })),
  });
}

const decideSchema = Joi.object({
  decision: Joi.string().valid("approved", "rejected").required(),
  reviewNote: Joi.string().max(500).allow("").optional(),
  // Optional: for password resets, owner can directly set a password (no OTP).
  newPassword: Joi.string().min(8).max(200).optional(),
});

async function decideOwnerRequest(req, res) {
  const payload = await decideSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const workspace = await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const requestId = String(req.params.requestId || "").trim();

  const request = await AuditLog.findById(requestId);
  if (!request || String(request.action || "") !== "crm.employee.request.submitted") throw new HttpError(404, "Request not found");
  const meta = request.metadata && typeof request.metadata === "object" ? request.metadata : {};
  if (String(meta.workspaceId || "") !== String(workspace._id)) throw new HttpError(403, "Request does not belong to this workspace");
  if (String(meta.status || "") !== "pending") throw new HttpError(400, "Request already processed");

  const employeeId = String(meta.employeeId || "");
  const employee = await Employee.findOne({ _id: employeeId, workspaceId: workspace._id }).select(
    "_id email name status deletedAt sessionVersion +passwordHash +profileOtpCodeHash +profileOtpCodeExpiresAt +profileOtpPurpose +pendingEmail"
  );
  if (!employee) throw new HttpError(404, "Employee not found");

  meta.status = payload.decision;
  meta.reviewNote = payload.reviewNote || "";
  meta.decidedAt = new Date().toISOString();
  meta.decidedBy = String(req.user.id);

  // Apply changes on approve
  const requestType = String(meta.requestType || "");
  if (payload.decision === "approved") {
    if (requestType === "change_name") {
      employee.name = String(meta.requestedName || "").trim();
      await employee.save();
      meta.applied = true;
    } else if (requestType === "password_reset") {
      if (payload.newPassword) {
        employee.passwordHash = await bcrypt.hash(String(payload.newPassword), 12);
        employee.sessionVersion = Number(employee.sessionVersion || 0) + 1;
        await employee.save();
        meta.applied = true;
        meta.mode = "direct_password_set";
      } else {
        await employeeAuthService.forgotEmployeePassword({ workspaceId: String(workspace._id), email: employee.email });
        meta.applied = true;
        meta.mode = "reset_link_sent";
      }
    } else if (requestType === "change_email") {
      // Owner OTP required: store pending email + send OTP to OWNER email
      const pendingEmail = String(meta.requestedEmail || "").trim().toLowerCase();
      if (!pendingEmail) throw new HttpError(400, "Requested email missing");
      employee.pendingEmail = pendingEmail;
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      employee.profileOtpCodeHash = sha256Hex(otp);
      employee.profileOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
      employee.profileOtpPurpose = "change_email";
      await employee.save();

      await sendEmail({
        toEmail: req.user.email,
        toName: req.user.name || "",
        subject: "Confirm employee email change (OTP)",
        htmlContent: `<p>OTP: <b>${otp}</b> (valid for 10 minutes)</p><p>Employee: ${employee.email}</p><p>New email: ${pendingEmail}</p>`,
        textContent: `OTP: ${otp} (valid for 10 minutes)\nEmployee: ${employee.email}\nNew email: ${pendingEmail}\n`,
      }).catch(() => {});

      meta.applied = false;
      meta.mode = "otp_required";
    }
  }

  request.metadata = meta;
  await request.save();

  const owner = await User.findById(workspace.ownerId).select("email name");
  const subject = `CRM employee request ${payload.decision}`;
  const html = `<p>Employee request has been <b>${payload.decision}</b>.</p><p>${meta.reviewNote || ""}</p><p>Type: ${requestType}</p><p>Employee: ${String(
    meta.employeeEmail || ""
  )}</p><p>Request ID: ${String(request._id)}</p>`;
  const text = `Employee request ${payload.decision}. Type: ${requestType}. Employee: ${String(meta.employeeEmail || "")}. Request ID: ${String(request._id)}.`;

  await Promise.allSettled([
    owner
      ? sendEmail({ toEmail: owner.email, toName: owner.name || "", subject, htmlContent: html, textContent: text })
      : Promise.resolve(),
    sendEmail({ toEmail: employee.email, toName: employee.name || "", subject, htmlContent: html, textContent: text }),
  ]);

  await writeAuditLog(req, {
    action: "crm.employee.request.decide",
    resourceType: "crm_employee",
    resourceId: String(employee._id),
    metadata: { requestId: String(request._id), decision: payload.decision, requestType },
  });

  res.json({ success: true, request: { id: String(request._id), metadata: request.metadata } });
}

const verifyEmployeeEmailOtpSchema = Joi.object({ otp: Joi.string().pattern(/^\d{6}$/).required() });

async function verifyOwnerEmployeeEmailOtp(req, res) {
  const payload = await verifyEmployeeEmailOtpSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  await requireActiveCrmWorkspaceForOwner({ workspaceId: req.workspace.id, ownerId: req.user.id });
  const employeeId = String(req.params.employeeId || "").trim();

  const employee = await Employee.findOne({ _id: employeeId, workspaceId: req.workspace.id }).select(
    "_id email +profileOtpCodeHash +profileOtpCodeExpiresAt +profileOtpPurpose +pendingEmail status deletedAt"
  );
  if (!employee) throw new HttpError(404, "Employee not found");
  if (!employee.profileOtpCodeHash || !employee.profileOtpCodeExpiresAt || employee.profileOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired");
  }
  if (sha256Hex(String(payload.otp)) !== employee.profileOtpCodeHash) throw new HttpError(401, "Invalid OTP");
  if (String(employee.profileOtpPurpose || "") !== "change_email") throw new HttpError(400, "Invalid OTP purpose");
  if (!employee.pendingEmail) throw new HttpError(400, "No pending email change");

  const nextEmail = String(employee.pendingEmail).trim().toLowerCase();
  // Enforce unique per workspace + permanent delete rule
  const existing = await Employee.findOne({ workspaceId: req.workspace.id, email: nextEmail }).select("_id status deletedAt");
  if (existing) {
    const status = String(existing.status || "ACTIVE").toUpperCase();
    if (existing.deletedAt || status === "DELETED") {
      throw new HttpError(
        409,
        "This employee email was previously deleted (fired) and cannot be used again. Please use a different email."
      );
    }
    throw new HttpError(409, "An employee with this email already exists.");
  }

  employee.email = nextEmail;
  employee.pendingEmail = undefined;
  employee.profileOtpCodeHash = undefined;
  employee.profileOtpCodeExpiresAt = undefined;
  employee.profileOtpPurpose = undefined;
  await employee.save();

  res.json({ success: true, employee: { id: String(employee._id), email: employee.email } });
}

module.exports = {
  submitEmployeeRequest,
  listEmployeeRequests,
  listOwnerRequests,
  decideOwnerRequest,
  verifyOwnerEmployeeEmailOtp,
};

