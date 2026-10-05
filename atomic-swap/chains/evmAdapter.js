// atomic-swap/chains/evmAdapter.js
// Suporta ETH, BSC, Polygon, Avalanche, Arbitrum, Optimism, Base
const BaseAdapter = require('./baseAdapter');

const EVM_CHAINS = {
    ethereum: { name: 'Ethereum', symbol: 'ETH', chainId: 1, confirmations: 12, blockTime: 12, rpc: 'https://eth.llamarpc.com' },
    bsc: { name: 'BNB Smart Chain', symbol: 'BNB', chainId: 56, confirmations: 15, blockTime: 3, rpc: 'https://bsc-dataseed.binance.org' },
    polygon: { name: 'Polygon', symbol: 'POL', chainId: 137, confirmations: 30, blockTime: 2, rpc: 'https://polygon-rpc.com' },
    avalanche: { name: 'Avalanche', symbol: 'AVAX', chainId: 43114, confirmations: 12, blockTime: 2, rpc: 'https://api.avax.network/ext/bc/C/rpc' },
    arbitrum: { name: 'Arbitrum One', symbol: 'ETH', chainId: 42161, confirmations: 20, blockTime: 0.25, rpc: 'https://arb1.arbitrum.io/rpc' },
    optimism: { name: 'Optimism', symbol: 'ETH', chainId: 10, confirmations: 20, blockTime: 2, rpc: 'https://mainnet.optimism.io' },
    base: { name: 'Base', symbol: 'ETH', chainId: 8453, confirmations: 20, blockTime: 2, rpc: 'https://mainnet.base.org' }
};

class EvmAdapter extends BaseAdapter {
    constructor(chainKey) {
        const cfg = EVM_CHAINS[chainKey];
        if (!cfg) throw new Error(`EVM chain ${chainKey} não suportada`);

        super({
            name: cfg.name,
            symbol: cfg.symbol,
            chainId: cfg.chainId,
            confirmations: cfg.confirmations,
            blockTime: cfg.blockTime,
            enabled: true
        });

        this.chainKey = chainKey;
        this.cfg = cfg;
        this.rpc = cfg.rpc;
        this.htlcContractAddress = process.env[`HTLC_CONTRACT_${chainKey.toUpperCase()}`] || null;
    }

    // ⚠️  Precisa do contrato evmHTLC.sol deployado + ethers.js configurado
    async lockHtlc({ sender, receiver, amount, hashlock, timelock }) {
        if (!this.htlcContractAddress) {
            throw new Error(`${this.name}: contrato HTLC não deployado`);
        }
        // TODO: ethers.Contract(addr, ABI).lock(receiver, hashlock, timelock, { value: amount })
        throw new Error(`${this.name}: lockHtlc precisa de provider/signer configurado`);
    }

    async claimHtlc({ htlcId, preimage }) {
        throw new Error(`${this.name}: claimHtlc não implementado`);
    }

    async refundHtlc({ htlcId }) {
        throw new Error(`${this.name}: refundHtlc não implementado`);
    }

    async getHtlcStatus(htlcId) {
        throw new Error(`${this.name}: getHtlcStatus não implementado`);
    }

    async getBalance(address) {
        return { address, balance: 0, symbol: this.symbol };
    }

    async waitForConfirmations(txHash, required = this.confirmations) {
        throw new Error(`${this.name}: waitForConfirmations não implementado`);
    }

    isValidAddress(address) {
        return /^0x[a-fA-F0-9]{40}$/.test(address);
    }
}

module.exports = EvmAdapter;
module.exports.EVM_CHAINS = EVM_CHAINS;
