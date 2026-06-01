require("module-alias/register");

const mongoose = require("mongoose");
require("../src/core/config/loadEnv");
const { connectDB } = require("../src/core/config/db");
const { Workspace } = require("@infra/database/Workspace");
const { WorkspaceMember } = require("@infra/database/WorkspaceMember");

const COLLECTIONS_REQUIRING_WORKSPACE = [
  "conversations",
  "messages",
  "contacts",
  "templates",
  "campaigns",
  "whatsappcredentials",
  "transactions",
  "subscriptions",
];

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function uniqueSlug(workspace) {
  const base = slugify(workspace.slug || workspace.name) || `workspace-${String(workspace._id).slice(-6)}`;
  let slug = base;
  for (let suffix = 1; await Workspace.exists({ slug, _id: { $ne: workspace._id } }); suffix += 1) {
    slug = `${base}-${suffix}`;
  }
  return slug;
}

async function run() {
  await connectDB(process.env.MONGODB_URI);
  const workspaces = await Workspace.find({});
  let workspaceUpdates = 0;
  let membershipUpdates = 0;

  for (const workspace of workspaces) {
    const ownerUserId = workspace.ownerUserId || workspace.ownerId;
    const patch = {
      ownerUserId,
      slug: await uniqueSlug(workspace),
      status: workspace.status || (workspace.isActive === false ? "suspended" : "active"),
      defaultCurrency: workspace.defaultCurrency || "INR",
      timezone: workspace.timezone || "Asia/Calcutta",
    };
    await Workspace.updateOne({ _id: workspace._id }, { $set: patch });
    workspaceUpdates += 1;
    if (ownerUserId) {
      await WorkspaceMember.updateOne(
        { workspaceId: workspace._id, userId: ownerUserId },
        {
          $setOnInsert: { joinedAt: workspace.createdAt || new Date() },
          $set: { role: "owner", status: "active" },
        },
        { upsert: true }
      );
      membershipUpdates += 1;
    }
  }

  const missingWorkspaceId = {};
  for (const name of COLLECTIONS_REQUIRING_WORKSPACE) {
    const collection = mongoose.connection.db.collection(name);
    missingWorkspaceId[name] = await collection.countDocuments({
      $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }],
    });
  }

  console.log("WORKSPACE_FOUNDATION_MIGRATION_COMPLETE", {
    workspaceUpdates,
    membershipUpdates,
    missingWorkspaceId,
    note: "Rows missing workspaceId are reported only. Review ownership before backfilling.",
  });
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("WORKSPACE_FOUNDATION_MIGRATION_FAILED", err);
  await mongoose.disconnect().catch(() => null);
  process.exitCode = 1;
});
