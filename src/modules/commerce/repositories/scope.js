const mongoose = require("mongoose");

// Only pass workspaceId from verified workspace access or a trusted persisted
// connection. This query constraint does not replace membership authorization.
function byWorkspace(workspaceId, filter = {}) {
  if (!(workspaceId instanceof mongoose.Types.ObjectId)
      && (typeof workspaceId !== "string" || !/^[a-fA-F0-9]{24}$/.test(workspaceId))) {
    throw new TypeError("Commerce queries require a valid workspace ID");
  }
  if (!filter || Array.isArray(filter) || typeof filter !== "object"
      || ![Object.prototype, null].includes(Object.getPrototypeOf(filter))) {
    throw new TypeError("Commerce query filter must be an object");
  }
  // An AND constraint cannot be replaced by a filter's workspaceId or $or.
  return { $and: [{ workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) }, filter] };
}

module.exports = { byWorkspace };

