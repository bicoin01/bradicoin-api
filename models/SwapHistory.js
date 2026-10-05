// models/SwapHistory.js
const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const swapHistorySchema = new mongoose.Schema(
    {
        swapId: { type: String, required: true, index: true },
        address: { type: String, required: true, index: true },
        role: {
            type: String,
            enum: ['maker', 'taker'],
            required: true
        },
        fromChain: { type: String, required: true },
        toChain: { type: String, required: true },
        fromAmount: { type: Decimal128, required: true },
        toAmount: { type: Decimal128, required: true },
        fromToken: { type: String, required: true },
        toToken: { type: String, required: true },
        status: { type: String, required: true, index: true },
        createdAt: { type: Date, default: Date.now, index: true },
        completedAt: { type: Date, default: null }
    },
    { timestamps: true }
);

swapHistorySchema.index({ address: 1, createdAt: -1 });

module.exports = mongoose.model('SwapHistory', swapHistorySchema);
