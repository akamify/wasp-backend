const names = ["CommerceSettings","CommerceCatalogConnection","CommerceProduct","CommerceGatewayConnection","CommerceOrder","CommerceCheckoutAttempt","CommerceInventoryReservation","CommercePayment","CommerceRefund","CommerceEvent","CommerceOutbox","CommerceSession"];
module.exports = Object.fromEntries(names.map((name) => [name, require(`@infra/database/${name}`)[name]]));

