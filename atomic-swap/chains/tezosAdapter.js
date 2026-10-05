// atomic-swap/chains/tezosAdapter.js
const BaseAdapter = require('./baseAdapter');

class TezosAdapter extends BaseAdapter {
    constructor() {
        super({
            name: 'Tezos', symbol: 'XTZ',
            confirmations: 2, blockTime: 30, enabled: true
        });
        this.contractAddress = process.env.TEZOS_HTLC_CONTRACT || null;
    }

    // ⚠️  Precisa do contrato Michelson deployado + @taquito/taquito
    async lockHtlc() { throw new Error('Tezos: precisa de @taquito + contrato Michelson'); }
    async claimHtlc() { throw new Error('Tezos: não implementado'); }
    async refundHtlc() { throw new Error('Tezos: não implementado'); }
    async getBalance(address) { return { address, balance: 0, symbol: 'XTZ' }; }
    isValidAddress(address) { return /^(tz[1-3]|KT1)[a-zA-Z0-9]{33}$/.test(address); }
}

module.exports = TezosAdapter;
