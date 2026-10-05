// atomic-swap/index.js
const htlc = require('./engine/htlc');
const swapEngine = require('./engine/swapEngine');
const swapState = require('./engine/swapState');
const timelock = require('./security/timelock');
const secretManager = require('./security/secretManager');

const BradicoinAdapter = require('./chains/bradicoinAdapter');
const BitcoinLikeAdapter = require('./chains/bitcoinAdapter');
const EvmAdapter = require('./chains/evmAdapter');
const SolanaAdapter = require('./chains/solanaAdapter');
const TezosAdapter = require('./chains/tezosAdapter');
const MoneroAdapter = require('./chains/moneroAdapter');

const adapters = {
    bradicoin: new BradicoinAdapter(),
    bitcoin: new BitcoinLikeAdapter('bitcoin'),
    litecoin: new BitcoinLikeAdapter('litecoin'),
    bitcoinCash: new BitcoinLikeAdapter('bitcoinCash'),
    dogecoin: new BitcoinLikeAdapter('dogecoin'),
    dash: new BitcoinLikeAdapter('dash'),
    zcash: new BitcoinLikeAdapter('zcash'),
    ethereum: new EvmAdapter('ethereum'),
    bsc: new EvmAdapter('bsc'),
    polygon: new EvmAdapter('polygon'),
    avalanche: new EvmAdapter('avalanche'),
    arbitrum: new EvmAdapter('arbitrum'),
    optimism: new EvmAdapter('optimism'),
    base: new EvmAdapter('base'),
    solana: new SolanaAdapter(),
    tezos: new TezosAdapter(),
    monero: new MoneroAdapter()
};

function getAdapter(chain) {
    const a = adapters[chain];
    if (!a) throw new Error(`Chain ${chain} não suportada`);
    return a;
}

function listChains() {
    return Object.entries(adapters).map(([key, a]) => ({
        id: key,
        name: a.name,
        symbol: a.symbol,
        enabled: a.enabled,
        confirmations: a.confirmations,
        blockTime: a.blockTime
    }));
}

// Inicia o watchdog do engine
swapEngine.startWatchdog();

module.exports = {
    htlc,
    swapEngine,
    swapState,
    timelock,
    secretManager,
    adapters,
    getAdapter,
    listChains
};
