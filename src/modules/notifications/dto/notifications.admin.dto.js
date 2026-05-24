function mapAdminNotificationItem(eventDoc, workspace, ownerById) {
  const owner = workspace ? ownerById.get(String(workspace.ownerId)) : null;
  return {
    id: String(eventDoc._id),
    eventName: eventDoc.eventName,
    phone: eventDoc.phone,
    status: eventDoc.status,
    templateId: eventDoc.templateId ? String(eventDoc.templateId) : null,
    messageId: eventDoc.messageId ? String(eventDoc.messageId) : null,
    createdAt: eventDoc.createdAt,
    workspaceId: String(eventDoc.workspaceId),
    workspace: workspace
      ? {
          id: String(workspace._id),
          name: workspace.name,
          plan: workspace.plan,
          owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || "" } : null,
        }
      : null,
  };
}

module.exports = { mapAdminNotificationItem };

