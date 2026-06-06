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

const variableMappingSchema = Joi.object({
    position: Joi.number().integer().min(1).max(20).required(),
    sourceType: Joi.string().valid("static", "contact_field", "contact_attribute").required(),
    sourceKey: Joi.string().trim().max(50).allow("").optional(),
    value: Joi.string().max(500).allow("").optional(),
    fallback: Joi.string().max(500).allow("").optional(),
});

const attributeFilterSchema = Joi.object({
    key: Joi.string().trim().max(50).required(),
    operator: Joi.string().valid("equals", "not_equals", "exists", "not_exists", "contains").required(),
    value: Joi.any().optional(),
});

const estimateSchema = Joi.object({
    templateId: Joi.string().required(),
    recipients: Joi.array().items(recipientSchema).min(1).max(50000).optional(),
    audience: Joi.object({
        mode: Joi.string().valid("manual", "tags", "attributes").default("manual"),
        tags: Joi.array().items(Joi.string().trim().max(40)).max(25).optional(),
        tagMatch: Joi.string().valid("all", "any").default("all"),
        attributeFilters: Joi.array().items(attributeFilterSchema).max(10).optional(),
        runtime: Joi.object({
            variables: Joi.array().items(Joi.string().allow("")).max(20).optional(),
            headerVariables: Joi.array().items(Joi.string().allow("")).max(10).optional(),
            otpCode: Joi.string().allow("").max(20).optional(),
            buttonValues: Joi.array().items(Joi.string().allow("")).max(10).optional(),
            buttonTtlMinutes: Joi.array().items(Joi.number().min(0).max(43200)).max(10).optional(),
            flowTokens: Joi.array().items(Joi.string().allow("")).max(10).optional(),
            flowActionData: Joi.array().max(10).optional(),
        }).optional(),
    }).optional(),
});

const scheduleSchema = Joi.object({
    frequency: Joi.string().valid("once", "daily", "weekly").default("once"),
    endAt: Joi.date().iso().optional(),
    maxOccurrences: Joi.number().integer().min(1).max(365).optional(),
}).optional();

const audienceSchema = Joi.object({
    mode: Joi.string().valid("manual", "tags", "attributes").default("manual"),
    tags: Joi.array().items(Joi.string().trim().max(40)).max(25).optional(),
    tagMatch: Joi.string().valid("all", "any").default("all"),
    attributeFilters: Joi.array().items(attributeFilterSchema).max(10).optional(),
    runtime: Joi.object({
        variables: Joi.array().items(Joi.string().allow("")).max(20).optional(),
        headerVariables: Joi.array().items(Joi.string().allow("")).max(10).optional(),
        otpCode: Joi.string().allow("").max(20).optional(),
        buttonValues: Joi.array().items(Joi.string().allow("")).max(10).optional(),
        buttonTtlMinutes: Joi.array().items(Joi.number().min(0).max(43200)).max(10).optional(),
        flowTokens: Joi.array().items(Joi.string().allow("")).max(10).optional(),
        flowActionData: Joi.array().max(10).optional(),
    }).optional(),
}).optional();

const createSchema = Joi.object({
    name: Joi.string().trim().min(2).max(140).required(),
    type: Joi.string().valid("broadcast", "csv", "api").optional(),
    templateId: Joi.string().required(),
    recipients: Joi.array().items(recipientSchema).max(50000).optional(),
    scheduledAt: Joi.date().iso().optional(),
    schedule: scheduleSchema,
    audience: audienceSchema,
    templateVariableMappings: Joi.array().items(variableMappingSchema).max(20).optional(),
    headerVariableMappings: Joi.array().items(variableMappingSchema).max(10).optional(),
    buttonVariableMappings: Joi.array().items(variableMappingSchema).max(10).optional(),
});

const actionSchema = Joi.object({
    action: Joi.string().valid("pause", "resume", "stop", "complete").required(),
});

module.exports = { recipientSchema, estimateSchema, createSchema, actionSchema, scheduleSchema, audienceSchema };
