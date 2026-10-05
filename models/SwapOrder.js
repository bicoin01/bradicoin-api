// models/SwapOrder.js
// ============================================
// SwapOrder — Ordem de atomic swap
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const swapOrderSchema = new mongoose.Schema(
    {
        swapId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        maker: {
            address: { type: String, required: true, index: true },
            chain: { type: String, required: true },
            amount: { type: Decimal128, required: true },
            token: { type: String, required: true }
        },

        taker: {
            address: { type: String, default: null, index: true },
            chain: { type: String, default: null },
            amount: { type: Decimal128, default: null },
            token: { type: String, default: null }
        },

        // Par
        fromChain: { type: String, required: true, index: true },
        toChain: { type: String, required: true, index: true },
        fromToken: { type: String, required: true },
        toToken: { type: String, required: true },

        // Preço implícito
        rate: { type: Decimal128, required: true },

        // Hashlock compartilhado
        hashlock: {
            type: String,
            required: true,
            index: true
        },

        // Timelocks (unix segundos)
        timelockMaker: { type: Number, required: true },
        timelockTaker: { type: Number, required: true },

        // HTLCs vinculados
        htlcMakerId: { type: String, default: null, index: true },
        htlcTakerId: { type: String, default: null, index: true },

        // Estado
        status: {
            type: String,
            enum: ['open', 'matched', 'maker_locked', 'taker_locked',
                   'completed', 'refunded', 'expired', 'cancelled'],
            default: 'open',
            index: true
        },

        // Preimage (só após reveal)
        preimage: { type: String, default: null },

        expiresAt: { type: Date, required: true, index: true },

        completedAt: { type: Date, default: null },
        refundedAt: { type: Date, default: null },

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        }
    },
    { timestamps: true }
);

swapOrderSchema.index({ status: 1, fromChain: 1, toChain: 1 });
swapOrderSchema.index({ 'maker.address': 1, status: 1 });
swapOrderSchema.index({ 'taker.address': 1, status: 1 });

swapOrderSchema.methods.toPublic = function () {
    return {
        swapId: this.swapId,
        maker: {
            address: this.maker.address,
            chain: this.maker.chain,
            amount: this.maker.amount?.toString(),
            token: this.maker.token
        },
        taker: this.taker.address ? {
            address: this.taker.address,
            chain: this.taker.chain,
            amount: this.taker.amount?.toString(),
            token: this.taker.token
        } : null,
        fromChain: this.fromChain,
        toChain: this.toChain,
        fromToken: this.fromToken,
        toToken: this.toToken,
        rate: this.rate?.toString(),
        hashlock: this.hashlock,
        timelockMaker: this.timelockMaker,
        timelockTaker: this.timelockTaker,
        htlcMakerId: this.htlcMakerId,
        htlcTakerId: this.htlcTakerId,
        status: this.status,
        preimage: this.preimage,
        expiresAt: this.expiresAt,
        completedAt: this.completedAt,
        refundedAt: this.refundedAt,
        createdAt: this.createdAt
    };
};

module.exports = mongoose.model('SwapOrder', swapOrderSchema);
