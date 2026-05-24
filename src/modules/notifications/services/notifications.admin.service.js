const { notificationsRepository } = require("@modules/notifications/repositories/index");
const { notificationsValidation } = require("@modules/notifications/validations/index");
const { listResponse } = require("@modules/notifications/utils/listResponse");
const { mapAdminNotificationItem } = require("@modules/notifications/dto/notifications.admin.dto");

async function listNotifications(req) {
  const { page, limit, skip, rx } = notificationsValidation.parseListQuery(req);
  const filter = rx ? { $or: [{ eventName: rx }, { phone: rx }, { status: rx }] } : {};

  const { total, events } = await notificationsRepository.listEvents({ filter, skip, limit });
  const { workspaceById, ownerById } = await notificationsRepository.loadWorkspaceOwnersForEvents(events);

  return listResponse({
    items: events.map((e) => mapAdminNotificationItem(e, workspaceById.get(String(e.workspaceId)), ownerById)),
    total,
    page,
    limit,
  });
}

module.exports = { listNotifications };

