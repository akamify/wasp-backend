require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Workspace } = require("@infra/database/Workspace");
const { WorkspaceMember } = require("@infra/database/WorkspaceMember");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");

test("existing authorization service enforces the new commerce permissions and membership boundaries", async (t) => {
  const workspace = { _id: "100000000000000000000001", ownerId: "owner-test", isActive: true, status: "active" };
  let membership = { role: "agent", permissionsOverride: {} };
  let exists = true;
  t.mock.method(Workspace, "findOne", async (query) => {
    assert.equal(query._id, workspace._id);
    assert.equal(query.isActive, true);
    assert.equal(query.status, "active");
    return exists ? workspace : null;
  });
  t.mock.method(WorkspaceMember, "findOne", async (query) => {
    assert.equal(String(query.workspaceId), workspace._id);
    assert.equal(query.userId, "staff-test");
    assert.equal(query.status, "active");
    return membership;
  });
  const check = (permission) => requireWorkspacePermission(workspace._id, permission, "staff-test");
  await assert.doesNotReject(check("commerce.messages.send"));
  await assert.rejects(check("commerce.gateway.manage"), (error) => error.statusCode === 403);
  membership = { role: "manager", permissionsOverride: {} };
  await assert.doesNotReject(check("commerce.orders.manage"));
  await assert.rejects(check("commerce.payments.manage"), (error) => error.statusCode === 403);
  membership = { role: "admin", permissionsOverride: {} };
  await assert.doesNotReject(check("commerce.gateway.manage"));
  membership = { role: "admin", permissionsOverride: { "commerce.gateway.manage": false } };
  await assert.rejects(check("commerce.gateway.manage"), (error) => error.statusCode === 403);
  membership = null;
  await assert.rejects(check("commerce.orders.view"), (error) => error.statusCode === 404);
  exists = false;
  await assert.rejects(check("commerce.orders.view"), (error) => error.statusCode === 404);
});

