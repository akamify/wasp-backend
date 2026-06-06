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
    type: Joi.string().valid("once", "daily", "weekly").optional(),
    status: Joi.string().valid("active", "paused", "completed", "failed").optional(),
    timezone: Joi.string().trim().max(80).default("Asia/Kolkata"),
    runAt: Joi.date().iso().optional(),
    timeOfDay: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
    weekdays: Joi.array().items(Joi.number().integer().min(1).max(7)).max(7).optional(),
    frequency: Joi.string().valid("once", "daily", "weekly").optional(),
    startAt: Joi.date().iso().optional(),
    endAt: Joi.date().iso().optional(),
    maxOccurrences: Joi.number().integer().min(1).max(365).optional(),
})
    .custom((value, helpers) => {
        if (!value.type) return value;
        if (value.type === "once") {
            if (!value.runAt) return helpers.error("any.custom", { message: "schedule.runAt is required" });
            if (new Date(value.runAt).getTime() <= Date.now()) {
                return helpers.error("any.custom", { message: "schedule.runAt must be in the future" });
            }
            if (value.timeOfDay !== undefined || value.weekdays !== undefined) {
                return helpers.error("any.custom", { message: "Once schedule only accepts runAt" });
            }
        }
        if (value.type === "daily") {
            if (!value.timeOfDay) return helpers.error("any.custom", { message: "schedule.timeOfDay is required" });
            if (value.runAt !== undefined || value.weekdays !== undefined) {
                return helpers.error("any.custom", { message: "Daily schedule only accepts timeOfDay" });
            }
        }
        if (value.type === "weekly") {
            if (!value.timeOfDay) return helpers.error("any.custom", { message: "schedule.timeOfDay is required" });
            if (!Array.isArray(value.weekdays) || !value.weekdays.length) {
                return helpers.error("any.custom", { message: "Select at least one weekday" });
            }
            if (value.runAt !== undefined) {
                return helpers.error("any.custom", { message: "Weekly schedule does not accept runAt" });
            }
        }
        return value;
    }, "campaign schedule validation")
    .messages({ "any.custom": "{{#message}}" })
    .optional();

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
