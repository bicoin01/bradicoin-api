// models/ReserveStake.js
// ============================================
// Staking do Fundo de Reserva - Bradicoin
// APR: 130% (2min/30min) | 50% (1h/1d)
// ============================================

const mongoose = require('mongoose');

const POOLS = {
    '2min':  { name: '2 Minutes',  seconds: 120,   apr: 130, minStake: 1,  icon: '⚡' },
    '30min': { name: '30 Minutes', seconds: 1800,  apr: 130, minStake: 1,  icon: '⏱️' },
    '1h':    { name: '1 Hour',     seconds: 3600,  apr: 50,  minStake: 1,  icon: '⌛' },
    '1d':    { name: '1 Day',      seconds: 86400, apr: 50,  minStake: 10, icon: '📅' }
};

const ReserveStakeSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    address: {
        type: String,
        required: true,
        index: true
    },
    poolKey: {
        type: String,
        required: true,
        enum: Object.keys(POOLS)
    },
    poolName: {
        type: String,
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    apr: {
        type: Number,
        required: true
    },
    seconds: {
        type: Number,
        required: true
    },
    startTime: {
        type: Date,
        default: Date.now
    },
    endTime: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'completed', 'cancelled'],
        default: 'active',
        index: true
    },
    reward: {
        type: Number,
        default: 0
    },
    totalReturn: {
        type: Number,
        default: 0
    },
    txHash: {
        type: String,
        default: null
    },
    completedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

// ============================================
// HELPERS
// ============================================

// Calcula recompensa: APR simples
function calcReward(amount, seconds, apr) {
    const years = seconds / 31536000; // segundos em 1 ano
    return amount * (apr / 100) * years;
}

// ============================================
// MÉTODOS
// ============================================

ReserveStakeSchema.methods.isReady = function () {
    return Date.now() >= this.endTime.getTime();
};

ReserveStakeSchema.methods.getProgress = function () {
    const total = this.endTime.getTime() - this.startTime.getTime();
    const elapsed = Date.now() - this.startTime.getTime();
    return Math.min(100, (elapsed / total) * 100);
};

ReserveStakeSchema.methods.getTimeRemaining = function () {
    const remaining = this.endTime.getTime() - Date.now();
    if (remaining <= 0) return 0;
    return remaining;
};

ReserveStakeSchema.methods.getExpectedReward = function () {
    return calcReward(this.amount, this.seconds, this.apr);
};

// ============================================
// STATICS
// ============================================

ReserveStakeSchema.statics.POOLS = POOLS;
ReserveStakeSchema.statics.calcReward = calcReward;

ReserveStakeSchema.statics.getActiveStake = async function (userId) {
    return this.findOne({ userId, status: 'active' }).sort({ createdAt: -1 });
};

ReserveStakeSchema.statics.getUserStakes = async function (userId, limit = 20) {
    return this.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
};

// ============================================
// EXPORTA
// ============================================
const ReserveStakeModel = mongoose.model('ReserveStake', ReserveStakeSchema);

module.exports = {
    ReserveStakeModel,
    POOLS,
    calcReward
};
