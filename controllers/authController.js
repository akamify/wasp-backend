const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { jwtSecret, jwtExpiresIn } = require("../config/env");
const { User } = require("../models/User");
const { Workspace } = require("../models/Workspace");
const { HttpError } = require("../utils/httpError");
const { sha256Hex } = require("../utils/hash");

function base64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function generateApiKey() {
  return base64Url(crypto.randomBytes(32));
}

function signToken({ user, workspaceId }) {
  return jwt.sign({ role: user.role, workspaceId: String(workspaceId) }, jwtSecret, {
    subject: String(user._id),
    expiresIn: jwtExpiresIn,
  });
}

async function ensureDefaultWorkspace(user) {
  let workspace = await Workspace.findOne({ ownerId: user._id, isActive: true })
    .sort({ createdAt: 1 })
    .select("_id name plan");

  if (!workspace) {
    workspace = await Workspace.create({
      ownerId: user._id,
      name: user.name ? `${String(user.name).trim()}'s workspace` : "My workspace",
    });
  }

  return workspace;
}

async function register(req, res) {
  const { email, password, name, phone } = req.body;

  const existing = await User.findOne({ email: String(email).toLowerCase() }).select("_id");
  if (existing) throw new HttpError(409, "Email already registered");

  const passwordHash = await bcrypt.hash(password, 12);
  const apiKey = generateApiKey();
  const apiKeyHash = sha256Hex(apiKey);

  const user = await User.create({ email, passwordHash, name, phone, apiKeyHash });
  const workspace = await Workspace.create({
    ownerId: user._id,
    name: name ? `${String(name).trim()}'s workspace` : "My workspace",
  });
  const token = signToken({ user, workspaceId: workspace._id });

  res.status(201).json({
    success: true,
    token,
    apiKey, // show once; store only the hash
    workspace: { id: workspace._id, name: workspace.name, plan: workspace.plan },
    user: { id: user._id, email: user.email, name: user.name, phone: user.phone, role: user.role },
  });
}

async function login(req, res) {
  const { email, password } = req.body;
  const user = await User.findOne({ email: String(email).toLowerCase() }).select(
    "+passwordHash role email name phone"
  );
  if (!user) throw new HttpError(401, "Invalid credentials");

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new HttpError(401, "Invalid credentials");

  const workspace = await ensureDefaultWorkspace(user);

  const token = signToken({ user, workspaceId: workspace._id });
  res.json({
    success: true,
    token,
    workspace: { id: workspace._id, name: workspace.name, plan: workspace.plan },
    user: { id: user._id, email: user.email, name: user.name, phone: user.phone, role: user.role },
  });
}

async function me(req, res) {
  const user = await User.findById(req.user.id).select("email name phone role createdAt");
  if (!user) throw new HttpError(404, "User not found");
  let workspace = await Workspace.findOne({
    _id: req.user.workspaceId,
    ownerId: req.user.id,
    isActive: true,
  }).select("_id name plan");
  if (!workspace) {
    workspace = await ensureDefaultWorkspace(user);
  }
  res.json({
    success: true,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      createdAt: user.createdAt,
    },
    workspace: workspace
      ? { id: String(workspace._id), name: workspace.name, plan: workspace.plan }
      : null,
  });
}

async function rotateApiKey(req, res) {
  const apiKey = generateApiKey();
  const apiKeyHash = sha256Hex(apiKey);

  await User.updateOne({ _id: req.user.id }, { $set: { apiKeyHash } });
  res.json({ success: true, apiKey });
}

async function updateProfile(req, res) {
  const { name, phone } = req.body;

  const update = {};
  if (name !== undefined) update.name = name;
  if (phone !== undefined) update.phone = phone;

  const user = await User.findByIdAndUpdate(req.user.id, { $set: update }, { new: true }).select(
    "email name phone role createdAt"
  );
  if (!user) throw new HttpError(404, "User not found");

  res.json({
    success: true,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      createdAt: user.createdAt,
    },
  });
}

module.exports = { register, login, me, rotateApiKey, updateProfile };
