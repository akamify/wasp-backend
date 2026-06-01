const Joi = require("joi");

const createWorkspaceSchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  slug: Joi.string().trim().min(2).max(80).optional(),
  businessName: Joi.string().trim().max(120).allow("", null).optional(),
  defaultCurrency: Joi.string().trim().max(8).optional(),
  timezone: Joi.string().trim().max(80).optional(),
  industry: Joi.string().trim().max(80).allow("", null).optional(),
});

const updateWorkspaceSchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).optional(),
  businessName: Joi.string().trim().max(120).allow("", null).optional(),
  defaultCurrency: Joi.string().trim().max(8).optional(),
  timezone: Joi.string().trim().max(80).optional(),
  industry: Joi.string().trim().max(80).allow("", null).optional(),
  logoUrl: Joi.string().uri().allow("", null).optional(),
  avatarUrl: Joi.string().uri().allow("", null).optional(),
}).min(1);

const inviteMemberSchema = Joi.object({
  email: Joi.string().email().required(),
  role: Joi.string().valid("admin", "manager", "agent", "viewer").default("viewer"),
});

const updateMemberSchema = Joi.object({
  role: Joi.string().valid("admin", "manager", "agent", "viewer").optional(),
  status: Joi.string().valid("active", "invited", "removed").optional(),
  permissionsOverride: Joi.object().pattern(Joi.string(), Joi.boolean()).optional(),
}).min(1);

module.exports = {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  inviteMemberSchema,
  updateMemberSchema,
};

