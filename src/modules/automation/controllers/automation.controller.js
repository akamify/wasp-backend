const { Template } = require("@infra/database/Template");
const { Event } = require("@infra/database/Event");
const { HttpError } = require("@shared/utils/httpError");
const { sendTemplateMessageForUser } = require("@shared/services/outboundMessageService");
const { assertNormalizedPhone } = require("@shared/services/contactService");
const { debit, credit, messageCostForTemplateCategory } = require("@modules/wallet/services/wallet.core.service");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");

async function triggerEvent(req, res) {
  const {
    eventName,
    phone,
    templateId,
    variables,
    headerVariables,
    otpCode,
    buttonValues,
    languageCode,
  } = req.body;
  const normalizedPhone = assertNormalizedPhone(phone);

  const template = await Template.findOne({ _id: templateId, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  if (template.status !== "approved") {
    throw new HttpError(400, "Template must be approved before sending");
  }

  await assertTemplateBelongsToCurrentWaba({ template, workspaceId: req.workspace.id });

  const event = await Event.create({
    workspaceId: req.workspace.id,
    eventName,
    phone: normalizedPhone,
    templateId,
    templatePayload: { variables, headerVariables, otpCode, buttonValues, languageCode },
    status: "triggered",
  });

  const chargeAmount = messageCostForTemplateCategory(template.category, 1);
  try {
    await debit(req.workspace.id, chargeAmount, "Message send (automation)", {
      templateId: String(template._id),
      to: normalizedPhone,
      eventName,
    });
    const { message, apiResponse } = await sendTemplateMessageForUser({
      userId: req.workspace.id,
      template,
      to: normalizedPhone,
      languageCode,
      variables,
      headerVariables,
      otpCode,
      buttonValues,
    });

    event.messageId = message._id;
    event.status = "sent";
    await event.save();

    res.json({ success: true, event, message, meta: apiResponse });
  } catch (err) {
    if (err.statusCode) throw err;

    if (err?.response) {
      try {
        await credit(req.workspace.id, chargeAmount, "Message refund (automation failed)", "internal", "", {
          templateId: String(template._id),
          to: normalizedPhone,
          eventName,
        });
      } catch {}
    }
    event.status = "failed";
    event.error = err.response?.data || { message: err.message };
    await event.save();

    throw new HttpError(502, "Failed to send automated message", err.response?.data || err.message);
  }
}

module.exports = { triggerEvent };


