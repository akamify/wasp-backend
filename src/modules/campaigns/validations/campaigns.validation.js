const Joi = require("joi");

const recipientSchema = Joi.alternatives().try(
    Joi.string().min(8).max(30),
    Joi.object({
        to: Joi.string().min(8).max(30).required(),
        variables: Joi.array().items(Joi.string().allow("")).max(20).optional(),
        headerVariables: Joi.array().items(Joi.string().allow("")).max(10).optional(),
        otpCode: Joi.string().allow("").max(20).optional(),
        buttonValues: Joi.array().items(Joi.string().allow("")).max(10).optional(),
        buttonTtlMinutes: Joi.array().items(Joi.number().min(0).max(43200)).max(10).optional(),
        flowTokens: Joi.array().items(Joi.string().allow("")).max(10).optional(),
        flowActionData: Joi.array().max(10).optional(),
    })
);

const estimateSchema = Joi.object({
    templateId: Joi.string().required(),
    recipients: Joi.array().items(recipientSchema).min(1).max(50000).required(),
});

const createSchema = Joi.object({
    name: Joi.string().trim().min(2).max(140).required(),
    type: Joi.string().valid("broadcast", "csv", "api").optional(),
    templateId: Joi.string().required(),
    recipients: Joi.array().items(recipientSchema).max(50000).optional(),
    scheduledAt: Joi.date().iso().optional(),
});

const actionSchema = Joi.object({
    action: Joi.string().valid("pause", "resume", "stop", "complete").required(),
});

module.exports = { recipientSchema, estimateSchema, createSchema, actionSchema };
