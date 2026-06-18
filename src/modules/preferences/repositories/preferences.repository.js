const {
  UserWorkspacePreference,
} = require("@infra/database/UserWorkspacePreference");

async function findPreference({ userId, workspaceId, scope }) {
  return UserWorkspacePreference.findOne({ userId, workspaceId, scope }).lean();
}

async function upsertPreference({ userId, workspaceId, scope, preferences }) {
  const updates = Object.fromEntries(
    Object.entries(preferences).map(([key, value]) => [
      `preferences.${key}`,
      value,
    ])
  );
  return UserWorkspacePreference.findOneAndUpdate(
    { userId, workspaceId, scope },
    {
      $set: updates,
      $setOnInsert: { userId, workspaceId, scope },
    },
    { returnDocument: "after", upsert: true, runValidators: true }
  ).lean();
}

module.exports = {
  findPreference,
  upsertPreference,
};
