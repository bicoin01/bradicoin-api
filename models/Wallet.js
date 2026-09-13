// models/Wallet.js
// ============================================
// Schema da Carteira - Bradicoin
// ============================================

const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
            index: true
        },

        address: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        balance: {
            type: Number,
            default: 0,
            min: [0, 'Saldo não pode ser negativo']
        },

        lastAirdropAt: {
            type: Date,
            default: null
        },

        totalAirdropsClaimed: {
            type: Number,
            default: 0
        },

        totalSent: {
            type: Number,
            default: 0
        },

        totalReceived: {
            type: Number,
            default: 0
        },

        totalFeesPaid: {
            type: Number,
            default: 0
        },

        txCount: {
            type: Number,
            default: 0
        },

        status: {
            type: String,
            enum: ['active', 'frozen', 'closed'],
            default: 'active'
        }
    },
    {
        timestamps: true,
        toJSON: {
            transform(doc, ret) {
                delete ret.__v;
                return ret;
            }
        }
    }
);

// ============================================
// MÉTODOS
// ============================================

walletSchema.methods.toPublic = function () {
    return {
        id: this._id,
        address: this.address,
        balance: this.balance,
        totalSent: this.totalSent,
        totalReceived: this.totalReceived,
        totalFeesPaid: this.totalFeesPaid,
        txCount: this.txCount,
        status: this.status,
        createdAt: this.createdAt,
        lastAirdropAt: this.lastAirdropAt
    };
};

walletSchema.methods.canClaimAirdrop = function () {
    if (!this.lastAirdropAt) return true;
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    return (Date.now() - this.lastAirdropAt.getTime()) >= SIX_HOURS;
};

walletSchema.methods.timeUntilNextAirdrop = function () {
    if (!this.lastAirdropAt) return 0;
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const elapsed = Date.now() - this.lastAirdropAt.getTime();
    return Math.max(0, SIX_HOURS - elapsed);
};

// ============================================
// ÍNDICES
// ============================================

walletSchema.index({ userId: 1 });
walletSchema.index({ address: 1 });
walletSchema.index({ status: 1 });

module.exports = mongoose.model('Wallet', walletSchema);
