const { Stock, Outlet } = require("./models");
const { CommerceProduct: Product } = require("../models");
const { transaction } = require("../repositories/orders.repository");
const { fail } = require("./domain");
const opts = (session) => ({ session, new: true, runValidators: true });
async function migrate(ws, productId, outletId, revision) {
  return transaction(async (session) => {
    const p = await Product.findOne({ workspaceId: ws, _id: productId }).session(session).lean();
    if (!p || p.revision !== revision || p.inventoryOutletId) fail("Product changed or was already migrated.");
    if (!p.trackInventory) fail("Enable tracked inventory before moving this product to branches.");
    if (!await Outlet.exists({ workspaceId: ws, _id: outletId, active: true }).session(session)) fail("Branch not found.", 404);
    await Stock.create([{ workspaceId: ws, outletId, productId, stockOnHand: p.stockOnHand, stockReserved: p.stockReserved, available: p.available }], { session });
    const saved = await Product.findOneAndUpdate({ workspaceId: ws, _id: productId, revision, inventoryOutletId: null }, { $set: { inventoryOutletId: outletId, syncStatus: "pending", syncNextAttemptAt: new Date(), syncError: "" }, $inc: { revision: 1 } }, opts(session));
    if (!saved) fail("Product changed during migration.");
    return { migrated: true }; // Legacy reservations resolve against this explicit original outlet.
  });
}
async function adjust(ws, outletId, productId, input) {
  return transaction(async (session) => {
    const p = await Product.findOne({ workspaceId: ws, _id: productId }).session(session).lean();
    if (!p?.inventoryOutletId) fail("Explicitly migrate this product to an initial branch first.");
    if (!await Outlet.exists({ workspaceId: ws, _id: outletId }).session(session)) fail("Branch not found.", 404);
    const current = await Stock.findOne({ workspaceId: ws, outletId, productId }).session(session).lean();
    if ((current?.revision || 0) !== input.revision || input.stockOnHand < (current?.stockReserved || 0)) fail("Stock changed or is below its reserved quantity.");
    if (current) await Stock.updateOne({ _id: current._id, revision: current.revision }, { $set: { stockOnHand: input.stockOnHand, available: input.available }, $inc: { revision: 1 } }, { session });
    else await Stock.create([{ workspaceId: ws, outletId, productId, stockOnHand: input.stockOnHand, available: input.available }], { session });
    const delta = input.stockOnHand - (current?.stockOnHand || 0);
    if (!await Product.findOneAndUpdate({ _id: productId, workspaceId: ws, revision: p.revision }, { $inc: { stockOnHand: delta, revision: 1 }, $set: { syncStatus: "pending", syncNextAttemptAt: new Date(), syncError: "" } }, opts(session))) fail("Product changed.");
    return { updated: true };
  });
}
async function change(ws, product, item, operation, session) {
  if (!product.inventoryOutletId) return true;
  const outletId = item.outletId || product.inventoryOutletId;
  const filter = { workspaceId: ws, productId: product._id, outletId };
  if (operation === "reserve" || operation === "allocate") Object.assign(filter, { available: true, $expr: { $gte: [{ $subtract: ["$stockOnHand", "$stockReserved"] }, item.quantity] } });
  else Object.assign(filter, { stockReserved: { $gte: item.quantity }, ...(operation === "consume" ? { stockOnHand: { $gte: item.quantity } } : {}) });
  const inc = operation === "reserve" ? { stockReserved: item.quantity } : operation === "allocate" ? { stockOnHand: -item.quantity } : { stockReserved: -item.quantity, ...(operation === "consume" ? { stockOnHand: -item.quantity } : {}) };
  if (!await Stock.findOneAndUpdate(filter, { $inc: { ...inc, revision: 1 } }, opts(session))) fail("Branch inventory is unavailable or changed.");
  return true;
}
module.exports = { migrate, adjust, change };
