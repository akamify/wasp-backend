const mongoose = require("mongoose");
const { Event } = require("@infra/database/Event");
const { Workspace } = require("@infra/database/Workspace");
const { User } = require("@infra/database/User");

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

async function listEvents({ filter, skip, limit }) {
  const [total, events] = await Promise.all([
    Event.countDocuments(filter),
    Event.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("workspaceId eventName phone status error templateId messageId createdAt updatedAt"),
  ]);
  return { total, events };
}

async function loadWorkspaceOwnersForEvents(events) {
  const workspaceIds = Array.from(new Set(events.map((e) => String(e.workspaceId)).filter(isValidObjectId)));
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select("name ownerId plan");
  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  const workspaceById = new Map(workspaces.map((w) => [String(w._id), w]));
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));
  return { workspaceById, ownerById };
}

module.exports = { listEvents, loadWorkspaceOwnersForEvents };

