// staking.js
const crypto = require('crypto');
const blockchain = require('./blockchain');

// ============================================
// SISTEMA DE STAKING
// ============================================

let stakingPool = {};

// ============================================
// CARREGAR DADOS
// ============================================
function loadStakingData() {
    try {
        const data = blockchain.loadFromDisk();
        if (data && data.stakingPool) {
            stakingPool = data.stakingPool;
        }
    } catch (error) {
        console.error('Erro ao carregar dados de staking:', error);
    }
}

// ============================================
// FAZER STAKE
// ============================================
async function stake(address, amount) {
    if (!address || !amount || amount <= 0) {
        throw new Error('Dados inválidos');
    }

    // Verifica saldo
    const balance = blockchain.getBalance(address);
    if (balance < amount) {
        throw new Error(`Saldo insuficiente: ${balance} < ${amount}`);
    }

    // Inicializa pool se não existir
    if (!stakingPool[address]) {
        stakingPool[address] = {
            staked: 0,
            rewards: 0,
            lastUpdate: Date.now(),
            history: []
        };
    }

    // Remove do saldo
    blockchain.balances[address] = (blockchain.balances[address] || 0) - amount;

    // Adiciona ao staking
    stakingPool[address].staked += amount;
    stakingPool[address].lastUpdate = Date.now();
    stakingPool[address].history.push({
        type: 'stake',
        amount,
        timestamp: Date.now()
    });

    // Registra transação
    const tx = {
        from: address,
        to: null,
        amount,
        type: 'stake',
        timestamp: Date.now(),
        hash: crypto.randomBytes(32).toString('hex')
    };
    blockchain.addTransaction(tx);
    blockchain.saveToDisk();

    return {
        address,
        staked: stakingPool[address].staked,
        rewards: stakingPool[address].rewards,
        total: stakingPool[address].staked + stakingPool[address].rewards
    };
}

// ============================================
// FAZER UNSTAKE
// ============================================
async function unstake(address, amount) {
    if (!address || !amount || amount <= 0) {
        throw new Error('Dados inválidos');
    }

    if (!stakingPool[address]) {
        throw new Error('Nenhum stake encontrado');
    }

    if (stakingPool[address].staked < amount) {
        throw new Error(`Stake insuficiente: ${stakingPool[address].staked} < ${amount}`);
    }

    // Remove do staking
    stakingPool[address].staked -= amount;
    stakingPool[address].lastUpdate = Date.now();
    stakingPool[address].history.push({
        type: 'unstake',
        amount,
        timestamp: Date.now()
    });

    // Adiciona ao saldo
    blockchain.balances[address] = (blockchain.balances[address] || 0) + amount;

    // Registra transação
    const tx = {
        from: null,
        to: address,
        amount,
        type: 'unstake',
        timestamp: Date.now(),
        hash: crypto.randomBytes(32).toString('hex')
    };
    blockchain.addTransaction(tx);
    blockchain.saveToDisk();

    return {
        address,
        staked: stakingPool[address].staked,
        rewards: stakingPool[address].rewards,
        total: stakingPool[address].staked + stakingPool[address].rewards
    };
}

// ============================================
// CALCULAR REWARDS
// ============================================
async function calculateReward(address) {
    if (!stakingPool[address]) return 0;

    const data = stakingPool[address];
    const timeElapsed = (Date.now() - data.lastUpdate) / (1000 * 60 * 60 * 24 * 365);
    const apy = parseFloat(process.env.STAKING_APY) || 18;
    
    const reward = data.staked * (apy / 100) * timeElapsed;
    return reward;
}

// ============================================
// DISTRIBUIR REWARDS
// ============================================
async function distributeReward(address, amount) {
    if (!stakingPool[address]) {
        stakingPool[address] = { staked: 0, rewards: 0, lastUpdate: Date.now(), history: [] };
    }

    stakingPool[address].rewards += amount;
    stakingPool[address].lastUpdate = Date.now();
    stakingPool[address].history.push({
        type: 'reward',
        amount,
        timestamp: Date.now()
    });

    // Adiciona ao saldo
    blockchain.balances[address] = (blockchain.balances[address] || 0) + amount;

    blockchain.saveToDisk();
    return stakingPool[address];
}

// ============================================
// BUSCAR STAKERS ATIVOS
// ============================================
async function getActiveStakers() {
    const active = [];
    for (const [address, data] of Object.entries(stakingPool)) {
        if (data.staked > 0) {
            active.push({
                address,
                staked: data.staked,
                rewards: data.rewards,
                lastUpdate: data.lastUpdate
            });
        }
    }
    return active;
}

// ============================================
// ESTATÍSTICAS DE STAKING
// ============================================
async function getStakingStats() {
    let totalStaked = 0;
    let totalRewards = 0;
    let activeStakers = 0;

    for (const data of Object.values(stakingPool)) {
        totalStaked += data.staked || 0;
        totalRewards += data.rewards || 0;
        if (data.staked > 0) activeStakers++;
    }

    return {
        totalStaked,
        totalRewards,
        activeStakers,
        apy: parseFloat(process.env.STAKING_APY) || 18
    };
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    stake,
    unstake,
    calculateReward,
    distributeReward,
    getActiveStakers,
    getStakingStats,
    loadStakingData
};
