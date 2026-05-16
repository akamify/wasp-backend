const { Message } = require("@infra/database/Message");

function aggregateMessages(pipeline) {
    return Message.aggregate(pipeline);
}

function distinctPhones(filter) {
    return Message.distinct("phone", filter);
}

function deleteMessages(filter) {
    return Message.deleteMany(filter);
}

function createMessage(data) {
    return Message.create(data);
}

module.exports = { aggregateMessages, distinctPhones, deleteMessages, createMessage };
