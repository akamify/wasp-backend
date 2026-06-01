const { Contact } = require("@infra/database/Contact");

function findContactsByPhones({ workspaceId, wabaId, phones, select }) {
    return Contact.find({ workspaceId, wabaId, phone: { $in: phones } }).select(select || undefined);
}

module.exports = { findContactsByPhones };
