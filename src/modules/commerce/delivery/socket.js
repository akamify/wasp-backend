// Sockets carry invalidation only. Authenticated API reads remain authoritative.
const { auth } = require("@core/middleware/auth");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const repo = require("./repository");
const { enabled } = require("./domain");
function attach(io) {
  const ns = io.of("/delivery");
  async function access(socket) {
    if (!enabled()) throw new Error("Delivery disabled");
    const token = socket.handshake.auth?.token;
    if (token && (typeof token !== "string" || token.length > 8192)) throw new Error("Invalid authentication");
    const req = { headers: { cookie: socket.request.headers.cookie, ...(token ? { authorization: `Bearer ${token}` } : {}) } };
    await new Promise((resolve, reject) => auth(req, {}, (error) => error ? reject(error) : resolve()));
    const rider = await repo.byUser(req.user.id);
    if (rider) {
      if (!rider.active || !await require("../repositories/orders.repository").workspaceActive(rider.workspaceId)) throw new Error("Rider inactive");
      return { workspaceId: rider.workspaceId, recipientId: req.user.id };
    }
    const ws = socket.handshake.auth?.workspaceId;
    if (typeof ws !== "string" || !/^[a-f0-9]{24}$/i.test(ws)) throw new Error("Invalid workspace");
    await requireWorkspacePermission(ws, "commerce.delivery.view", req.user.id);
    return { workspaceId: ws, recipientId: null };
  }
  ns.use((socket, next) => access(socket).then((scope) => { socket.data.deliveryScope = scope; next(); }).catch(() => next(new Error("Delivery access denied"))));
  ns.on("connection", (socket) => {
    const scope = socket.data.deliveryScope, room = `delivery:${scope.workspaceId}:${scope.recipientId || "merchant"}`;
    socket.join(room); let busy = false, previous = "";
    const poll = async () => {
      if (busy || !socket.connected) return; busy = true;
      try {
        const current = await access(socket);
        if (String(current.workspaceId) !== String(scope.workspaceId) || String(current.recipientId) !== String(scope.recipientId)) throw new Error("Scope changed");
        const latest = await repo.Notice.findOne(scope).sort({ _id: -1 }).select("_id").lean();
        const cursor = String(latest?._id || "");
        if (cursor !== previous) { previous = cursor; socket.emit("delivery.changed", { cursor }); }
      } catch { socket.disconnect(true); } finally { busy = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 3000); timer.unref(); socket.on("disconnect", () => clearInterval(timer));
  });
}
module.exports = { attach };
