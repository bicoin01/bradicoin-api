// atomic-swap/chains/solanaAdapter.js
const BaseAdapter = require('./baseAdapter');

class SolanaAdapter extends BaseAdapter {
    constructor() {
        super({
            name: 'Solana', symbol: 'SOL',
            confirmations: 32, blockTime: 0.4, enabled: true
        });
        this.programId = process.env.SOLANA_HTLC_PROGRAM_ID || null;
    }

    // ⚠️  Precisa do programa Anchor solanaHTLC.rs deployado
    async lockHtlc() { throw new Error('Solana: precisa do programa Anchor deployado'); }
    async claimHtlc() { throw new Error('Solana: não implementado'); }
    async refundHtlc() { throw new Error('Solana: não implementado'); }
    async getBalance(address) { return { address, balance: 0, symbol: 'SOL' }; }
    isValidAddress(address) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address); }
}

module.exports = SolanaAdapter;
