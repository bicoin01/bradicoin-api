// staking.js
// ============================================
// Bradicoin Blockchain - Staking
// ============================================

const mongoose = require('mongoose');
const blockchain = require('./blockchain');
const wallet = require('./wallet');

const STAKE_POOL_ADDRESS = 'BrSTAKEPOOL000000000000000000000000000000';
const DEFAULT_APY = parseFloat(process.env.STAKING_APY) || 18;

// ============================================
// SCHEMA MONGOOSE — STAKE
// ============================================
const StakeSchema = new mongoose.Schema({
    address: { type: String, required: true, unique: true, index: true },
    staked: { type: Number, default: 0 },
    rewards: { type: Number, default: 0 },
    lastUpdate: { type: Number, default: () => Date.now() },
    history: [{
        type: { type: String },
        amount: Number,
        timestamp: Number
    }]
});

const StakeModel = mongoose.model('Stake', StakeSchema);

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGO_URI);
    }
    await StakeModel.init();
    console.log('✅ Staking inicializado');
}

// ============================================
// HELPER — pega (ou cria) registro de stake
// ============================================
async function getOrCreate(address) {
    let doc = await StakeModel.findOne({ address });
    if (!doc) {
        doc = await StakeModel.create({
            address,
            staked: 0,
            rewards: 0,
            lastUpdate: Date.now(),
            history: []
        });
    }
    return doc;
}

// ============================================
// FAZER STAKE
// ============================================
async function stake(address, amount) {
    if (!address || !amount || amount <= 0) {
        throw new Error('Dados inválidos');
    }

    if (!wallet.isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }

    // Saldo do usuário via wallet (considera pendentes)
    const balanceInfo = await wallet.getBalance(address);
    const available = balanceInfo.total;

    if (available < amount) {
        throw new Error(`Saldo insuficiente: ${available} < ${amount}`);
    }

    // Registra a transação de stake (debita o usuário e credita o pool)
    const tx = {
        fromAddress: address,
        toAddress: STAKE_POOL_ADDRESS,
        amount,
        timestamp: new Date().toISOString(),
        type: 'stake'
    };
    await blockchain.addTransaction(tx);

    // Atualiza registro do stake
    const doc = await getOrCreate(address);
    doc.staked += amount;
    doc.lastUpdate = Date.now();
    doc.history.push({ type: 'stake', amount, timestamp: Date.now() });
    await doc.save();

    return {
        address,
        staked: doc.staked,
        rewards: doc.rewards,
        total: doc.staked + doc.rewards
    };
}

// ============================================
// FAZER UNSTAKE
// ============================================
async function unstake(address, amount) {
    if (!address || !amount || amount <= 0) {
        throw new Error('Dados inválidos');
    }

    const doc = await StakeModel.findOne({ address });
    if (!doc || doc.staked < amount) {
        throw new Error(`Stake insuficiente: ${doc ? doc.staked : 0} < ${amount}`);
    }

    // Registra a transação de unstake (credita de volta ao usuário)
    const tx = {
        fromAddress: STAKE_POOL_ADDRESS,
        toAddress: address,
        amount,
        timestamp: new Date().toISOString(),
        type: 'unstake'
    };
    await blockchain.addTransaction(tx);

    // Atualiza registro
    doc.staked -= amount;
    doc.lastUpdate = Date.now();
    doc.history.push({ type: 'unstake', amount, timestamp: Date.now() });
    await doc.save();

    return {
        address,
        staked: doc.staked,
        rewards: doc.rewards,
        total: doc.staked + doc.rewards
    };
}

// ============================================
// CALCULAR REWARDS (APY)
// ============================================
async function calculateReward(address) {
    const doc = await StakeModel.findOne({ address });
    if (!doc || doc.staked <= 0) return 0;

    const timeElapsedYears = (Date.now() - doc.lastUpdate) / (1000 * 60 * 60 * 24 * 365);
    const reward = doc.staked * (DEFAULT_APY / 100) * timeElapsedYears;
    return reward;
}

// ============================================
// DISTRIBUIR REWARD
// ============================================
async function distributeReward(address, amount) {
    if (!amount || amount <= 0) return null;

    // Registra tx de reward (fromAddress: null = vem do sistema)
    const tx = {
        fromAddress: null,
        toAddress: address,
        amount,
        timestamp: new Date().toISOString(),
        type: 'reward'
    };
    await blockchain.addTransaction(tx);

    // Atualiza registro
    const doc = await getOrCreate(address);
    doc.rewards += amount;
    doc.lastUpdate = Date.now();
    doc.history.push({ type: 'reward', amount, timestamp: Date.now() });
    await doc.save();

    return doc;
}

// ============================================
// STAKERS ATIVOS
// ============================================
async function getActiveStakers() {
    const docs = await StakeModel.find({ staked: { $gt: 0 } }).lean();
    return docs.map((d) => ({
        address: d.address,
        staked: d.staked,
        rewards: d.rewards,
        lastUpdate: d.lastUpdate
    }));
}

// ============================================
// BUSCAR STAKE DE UM USUÁRIO
// ============================================
async function getStake(address) {
    const doc = await StakeModel.findOne({ address });
    if (!doc) {
        return { address, staked: 0, rewards: 0, total: 0 };
    }
    return {
        address: doc.address,
        staked: doc.staked,
        rewards: doc.rewards,
        total: doc.staked + doc.rewards,
        lastUpdate: doc.lastUpdate
    };
}

// ============================================
// ALIAS — o server.js chama getRewards
// ============================================
async function getRewards(address) {
    return getStake(address);
}

// ============================================
// ESTATÍSTICAS GLOBAIS
// ============================================
async function getStakingStats() {
    const docs = await StakeModel.find().lean();

    let totalStaked = 0;
    let totalRewards = 0;
    let activeStakers = 0;

    for (const d of docs) {
        totalStaked += d.staked || 0;
        totalRewards += d.rewards || 0;
        if (d.staked > 0) activeStakers++;
    }

    return {
        totalStaked,
        totalRewards,
        activeStakers,
        apy: DEFAULT_APY
    };
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    initialize,            // ✅ server.js precisa
    stake,
    unstake,
    calculateReward,
    distributeReward,
    getActiveStakers,
    getStake,
    getRewards,            // ✅ server.js precisa (rota /api/staking/rewards/:address)
    getStakingStats,
    STAKE_POOL_ADDRESS,
    StakeModel
};
