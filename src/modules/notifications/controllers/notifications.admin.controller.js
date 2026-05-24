const notificationsService = require("@modules/notifications/services/notifications.admin.service");

async function adminListNotifications(req, res) {
  res.json(await notificationsService.listNotifications(req));
}

module.exports = { adminListNotifications };

