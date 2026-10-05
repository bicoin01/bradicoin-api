// atomic-swap/chains/bradicoinAdapter.js
const BaseAdapter = require('./baseAdapter');
const htlc = require('../engine/htlc');

class BradicoinAdapter extends BaseAdapter {
    constructor() {
        super({
            name: 'Bradicoin',
            symbol: 'BRD',
            chainId: 'bradicoin-mainnet-1',
            confirmations: 1,
            blockTime: 30,
            enabled: true
        });
    }

    async lockHtlc({ sender, receiver, amount, hashlock, timelock, swapId }) {
        const result = await htlc.lock({
            sender, receiver, amount, hashlock, timelock, swapId
        });
        return {
            htlcId: result.htlcId,
            txHash: result.txHashLock,
            hashlock: result.hashlock,
            timelock: result.timelock
        };
    }

    async claimHtlc({ htlcId, preimage, claimer }) {
        return htlc.claim({ htlcId, preimage, claimer });
    }

    async refundHtlc({ htlcId, refunder }) {
        return htlc.refund({ htlcId, refunder });
    }

    async getHtlcStatus(htlcId) {
        return htlc.getHtlc(htlcId);
    }

    async getBalance(address) {
        const wallet = require('../../wallet');
        return wallet.getBalance(address);
    }

    async waitForConfirmations() {
        return { confirmed: true, confirmations: 1 };
    }

    isValidAddress(address) {
        const wallet = require('../../wallet');
        return wallet.isValidAddress(address);
    }
}

module.exports = BradicoinAdapter;
