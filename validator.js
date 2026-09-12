// validator.js
// ============================================
// Bradicoin Blockchain - Validators (PoS)
// ============================================

const mongoose = require('mongoose');
const blockchain = require('./blockchain');
const staking = require('./staking');
const wallet = require('./wallet');

const MIN_VALIDATOR_STAKE = parseInt(process.env.MIN_VALIDATOR_STAKE) || 1000;

// ============================================
// SCHEMA MONGOOSE — VALIDATOR
// ============================================
const ValidatorSchema = new mongoose.Schema({
    address: { type: String, required: true, unique: true, index: true },
    stake: { type: Number, required: true },
    blocksProposed: { type: Number, default: 0 },
    rewards: { type: Number, default: 0 },
    joined: { type: Number, default: () => Date.now() },
    lastBlock: { type: Number, default: null },
    active: { type: Boolean, default: true },
    uptime: { type: Number, default: 100 },
    performance: { type: Number, default: 0 }
});

const ValidatorModel = mongoose.model('Validator', ValidatorSchema);

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGO_URI);
    }
    await ValidatorModel.init();
    console.log('✅ Validators inicializados');
}

// ============================================
// REGISTRAR VALIDADOR
// ============================================
async function register(address, stakeAmount) {
    if (!address || !stakeAmount) {
        throw new Error('Dados incompletos');
    }

    if (!wallet.isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }

    if (typeof stakeAmount !== 'number' || stakeAmount <= 0) {
        throw new Error('Stake deve ser um número positivo');
    }

    if (stakeAmount < MIN_VALIDATOR_STAKE) {
        throw new Error(`Stake mínimo para validador: ${MIN_VALIDATOR_STAKE} BRD`);
    }

    // Já é validador?
    const existing = await ValidatorModel.findOne({ address });
    if (existing) {
        throw new Error('Endereço já é um validador');
    }

    // Faz o stake (trava o saldo no pool)
    await staking.stake(address, stakeAmount);

    // Registra como validador no Mongo
    const validator = await ValidatorModel.create({
        address,
        stake: stakeAmount,
        blocksProposed: 0,
        rewards: 0,
        joined: Date.now(),
        lastBlock: null,
        active: true,
        uptime: 100,
        performance: 0
    });

    console.log(`🛡️  Validador registrado: ${address} (${stakeAmount} BRD)`);

    return validator.toObject();
}

// ============================================
// LISTAR VALIDADORES ATIVOS
// ============================================
async function getValidators() {
    const docs = await ValidatorModel.find({ active: true }).lean();
    return docs;
}

// ============================================
// SELECIONAR VALIDADOR (PoS — ponderado por stake)
// ============================================
async function selectValidator() {
    const active = await ValidatorModel.find({ active: true }).lean();
    if (active.length === 0) return null;

    const totalStake = active.reduce((sum, v) => sum + (v.stake || 0), 0);
    if (totalStake === 0) return null;

    let random = Math.random() * totalStake;
    for (const validator of active) {
        random -= validator.stake;
        if (random <= 0) return validator;
    }

    return active[0];
}

// ============================================
// ATUALIZAR ESTATÍSTICAS APÓS PROPOR BLOCO
// ============================================
async function updateValidatorStats(address, blockIndex) {
    const doc = await ValidatorModel.findOne({ address });
    if (!doc) return null;

    doc.blocksProposed += 1;
    doc.lastBlock = blockIndex;

    const timeSinceJoined = Math.max(Date.now() - doc.joined, 1);
    doc.performance = (doc.blocksProposed / timeSinceJoined) * 1000;

    await doc.save();
    return doc.toObject();
}

// ============================================
// ADICIONAR REWARD AO VALIDADOR
// ============================================
async function addReward(address, amount) {
    const doc = await ValidatorModel.findOne({ address });
    if (!doc) return null;

    doc.rewards += amount;
    await doc.save();

    return doc.toObject();
}

// ============================================
// DESATIVAR VALIDADOR (ex: slashing)
// ============================================
async function deactivate(address) {
    const doc = await ValidatorModel.findOne({ address });
    if (!doc) throw new Error('Validador não encontrado');

    doc.active = false;
    await doc.save();
    return doc.toObject();
}

// ============================================
// ESTATÍSTICAS GLOBAIS
// ============================================
async function getValidatorStats() {
    const docs = await ValidatorModel.find().lean();

    return {
        total: docs.length,
        active: docs.filter((v) => v.active).length,
        totalStake: docs.reduce((sum, v) => sum + (v.stake || 0), 0),
        totalBlocks: docs.reduce((sum, v) => sum + (v.blocksProposed || 0), 0),
        totalRewards: docs.reduce((sum, v) => sum + (v.rewards || 0), 0)
    };
}

// ============================================
// BUSCAR VALIDADOR POR ENDEREÇO
// ============================================
async function getByAddress(address) {
    const doc = await ValidatorModel.findOne({ address }).lean();
    return doc || null;
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    initialize,            // ✅ server.js precisa
    register,
    getValidators,         // ✅ server.js usa em rota + WebSocket
    selectValidator,
    updateValidatorStats,
    addReward,
    deactivate,
    getValidatorStats,
    getByAddress,
    MIN_VALIDATOR_STAKE,
    ValidatorModel
};
