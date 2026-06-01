const { WorkspaceActivityLog } = require("@infra/database/WorkspaceActivityLog");

async function logWorkspaceActivity({ workspaceId, actorUserId = null, action, entityType, entityId = null, metadata = {} }) {
  if (!workspaceId || !action || !entityType) return null;
  return WorkspaceActivityLog.create({ workspaceId, actorUserId, action, entityType, entityId, metadata }).catch(() => null);
}

module.exports = { logWorkspaceActivity };
