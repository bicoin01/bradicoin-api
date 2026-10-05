// atomic-swap/negotiation/index.js
const orderBook = require('./orderBook');
const matcher = require('./matcher');
const message = require('./orderMessage');

// SwapGossip é instanciado externamente (precisa do node P2P)
const SwapGossip = require('./swapGossip');

let gossipInstance = null;

function initGossip({ node, peerId, privateKey, publicKey }) {
    if (gossipInstance) return gossipInstance;

    gossipInstance = new SwapGossip({ node, peerId, privateKey, publicKey });
    gossipInstance.initialize();

    // Auto-adiciona ordens anunciadas ao order book
    gossipInstance.on('order:announced', (order) => {
        orderBook.addOrder(order);
    });

    // Auto-remove ordens canceladas
    gossipInstance.on('order:cancelled', ({ swapId }) => {
        orderBook.removeOrder(swapId);
    });

    return gossipInstance;
}

function getGossip() {
    if (!gossipInstance) {
        throw new Error('SwapGossip não inicializado. Chame initGossip() primeiro.');
    }
    return gossipInstance;
}

module.exports = {
    orderBook,
    matcher,
    message,
    SwapGossip,
    initGossip,
    getGossip
};
