// models/Airdrop.js
// ============================================
// Model de Airdrop - BradiChain
// ============================================

const mongoose = require('mongoose');

const AirdropSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        walletAddress: {
            type: String,
            required: true,
            lowercase: true,
            index: true
        },
        amount: {
            type: Number,
            required: true,
            min: 0
        },
        campaign: {
            type: String,
            default: 'bradicoin-genesis',
            index: true
        },
        status: {
            type: String,
            enum: ['pending', 'processing', 'completed', 'failed'],
            default: 'pending',
            index: true
        },
        txHash: { type: String, default: null },
        blockIndex: { type: Number, default: null },
        error: { type: String, default: null },
        ip: { type: String, default: null },
        claimedAt: { type: Date, default: null }
    },
    { timestamps: true }
);

// 1 claim por user por campanha
AirdropSchema.index({ userId: 1, campaign: 1 }, { unique: true });
// 1 claim por wallet por campanha
AirdropSchema.index({ walletAddress: 1, campaign: 1 }, { unique: true });

AirdropSchema.methods.toPublic = function () {
    return {
        id: this._id,
        walletAddress: this.walletAddress,
        amount: this.amount,
        campaign: this.campaign,
        status: this.status,
        txHash: this.txHash,
        blockIndex: this.blockIndex,
        claimedAt: this.claimedAt,
        createdAt: this.createdAt
    };
};

module.exports = mongoose.model('Airdrop', AirdropSchema);
