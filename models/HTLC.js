// models/HTLC.js
// ============================================
// HTLC — Hash Time-Locked Contract (Bradicoin)
// ============================================
// 🔐 Não-custodial: fundos só saem com preimage OU após timelock
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const htlcSchema = new mongoose.Schema(
    {
        htlcId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        chain: {
            type: String,
            required: true,
            enum: ['bradicoin', 'bitcoin', 'litecoin', 'bitcoinCash', 'dogecoin',
                   'dash', 'zcash', 'ethereum', 'bsc', 'polygon', 'avalanche',
                   'arbitrum', 'optimism', 'base', 'solana', 'tezos', 'monero'],
            index: true
        },

        // Quem trava os fundos
        sender: {
            type: String,
            required: true,
            index: true
        },

        // Quem pode resgatar com o preimage
        receiver: {
            type: String,
            required: true,
            index: true
        },

        // Valor travado
        amount: {
            type: Decimal128,
            required: true
        },

        // Token (BRD, BTC, ETH, ...)
        token: {
            type: String,
            required: true,
            default: 'BRD'
        },

        // H = sha256(S) — 32 bytes em hex
        hashlock: {
            type: String,
            required: true,
            validate: {
                validator: v => /^[a-fA-F0-9]{64}$/.test(v),
                message: 'hashlock deve ser sha256 em hex (64 chars)'
            },
            index: true
        },

        // Unix timestamp em segundos — depois disso, sender pode refundar
        timelock: {
            type: Number,
            required: true,
            index: true
        },

        // Estado
        status: {
            type: String,
            enum: ['locked', 'claimed', 'refunded', 'expired'],
            default: 'locked',
            index: true
        },

        // Preimage (revelado no claim)
        preimage: {
            type: String,
            default: null
        },

        // Tx hashes
        txHashLock: { type: String, default: null },
        txHashClaim: { type: String, default: null },
        txHashRefund: { type: String, default: null },

        // Vinculação com swap cross-chain
        swapId: {
            type: String,
            default: null,
            index: true
        },

        // Timestamps
        claimedAt: { type: Date, default: null },
        refundedAt: { type: Date, default: null },

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        }
    },
    { timestamps: true }
);

htlcSchema.index({ status: 1, timelock: 1 });
htlcSchema.index({ sender: 1, status: 1 });
htlcSchema.index({ receiver: 1, status: 1 });

htlcSchema.methods.isExpired = function () {
    return Date.now() / 1000 >= this.timelock;
};

htlcSchema.methods.canClaim = function (preimage) {
    if (this.status !== 'locked') return false;
    if (!preimage) return false;
    const { sha256 } = require('@noble/hashes/sha2');
    const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');
    const computed = bytesToHex(sha256(utf8ToBytes(preimage)));
    return computed.toLowerCase() === this.hashlock.toLowerCase();
};

htlcSchema.methods.toPublic = function () {
    return {
        htlcId: this.htlcId,
        chain: this.chain,
        sender: this.sender,
        receiver: this.receiver,
        amount: this.amount.toString(),
        token: this.token,
        hashlock: this.hashlock,
        timelock: this.timelock,
        status: this.status,
        preimage: this.status === 'claimed' ? this.preimage : null,
        txHashLock: this.txHashLock,
        txHashClaim: this.txHashClaim,
        txHashRefund: this.txHashRefund,
        swapId: this.swapId,
        claimedAt: this.claimedAt,
        refundedAt: this.refundedAt,
        createdAt: this.createdAt
    };
};

module.exports = mongoose.model('HTLC', htlcSchema);
