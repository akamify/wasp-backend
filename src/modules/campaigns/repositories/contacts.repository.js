const { Contact } = require("@infra/database/Contact");

function findContactsByPhones({ workspaceId, phones, select }) {
    return Contact.find({ workspaceId, phone: { $in: phones } }).select(select || undefined);
}

module.exports = { findContactsByPhones };
