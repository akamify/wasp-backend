const { HttpError } = require("@shared/utils/httpError");
const { Conversation } = require("@infra/database/Conversation");
const { windowState } = require("@modules/conversations/services/customerServiceWindow.service");
const { byWorkspace } = require("../repositories/scope");
async function assertCommerceMessageAllowed({ workspaceId, to, credentials, expected, now = new Date() }) {
  const block = () => { const error = new HttpError(409, "Commerce notification channel or customer service window is unavailable."); error.commerceBeforeDispatch = true; throw error; };
  if (credentials.wabaId !== expected.wabaId || credentials.phoneNumberId !== expected.phoneNumberId) block();
  const conversation = await Conversation.findOne(byWorkspace(workspaceId, { wabaId: expected.wabaId,
    phoneNumberId: expected.phoneNumberId, phone: to })).read("primary").select("customerServiceWindowExpiresAt lastCustomerMessageAt").lean();
  if (!windowState(conversation, now).canReply) block();
}
module.exports = { assertCommerceMessageAllowed };
