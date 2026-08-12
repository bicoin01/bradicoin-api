// validator.js
const crypto = require('crypto');
const blockchain = require('./blockchain');
const staking = require('./staking');

// ============================================
// SISTEMA DE VALIDADORES
// ============================================

let validators = [];

// ============================================
// CARREGAR DADOS
// ============================================
function loadValidators() {
    try {
        const data = blockchain.loadFromDisk();
        if (data && data.validators) {
            validators = data.validators;
        }
    } catch (error) {
        console.error('Erro ao carregar validadores:', error);
    }
}

// ============================================
// REGISTRAR VALIDADOR
// ============================================
async function register(address, stakeAmount) {
    if (!address || !stakeAmount) {
        throw new Error('Dados incompletos');
    }

    const minStake = parseInt(process.env.MIN_VALIDATOR_STAKE) || 1000;
    if (stakeAmount < minStake) {
        throw new Error(`Stake mínimo para validador: ${minStake} BRD`);
    }

    // Verifica se já é validador
    const existing = validators.find(v => v.address === address);
    if (existing) {
        throw new Error('Endereço já é um validador');
    }

    // Faz o stake
    await staking.stake(address, stakeAmount);

    // Registra como validador
    const validator = {
        address,
        stake: stakeAmount,
        blocksProposed: 0,
        rewards: 0,
        joined: Date.now(),
        lastBlock: null,
        active: true,
        uptime: 100,
        performance: 0
    };

    validators.push(validator);
    blockchain.validators = validators;
    blockchain.saveToDisk();

    return validator;
}

// ============================================
// LISTAR VALIDADORES
// ============================================
async function getValidators() {
    return validators.filter(v => v.active);
}

// ============================================
// SELECIONAR VALIDADOR (PoS)
// ============================================
async function selectValidator() {
    const active = validators.filter(v => v.active);
    if (active.length === 0) return null;

    // Calcula total de stake
    const totalStake = active.reduce((sum, v) => sum + v.stake, 0);
    if (totalStake === 0) return null;

    // Seleção baseada em stake
    let random = Math.random() * totalStake;
    for (const validator of active) {
        random -= validator.stake;
        if (random <= 0) {
            return validator;
        }
    }

    return active[0];
}

// ============================================
// ATUALIZAR ESTATÍSTICAS
// ============================================
async function updateValidatorStats(address, blockIndex) {
    const validator = validators.find(v => v.address === address);
    if (validator) {
        validator.blocksProposed += 1;
        validator.lastBlock = blockIndex;
        validator.performance = (validator.blocksProposed / (Date.now() - validator.joined)) * 1000;
        blockchain.saveToDisk();
    }
}

// ============================================
// ESTATÍSTICAS DOS VALIDADORES
// ============================================
async function getValidatorStats() {
    return {
        total: validators.length,
        active: validators.filter(v => v.active).length,
        totalStake: validators.reduce((sum, v) => sum + v.stake, 0),
        totalBlocks: validators.reduce((sum, v) => sum + v.blocksProposed, 0),
        totalRewards: validators.reduce((sum, v) => sum + v.rewards, 0)
    };
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    register,
    getValidators,
    selectValidator,
    updateValidatorStats,
    getValidatorStats,
    loadValidators
};
