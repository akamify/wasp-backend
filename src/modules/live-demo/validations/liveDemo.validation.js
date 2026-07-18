const Joi = require("joi");

const createLiveDemoSchema = Joi.object({
  name: Joi.string().trim().min(2).max(160).required(),
  email: Joi.string().trim().email().max(220).required(),
  phone: Joi.string().trim().min(7).max(32).required(),
  platform: Joi.string().valid("Google Meet", "Zoom").required(),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  slot: Joi.string().trim().required(),
  notes: Joi.string().trim().min(20).max(2000).required(),
});

const updateLiveDemoStatusSchema = Joi.object({
  status: Joi.string().valid("Confirmed", "Completed", "Cancelled").required(),
});

module.exports = {
  createLiveDemoSchema,
  updateLiveDemoStatusSchema,
};
