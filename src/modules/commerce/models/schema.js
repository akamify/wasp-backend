const mongoose = require("mongoose");
const { MAX_MONEY } = require("../domain/money");
const options = { timestamps: true, autoIndex: false, autoCreate: false, strict: "throw" };
const ref = (name, required = true) => ({ type: mongoose.Schema.Types.ObjectId, ref: name, required, immutable: true });
const amount = (value = 0) => ({ type: Number, min: 0, max: MAX_MONEY, validate: Number.isSafeInteger, default: value });
const count = (value = 0) => ({ type: Number, min: 0, max: 1_000_000_000, validate: Number.isSafeInteger, default: value });
const secret = () => ({ type: String, select: false, default: "" });
function define(name, fields, indexes = []) {
  const schema = new mongoose.Schema({ workspaceId: ref("Workspace"), ...fields }, options);
  // Explicitly selected credentials must still never appear in JSON responses.
  // Internal services can read document properties; API services must use DTOs.
  schema.set("toJSON", {
    transform(_document, result) {
      schema.eachPath((path, definition) => {
        if (definition.options.select === false) delete result[path];
      });
      return result;
    },
  });
  for (const [keys, opts] of indexes) schema.index(keys, opts || {});
  return mongoose.models[name] || mongoose.model(name, schema);
}
module.exports = { mongoose, options, ref, amount, count, secret, define };
