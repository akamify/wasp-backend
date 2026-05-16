const Joi = require("joi");

const createWorkspaceSchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
});

module.exports = {
  createWorkspaceSchema,
};

