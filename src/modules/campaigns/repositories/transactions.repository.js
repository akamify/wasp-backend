const { Transaction } = require("@infra/database/Transaction");

function aggregateTransactions(pipeline) {
    return Transaction.aggregate(pipeline);
}

module.exports = { aggregateTransactions };
