const Joi = require("joi");

const rechargeOrderSchema = Joi.object({
  amount: Joi.number().positive().max(1000000).required(),
});

const rechargeVerifySchema = Joi.object({
  razorpay_order_id: Joi.string().trim().required(),
  razorpay_payment_id: Joi.string().trim().required(),
  razorpay_signature: Joi.string().trim().required(),
});

module.exports = { rechargeOrderSchema, rechargeVerifySchema };

