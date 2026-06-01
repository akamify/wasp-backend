require("module-alias/register");

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Workspace } = require("@infra/database/Workspace");
const { WorkspaceMember } = require("@infra/database/WorkspaceMember");
const { WorkspaceUsageMonthly } = require("@infra/database/WorkspaceUsageMonthly");
const { WorkspaceActivityLog } = require("@infra/database/WorkspaceActivityLog");
const { Subscription } = require("@infra/database/Subscription");
const { Plan } = require("@infra/database/Plan");
const { Wallet } = require("@infra/database/Wallet");
const { WORKSPACE_PERMISSIONS } = require("@modules/workspaces/constants/workspacePermissions");

function hasIndex(model, expectedFields) {
  return model.schema.indexes().some(([fields]) => JSON.stringify(fields) === JSON.stringify(expectedFields));
}

for (const field of ["ownerUserId", "name", "slug", "businessName", "status", "deletedAt", "defaultCurrency", "timezone", "industry"]) {
  assert(Workspace.schema.path(field), `Workspace field missing: ${field}`);
}
for (const field of ["workspaceId", "userId", "role", "status", "permissionsOverride", "invitedBy", "joinedAt"]) {
  assert(WorkspaceMember.schema.path(field), `WorkspaceMember field missing: ${field}`);
}
for (const key of ["workspace.view", "billing.view", "whatsapp.connect", "templates.view", "inbox.reply", "contacts.delete", "campaigns.send", "settings.update"]) {
  assert(WORKSPACE_PERMISSIONS.includes(key), `Workspace permission missing: ${key}`);
}
assert(hasIndex(WorkspaceMember, { workspaceId: 1, userId: 1 }));
assert(hasIndex(WorkspaceUsageMonthly, { workspaceId: 1, period: 1 }));
assert(hasIndex(WorkspaceActivityLog, { workspaceId: 1, createdAt: -1 }));
assert(Subscription.schema.path("billingProvider"));
assert(Subscription.schema.path("providerSubscriptionId"));
assert(Plan.schema.path("entitlements"));
assert(Wallet.schema.path("lastRechargeAt"));

const root = path.resolve(__dirname, "..");
const routes = fs.readFileSync(path.join(root, "src/modules/workspaces/workspaces.routes.js"), "utf8");
const requireWorkspace = fs.readFileSync(path.join(root, "src/core/middleware/requireWorkspace.js"), "utf8");
assert(routes.includes('"/:workspaceId/overview"'));
assert(routes.includes('"/:workspaceId/billing/current"'));
assert(routes.includes('"/:workspaceId/wallet"'));
assert(requireWorkspace.includes("resolveWorkspaceAccess"));

console.log("WORKSPACE_FOUNDATION_OK");
