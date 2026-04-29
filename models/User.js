const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    apiKeyHash: { type: String, required: true, select: false, index: true },
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);

module.exports = { User };

