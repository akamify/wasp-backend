const mongoose = require("mongoose");

const AdminAccountSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, trim: true, default: "Demo Admin" },
    passwordHash: { type: String, required: true, select: false },
    // If an admin has set a password inside the app (or reset it), disable env-based login.
    envLoginDisabled: { type: Boolean, default: false },
    passwordResetTokenHash: { type: String, select: false },
    passwordResetTokenExpiresAt: { type: Date },
  },
  { timestamps: true }
);

const AdminAccount = mongoose.model("AdminAccount", AdminAccountSchema);

module.exports = { AdminAccount };
