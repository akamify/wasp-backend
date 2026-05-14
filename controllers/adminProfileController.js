const Joi = require("joi");
const { AdminAccount } = require("../models/AdminAccount");
const { AdminLoginEvent } = require("../models/AdminLoginEvent");
const { HttpError } = require("../utils/httpError");

function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const limitRaw = Number(req.query.limit || 25) || 25;
  const limit = Math.min(Math.max(limitRaw, 5), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

async function adminGetProfile(req, res) {
  const adminAccount = await AdminAccount.findById(req.user.id).select("username displayName createdAt updatedAt");
  if (!adminAccount) throw new HttpError(404, "Admin account not found");
  res.json({
    success: true,
    profile: {
      id: String(adminAccount._id),
      email: adminAccount.username,
      displayName: adminAccount.displayName || "Admin",
      createdAt: adminAccount.createdAt,
      updatedAt: adminAccount.updatedAt,
    },
  });
}

const updateSchema = Joi.object({
  displayName: Joi.string().trim().min(2).max(80).required(),
});

async function adminUpdateProfile(req, res) {
  const payload = await updateSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const adminAccount = await AdminAccount.findById(req.user.id).select("username displayName updatedAt");
  if (!adminAccount) throw new HttpError(404, "Admin account not found");
  adminAccount.displayName = payload.displayName;
  await adminAccount.save();
  res.json({
    success: true,
    profile: {
      id: String(adminAccount._id),
      email: adminAccount.username,
      displayName: adminAccount.displayName || "Admin",
      updatedAt: adminAccount.updatedAt,
    },
  });
}

async function adminListLoginEvents(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const [total, items] = await Promise.all([
    AdminLoginEvent.countDocuments({ adminAccountId: req.user.id }),
    AdminLoginEvent.find({ adminAccountId: req.user.id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("ip userAgent method createdAt"),
  ]);

  res.json({
    success: true,
    items: items.map((e) => ({
      id: String(e._id),
      ip: e.ip || "",
      userAgent: e.userAgent || "",
      method: e.method || "password",
      createdAt: e.createdAt,
    })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
}

module.exports = { adminGetProfile, adminUpdateProfile, adminListLoginEvents };

