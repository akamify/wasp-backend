const Joi = require("joi");

const rechargeOrderSchema = Joi.object({
  amount: Joi.number().positive().max(1000000).required(),
});

module.exports = { rechargeOrderSchema };

