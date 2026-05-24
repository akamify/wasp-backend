const Joi = require("joi");

const updateAddonSchema = Joi.object({
  enabled: Joi.boolean().required(),
  confirmDisable: Joi.boolean().optional(),
});

const bulkUpdateAddonsSchema = Joi.object({
  updates: Joi.array()
    .items(
      Joi.object({
        key: Joi.string().trim().required(),
        enabled: Joi.boolean().required(),
        confirmDisable: Joi.boolean().optional(),
      })
    )
    .min(1)
    .required(),
});

module.exports = { updateAddonSchema, bulkUpdateAddonsSchema };

