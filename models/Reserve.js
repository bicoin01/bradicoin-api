// models/Reserve.js
// ============================================
// Fundo de Reserva - Bradicoin
// ============================================

const mongoose = require('mongoose');

const RESERVE_ADDRESS = process.env.RESERVE_ADDRESS || 'Br7ReserveA9k2M8pQ5tN1vB4cD6wE0yU3iL';
const RESERVE_INITIAL_BALANCE = parseFloat(process.env.RESERVE_INITIAL_BALANCE) || 98000000000000; // 98 trilhões
const MAX_SAFE_BALANCE = 9007199254740991; // 9 quatrilhões (limite seguro do JS)

const ReserveSchema = new mongoose.Schema({
    address: {
        type: String,
        required: true,
        unique: true,
        default: RESERVE_ADDRESS,
        index: true
    },
    balance: {
        type: Number,
        default: RESERVE_INITIAL_BALANCE
    },
    initialBalance: {
        type: Number,
        default: RESERVE_INITIAL_BALANCE
    },
    autoReplenish: {
        type: Boolean,
        default: true
    },
    totalSent: {
        type: Number,
        default: 0
    },
    totalMinted: {
        type: Number,
        default: 0
    },
    totalStakes: {
        type: Number,
        default: 0
    },
    totalRewardsPaid: {
        type: Number,
        default: 0
    },
    maxBalance: {
        type: Number,
        default: MAX_SAFE_BALANCE
    },
    lastActivity: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// ============================================
// MÉTODOS
// ============================================

// Pega (ou cria) o documento único do fundo
ReserveSchema.statics.getReserve = async function () {
    let reserve = await this.findOne({ address: RESERVE_ADDRESS });
    if (!reserve) {
        reserve = await this.create({
            address: RESERVE_ADDRESS,
            balance: RESERVE_INITIAL_BALANCE,
            initialBalance: RESERVE_INITIAL_BALANCE
        });
        console.log('🏦 Fundo de Reserva criado:', RESERVE_ADDRESS);
        console.log('💰 Saldo inicial:', RESERVE_INITIAL_BALANCE, 'BRD');
    }
    return reserve;
};

// Registra envio do fundo (com auto-reposição)
ReserveSchema.statics.recordSend = async function (amount) {
    const reserve = await this.getReserve();

    // ⚠️ Cap de segurança
    if (reserve.balance + amount > MAX_SAFE_BALANCE) {
        throw new Error(`Limite de segurança da rede atingido (${MAX_SAFE_BALANCE} BRD)`);
    }

    reserve.balance -= amount;
    reserve.totalSent += amount;

    // 🔄 Auto-reposição
    if (reserve.autoReplenish) {
        reserve.balance += amount;
        reserve.totalMinted += amount;
    }

    reserve.lastActivity = new Date();
    await reserve.save();

    return reserve;
};

// Registra recompensa de staking paga
ReserveSchema.statics.recordReward = async function (amount) {
    const reserve = await this.getReserve();

    if (reserve.balance + amount > MAX_SAFE_BALANCE) {
        throw new Error(`Limite de segurança da rede atingido (${MAX_SAFE_BALANCE} BRD)`);
    }

    reserve.balance -= amount;
    reserve.totalRewardsPaid += amount;

    if (reserve.autoReplenish) {
        reserve.balance += amount;
        reserve.totalMinted += amount;
    }

    reserve.lastActivity = new Date();
    await reserve.save();

    return reserve;
};

// ============================================
// EXPORTA
// ============================================
const ReserveModel = mongoose.model('Reserve', ReserveSchema);

module.exports = {
    ReserveModel,
    RESERVE_ADDRESS,
    RESERVE_INITIAL_BALANCE,
    MAX_SAFE_BALANCE
};
