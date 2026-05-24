const Joi = require("joi");

const updateSettingSchema = Joi.object({
  value: Joi.any().required(),
  confirmReplaceSecret: Joi.boolean().optional(),
});

const bulkUpdateSettingsSchema = Joi.object({
  updates: Joi.array()
    .items(
      Joi.object({
        key: Joi.string().trim().required(),
        value: Joi.any().required(),
        confirmReplaceSecret: Joi.boolean().optional(),
      })
    )
    .min(1)
    .required(),
});

const emailTestSchema = Joi.object({
  toEmail: Joi.string().email().required(),
});

module.exports = { updateSettingSchema, bulkUpdateSettingsSchema, emailTestSchema };

