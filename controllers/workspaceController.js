const { Workspace } = require("../models/Workspace");
const { HttpError } = require("../utils/httpError");

async function listWorkspaces(req, res) {
  const items = await Workspace.find({ ownerId: req.user.id, isActive: true })
    .sort({ createdAt: 1 })
    .select("_id name plan createdAt");
  res.json({
    success: true,
    workspaces: items.map((w) => ({
      id: String(w._id),
      name: w.name,
      plan: w.plan,
      createdAt: w.createdAt,
    })),
  });
}

async function createWorkspace(req, res) {
  const name = String(req.body?.name || "").trim();
  if (!name) throw new HttpError(400, "Workspace name is required");

  const workspace = await Workspace.create({ ownerId: req.user.id, name });
  res.status(201).json({
    success: true,
    workspace: { id: String(workspace._id), name: workspace.name, plan: workspace.plan },
  });
}

module.exports = { listWorkspaces, createWorkspace };

