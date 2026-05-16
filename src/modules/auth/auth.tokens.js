const jwt = require("jsonwebtoken");
const { jwtSecret, jwtExpiresIn, adminSessionExpiresIn } = require("@core/config/env");

function signToken({ user, workspaceId }) {
  return jwt.sign({ role: user.role, workspaceId: String(workspaceId), tokenVersion: Number(user.tokenVersion || 0) }, jwtSecret, {
    subject: String(user._id),
    expiresIn: jwtExpiresIn,
  });
}

function signAdminToken(adminId) {
  return jwt.sign({ role: "admin", workspaceId: "admin" }, jwtSecret, {
    subject: String(adminId),
    expiresIn: adminSessionExpiresIn,
  });
}

function signLoginChallengeToken(userId) {
  return jwt.sign({ role: "user", purpose: "login_2fa" }, jwtSecret, {
    subject: String(userId),
    expiresIn: "15m",
  });
}

function signRegisterChallengeToken(userId) {
  return jwt.sign({ role: "user", purpose: "register_verify" }, jwtSecret, {
    subject: String(userId),
    expiresIn: "15m",
  });
}

function verifyLoginChallengeToken(token) {
  const payload = jwt.verify(token, jwtSecret);
  if (payload?.purpose !== "login_2fa") throw new Error("Invalid challenge token");
  return payload;
}

function verifyRegisterChallengeToken(token) {
  const payload = jwt.verify(token, jwtSecret);
  if (payload?.purpose !== "register_verify") throw new Error("Invalid challenge token");
  return payload;
}

module.exports = {
  signToken,
  signAdminToken,
  signLoginChallengeToken,
  signRegisterChallengeToken,
  verifyLoginChallengeToken,
  verifyRegisterChallengeToken,
};

