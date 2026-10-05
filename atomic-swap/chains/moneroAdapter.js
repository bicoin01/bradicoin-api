// atomic-swap/chains/moneroAdapter.js
// ⚠️  Monero NÃO tem HTLC nativo (sem Script)
// Usa adaptor signatures (Schnorr) — implementação complexa
const BaseAdapter = require('./baseAdapter');

class MoneroAdapter extends BaseAdapter {
    constructor() {
        super({
            name: 'Monero', symbol: 'XMR',
            confirmations: 10, blockTime: 120, enabled: true
        });
    }

    // ⚠️  Precisa de monero-javascript + implementação de adaptor sigs
    // Referência: "Atomic Swaps between Bitcoin and Monero" (COMIT)
    async lockHtlc() { throw new Error('Monero: requer adaptor signatures (sem script)'); }
    async claimHtlc() { throw new Error('Monero: não implementado'); }
    async refundHtlc() { throw new Error('Monero: não implementado'); }
    async getBalance(address) { return { address, balance: 0, symbol: 'XMR' }; }
    isValidAddress(address) { return /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(address); }
}

module.exports = MoneroAdapter;
