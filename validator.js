// validator.js
// ============================================
// Bradicoin Blockchain - Validators (PoS)
// ============================================

const crypto = require('crypto');
const mongoose = require('mongoose');
const staking = require('./staking');
const wallet = require('./wallet');

const parsedMin = Number.parseInt(process.env.MIN_VALIDATOR_STAKE, 10);
const MIN_VALIDATOR_STAKE = Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : 1000;

// ============================================
// HELPERS
// ============================================

// Garante que o endereço é string (evita injeção NoSQL, ex.: { "$ne": null })
function assertAddress(address) {
    if (typeof address !== 'string' || address.length === 0 || address.length > 128) {
        throw new Error('Endereço inválido');
    }
    return address;
}

// Garante número finito e positivo (typeof NaN/Infinity === 'number', por isso o isFinite)
function assertPositiveAmount(value, label = 'Valor') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} deve ser um número positivo`);
    }
    return value;
}

// Número aleatório criptograficamente seguro em [0, 1)
function secureRandom() {
    return crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

// ============================================
// SCHEMA MONGOOSE — VALIDATOR
// ============================================
const ValidatorSchema = new mongoose.Schema({
    address: { type: String, required: true, unique: true, index: true, trim: true },
    stake: { type: Number, required: true, min: 0 },
    blocksProposed: { type: Number, default: 0, min: 0 },
    rewards: { type: Number, default: 0, min: 0 },
    joined: { type: Number, default: () => Date.now() },
    lastBlock: { type: Number, default: null },
    active: { type: Boolean, default: true, index: true },
    uptime: { type: Number, default: 100, min: 0, max: 100 },
    performance: { type: Number, default: 0, min: 0 }
});

// Evita OverwriteModelError se o módulo for carregado mais de uma vez
const ValidatorModel = mongoose.models.Validator || mongoose.model('Validator', ValidatorSchema);

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    if (mongoose.connection.readyState === 0) {
        if (!process.env.MONGO_URI) {
            throw new Error('MONGO_URI não configurada');
        }
        await mongoose.connect(process.env.MONGO_URI);
    }
    await ValidatorModel.init();
    console.log('✅ Validators inicializados');
}

// ============================================
// REGISTRAR VALIDADOR
// ============================================
async function register(address, stakeAmount) {
    assertAddress(address);
    assertPositiveAmount(stakeAmount, 'Stake');

    if (!wallet.isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }

    if (stakeAmount < MIN_VALIDATOR_STAKE) {
        throw new Error(`Stake mínimo para validador: ${MIN_VALIDATOR_STAKE} BRD`);
    }

    // 1) Reserva o registro (inativo). O índice único impede registro duplicado
    //    mesmo com duas requisições simultâneas.
    let validator;
    try {
        validator = await ValidatorModel.create({
            address,
            stake: stakeAmount,
            active: false
        });
    } catch (err) {
        if (err && err.code === 11000) {
            throw new Error('Endereço já é um validador');
        }
        throw err;
    }

    // 2) Trava o saldo no pool. Se falhar, remove a reserva (nada fica pela metade).
    try {
        await staking.stake(address, stakeAmount);
    } catch (err) {
        await ValidatorModel.deleteOne({ _id: validator._id }).catch(() => {});
        throw err;
    }

    // 3) Ativa o validador
    try {
        validator = await ValidatorModel.findByIdAndUpdate(
            validator._id,
            { $set: { active: true } },
            { new: true }
        );
    } catch (err) {
        console.error(`❌ CRÍTICO: stake feito mas validador não ativado (${address}). Verificar manualmente.`);
        throw err;
    }

    console.log(`🛡️  Validador registrado: ${address} (${stakeAmount} BRD)`);
    return validator.toObject();
}

// ============================================
// LISTAR VALIDADORES ATIVOS
// ============================================
async function getValidators(limit = 500) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 1000);
    return ValidatorModel.find({ active: true })
        .sort({ stake: -1 })
        .limit(safeLimit)
        .lean();
}

// ============================================
// SELECIONAR VALIDADOR (PoS — ponderado por stake)
// ============================================
async function selectValidator() {
    const active = await ValidatorModel.find({
        active: true,
        stake: { $gte: MIN_VALIDATOR_STAKE }
    }).lean();

    if (active.length === 0) return null;

    const totalStake = active.reduce((sum, v) => sum + (v.stake || 0), 0);
    if (!(totalStake > 0)) return null;

    let random = secureRandom() * totalStake;
    for (const validator of active) {
        random -= validator.stake;
        if (random < 0) return validator;
    }

    return active[active.length - 1];
}

// ============================================
// ATUALIZAR ESTATÍSTICAS APÓS PROPOR BLOCO
// (atômico: sem race condition entre leitura e escrita)
// ============================================
async function updateValidatorStats(address, blockIndex) {
    assertAddress(address);
    if (!Number.isInteger(blockIndex) || blockIndex < 0) {
        throw new Error('Índice de bloco inválido');
    }

    const now = Date.now();

    // Pipeline de update (MongoDB 4.2+): incrementa e recalcula a performance de uma vez
    const doc = await ValidatorModel.findOneAndUpdate(
        { address },
        [
            {
                $set: {
                    blocksProposed: { $add: ['$blocksProposed', 1] },
                    lastBlock: blockIndex,
                    performance: {
                        $multiply: [
                            {
                                $divide: [
                                    { $add: ['$blocksProposed', 1] },
                                    { $max: [{ $subtract: [now, '$joined'] }, 1] }
                                ]
                            },
                            1000
                        ]
                    }
                }
            }
        ],
        { new: true }
    ).lean();

    return doc || null;
}

// ============================================
// ADICIONAR REWARD AO VALIDADOR (atômico)
// ============================================
async function addReward(address, amount) {
    assertAddress(address);
    assertPositiveAmount(amount, 'Reward');

    const doc = await ValidatorModel.findOneAndUpdate(
        { address },
        { $inc: { rewards: amount } },
        { new: true }
    ).lean();

    return doc || null;
}

// ============================================
// DESATIVAR VALIDADOR (ex: slashing)
// ============================================
async function deactivate(address) {
    assertAddress(address);

    const doc = await ValidatorModel.findOneAndUpdate(
        { address },
        { $set: { active: false } },
        { new: true }
    ).lean();

    if (!doc) throw new Error('Validador não encontrado');
    return doc;
}

// ============================================
// ESTATÍSTICAS GLOBAIS (agregação no banco, sem carregar tudo em memória)
// ============================================
async function getValidatorStats() {
    const [result] = await ValidatorModel.aggregate([
        {
            $group: {
                _id: null,
                total: { $sum: 1 },
                active: { $sum: { $cond: ['$active', 1, 0] } },
                totalStake: { $sum: '$stake' },
                totalBlocks: { $sum: '$blocksProposed' },
                totalRewards: { $sum: '$rewards' }
            }
        }
    ]);

    return {
        total: result?.total || 0,
        active: result?.active || 0,
        totalStake: result?.totalStake || 0,
        totalBlocks: result?.totalBlocks || 0,
        totalRewards: result?.totalRewards || 0
    };
}

// ============================================
// BUSCAR VALIDADOR POR ENDEREÇO
// ============================================
async function getByAddress(address) {
    assertAddress(address);
    const doc = await ValidatorModel.findOne({ address }).lean();
    return doc || null;
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    initialize,
    register,
    getValidators,
    selectValidator,
    updateValidatorStats,
    addReward,
    deactivate,
    getValidatorStats,
    getByAddress,
    MIN_VALIDATOR_STAKE,
    ValidatorModel
};
