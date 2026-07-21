const mongoose = require("mongoose");

const ContactListSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    wabaId: { type: String, trim: true, required: true, index: true },
    name: { type: String, trim: true, required: true, maxlength: 120 },
    description: { type: String, trim: true, default: "", maxlength: 500 },
    kind: {
      type: String,
      enum: ["static"],
      default: "static",
      index: true,
    },
    contactIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Contact" }],
      default: [],
    },
    totalContacts: { type: Number, default: 0, min: 0 },
    lastResolvedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

ContactListSchema.index({ workspaceId: 1, wabaId: 1, createdAt: -1 });
ContactListSchema.index({ workspaceId: 1, wabaId: 1, name: 1 }, { unique: true });

const ContactList = mongoose.model("ContactList", ContactListSchema);

module.exports = { ContactList };
