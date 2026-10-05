// atomic-swap/chains/bitcoinAdapter.js
// Suporta BTC, LTC, BCH, DOGE, DASH, ZEC (todos Bitcoin-like)
const BaseAdapter = require('./baseAdapter');
const axios = require('axios');

// Configurações por chain
const CHAIN_CONFIGS = {
    bitcoin: {
        name: 'Bitcoin', symbol: 'BTC',
        api: 'https://mempool.space/api',
        confirmations: 6, blockTime: 600,
        addressPrefix: 'bc1', utxo: true
    },
    litecoin: {
        name: 'Litecoin', symbol: 'LTC',
        api: 'https://litecoinspace.org/api',
        confirmations: 6, blockTime: 150,
        addressPrefix: 'ltc1', utxo: true
    },
    bitcoinCash: {
        name: 'Bitcoin Cash', symbol: 'BCH',
        api: 'https://bch-chain.api.btc.com',
        confirmations: 6, blockTime: 600,
        addressPrefix: 'bitcoincash:', utxo: true
    },
    dogecoin: {
        name: 'Dogecoin', symbol: 'DOGE',
        api: 'https://dogechain.info/api/v1',
        confirmations: 6, blockTime: 60,
        addressPrefix: 'D', utxo: true
    },
    dash: {
        name: 'Dash', symbol: 'DASH',
        api: 'https://api.blockcypher.com/v1/dash/main',
        confirmations: 6, blockTime: 150,
        addressPrefix: 'X', utxo: true
    },
    zcash: {
        name: 'Zcash', symbol: 'ZEC',
        api: 'https://api.blockchair.com/zcash',
        confirmations: 6, blockTime: 75,
        addressPrefix: 't1', utxo: true
    }
};

class BitcoinLikeAdapter extends BaseAdapter {
    constructor(chainKey) {
        const cfg = CHAIN_CONFIGS[chainKey];
        if (!cfg) throw new Error(`Chain ${chainKey} não suportada`);

        super({
            name: cfg.name,
            symbol: cfg.symbol,
            confirmations: cfg.confirmations,
            blockTime: cfg.blockTime,
            enabled: true
        });

        this.chainKey = chainKey;
        this.cfg = cfg;
        this.api = cfg.api;
    }

    // ⚠️  Implementação real precisa de bitcoinjs-lib + assinatura HD wallet
    // Aqui deixo o esqueleto pronto pra plugar.
    async lockHtlc({ sender, receiver, amount, hashlock, timelock }) {
        // TODO: construir script HTLC:
        //   OP_IF
        //     OP_SHA256 <hashlock> OP_EQUALVERIFY
        //     <receiverPubKey> OP_CHECKSIG
        //   OP_ELSE
        //     <timelock> OP_CHECKLOCKTIMEVERIFY OP_DROP
        //     <senderPubKey> OP_CHECKSIG
        //   OP_ENDIF
        throw new Error(`${this.name}: lockHtlc real precisa de wallet HD configurada`);
    }

    async claimHtlc({ htlcId, preimage }) {
        throw new Error(`${this.name}: claimHtlc real precisa de wallet HD configurada`);
    }

    async refundHtlc({ htlcId }) {
        throw new Error(`${this.name}: refundHtlc real precisa de wallet HD configurada`);
    }

    async getHtlcStatus(htlcId) {
        throw new Error(`${this.name}: getHtlcStatus não implementado`);
    }

    async getBalance(address) {
        try {
            if (this.chainKey === 'bitcoin') {
                const r = await axios.get(`${this.api}/address/${address}`);
                const sats = r.data.chain_stats.funded_txo_sum - r.data.chain_stats.spent_txo_sum;
                return { address, balance: sats / 1e8, symbol: 'BTC' };
            }
            // ... outras chains
            return { address, balance: 0, symbol: this.symbol };
        } catch (e) {
            console.error(`${this.name} getBalance:`, e.message);
            return { address, balance: 0, symbol: this.symbol };
        }
    }

    async waitForConfirmations(txHash, required = this.confirmations) {
        // Polling básico — em prod usar websocket/SSE
        const interval = this.blockTime * 1000;
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const maxAttempts = 200;
            const check = async () => {
                try {
                    attempts++;
                    const tx = await this._getTx(txHash);
                    if (tx.confirmations >= required) return resolve({ confirmed: true, confirmations: tx.confirmations });
                    if (attempts >= maxAttempts) return reject(new Error('Timeout aguardando confirmações'));
                    setTimeout(check, interval);
                } catch (e) {
                    if (attempts >= maxAttempts) return reject(e);
                    setTimeout(check, interval);
                }
            };
            check();
        });
    }

    async _getTx(txHash) {
        if (this.chainKey === 'bitcoin') {
            const r = await axios.get(`${this.api}/tx/${txHash}`);
            return {
                txid: r.data.txid,
                confirmations: r.data.status.confirmed ? (r.data.status.block_height ? 1 : 0) : 0
            };
        }
        throw new Error(`${this.name}: _getTx não implementado`);
    }

    isValidAddress(address) {
        if (!address || typeof address !== 'string') return false;
        // Validação básica por prefixo — em prod usar biblioteca
        return address.startsWith(this.cfg.addressPrefix);
    }
}

module.exports = BitcoinLikeAdapter;
module.exports.CHAIN_CONFIGS = CHAIN_CONFIGS;
