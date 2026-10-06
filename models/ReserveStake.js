// models/ReserveStake.js
// ============================================
// Staking do Fundo de Reserva - Bradicoin
// APR: 20% (todos os pools)
// Pools: 24h / 7d / 30d
// ============================================
//
// ⚠️ AVISO: 20% APR é sustentável apenas se o Reserve
// tiver um fundo que gere retorno suficiente para pagar
// os stakers sem secar. Monitore o Reserve regularmente.
//
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

// ============================================
// POOLS
// ============================================
const POOLS = {
    '24h': { name: '24 Hours', seconds: 86400,   apr: 20, minStake: '1',   maxStake: '50000',   icon: '📅' },
    '7d':  { name: '7 Days',   seconds: 604800,  apr: 20, minStake: '10',  maxStake: '250000',  icon: '📆' },
    '30d': { name: '30 Days',  seconds: 2592000, apr: 20, minStake: '100', maxStake: '1000000', icon: '🗓️' }
};

// ============================================
// SCHEMA
// ============================================
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
        index: true,
        validate: {
            validator: function (v) {
                return /^Br[a-fA-F0-9]{38}$/.test(v);
            },
            message: 'Endereço inválido'
        }
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

    // 💰 Decimal128 para precisão
    amount: {
        type: Decimal128,
        required: true,
        validate: {
            validator: function (v) {
                return parseFloat(v.toString()) > 0;
            },
            message: 'Valor deve ser positivo'
        }
    },

    apr: {
        type: Number,
        required: true,
        min: 0
    },

    seconds: {
        type: Number,
        required: true,
        min: 60
    },

    startTime: {
        type: Date,
        default: Date.now,
        required: true
    },

    endTime: {
        type: Date,
        required: true,
        index: true
    },

    status: {
        type: String,
        enum: ['active', 'completed', 'cancelled'],
        default: 'active',
        index: true
    },

    // 💵 Decimal128 para precisão
    reward: {
        type: Decimal128,
        default: () => Decimal128.fromString('0')
    },

    totalReturn: {
        type: Decimal128,
        default: () => Decimal128.fromString('0')
    },

    rewardPaid: {
        type: Boolean,
        default: false
    },

    txHash: {
        type: String,
        default: null
    },

    transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Transaction',
        default: null
    },

    completedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true,

    toJSON: {
        transform(doc, ret) {
            delete ret.__v;
            if (ret.amount) ret.amount = ret.amount.toString();
            if (ret.reward) ret.reward = ret.reward.toString();
            if (ret.totalReturn) ret.totalReturn = ret.totalReturn.toString();
            return ret;
        }
    },

    toObject: {
        transform(doc, ret) {
            delete ret.__v;
            if (ret.amount) ret.amount = ret.amount.toString();
            if (ret.reward) ret.reward = ret.reward.toString();
            if (ret.totalReturn) ret.totalReturn = ret.totalReturn.toString();
            return ret;
        }
    }
});

// ============================================
// 🔐 ÍNDICE ÚNICO PARCIAL
// ============================================
ReserveStakeSchema.index(
    { userId: 1 },
    {
        unique: true,
        partialFilterExpression: { status: 'active' },
        name: 'one_active_stake_per_user'
    }
);

ReserveStakeSchema.index({ address: 1, status: 1 });
ReserveStakeSchema.index({ status: 1, endTime: 1 });
ReserveStakeSchema.index({ createdAt: -1 });

// ============================================
// HELPERS
// ============================================
function calcReward(amountStr, seconds, apr) {
    const amount = parseFloat(amountStr.toString());
    const years = seconds / 31536000;
    return amount * (apr / 100) * years;
}

// ============================================
// MÉTODOS DE INSTÂNCIA
// ============================================
ReserveStakeSchema.methods.isReady = function () {
    return Date.now() >= this.endTime.getTime();
};

ReserveStakeSchema.methods.getProgress = function () {
    const total = this.endTime.getTime() - this.startTime.getTime();
    const elapsed = Date.now() - this.startTime.getTime();
    return Math.min(100, Math.max(0, (elapsed / total) * 100));
};

ReserveStakeSchema.methods.getTimeRemaining = function () {
    const remaining = this.endTime.getTime() - Date.now();
    return Math.max(0, remaining);
};

ReserveStakeSchema.methods.getExpectedReward = function () {
    return calcReward(this.amount.toString(), this.seconds, this.apr);
};

ReserveStakeSchema.methods.toPublic = function () {
    return {
        id: this._id,
        userId: this.userId,
        address: this.address,
        poolKey: this.poolKey,
        poolName: this.poolName,
        amount: this.amount.toString(),
        apr: this.apr,
        seconds: this.seconds,
        startTime: this.startTime,
        endTime: this.endTime,
        completedAt: this.completedAt,
        status: this.status,
        reward: this.reward.toString(),
        totalReturn: this.totalReturn.toString(),
        rewardPaid: this.rewardPaid,
        txHash: this.txHash,
        createdAt: this.createdAt
    };
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

ReserveStakeSchema.statics.getReadyToClaim = async function (limit = 100) {
    return this.find({
        status: 'active',
        rewardPaid: false,
        endTime: { $lte: new Date() }
    })
        .limit(limit)
        .lean();
};

ReserveStakeSchema.statics.getStats = async function () {
    const [totalStakes, activeStakes, totalStakedAgg, avgAprAgg] = await Promise.all([
        this.countDocuments({}),
        this.countDocuments({ status: 'active' }),
        this.aggregate([
            { $match: { status: 'active' } },
            {
                $group: {
                    _id: null,
                    totalStaked: { $sum: { $toDouble: '$amount' } }
                }
            }
        ]),
        this.aggregate([
            { $match: { status: 'active' } },
            {
                $group: {
                    _id: null,
                    avgApr: { $avg: '$apr' }
                }
            }
        ])
    ]);

    return {
        totalStakes,
        activeStakes,
        totalStaked: totalStakedAgg[0]?.totalStaked || 0,
        averageApr: avgAprAgg[0]?.avgApr || 0
    };
};

// ============================================
// HOOKS
// ============================================
ReserveStakeSchema.pre('validate', function (next) {
    if (this.poolKey && POOLS[this.poolKey]) {
        const pool = POOLS[this.poolKey];
        if (!this.poolName) this.poolName = pool.name;
        if (!this.apr) this.apr = pool.apr;
        if (!this.seconds) this.seconds = pool.seconds;
    }
    next();
});

// ============================================
// EXPORTA
// ============================================
const ReserveStakeModel = mongoose.model('ReserveStake', ReserveStakeSchema);

module.exports = {
    ReserveStakeModel,
    POOLS,
    calcReward
};
