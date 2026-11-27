// staking.js
// ============================================
// Bradicoin Blockchain - Staking (v2)
// ============================================
'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const blockchain = require('./blockchain');
const wallet = require('./wallet');

// ============================================
// CONFIGURAÇÃO
// ============================================
function envNumber(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
        console.warn(`⚠️ ${name} inválido (${raw}), usando ${fallback}`);
        return fallback;
    }
    return n;
}

const STAKE_POOL_ADDRESS = 'BrSTAKEPOOL000000000000000000000000000000';
const DEFAULT_APY = envNumber('STAKING_APY', 18, 0, 100);
const MIN_STAKE = envNumber('STAKING_MIN', 100, 0, 1e12);
const MIN_CLAIM = envNumber('STAKING_MIN_CLAIM', 0.0001, 0, 1e12);
const MAX_AMOUNT = 1e12;            // teto por operação
const HISTORY_LIMIT = 200;          // máximo de itens no histórico por usuário
const MAX_RETRIES = 5;              // tentativas em caso de conflito de concorrência
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const FACTOR = 1e8;                 // 8 casas decimais

// ============================================
// SCHEMAS
// ============================================
const StakeSchema = new mongoose.Schema({
    address: { type: String, required: true, unique: true, trim: true },
    staked: { type: Number, default: 0, min: 0 },
    accrued: { type: Number, default: 0, min: 0 },   // reward ganho e ainda não resgatado
    rewards: { type: Number, default: 0, min: 0 },   // reward já pago (histórico)
    lastRewardAt: { type: Number, default: () => Date.now() },
    lastUpdate: { type: Number, default: () => Date.now() },
    history: [{
        _id: false,
        type: { type: String },
        amount: Number,
        timestamp: Number
    }]
});

// Diário de operações: permite reconciliar se algo falhar entre a chain e o banco
const StakeOpSchema = new mongoose.Schema({
    opId: { type: String, required: true, unique: true },
    address: { type: String, required: true, index: true },
    type: { type: String, required: true },
    amount: { type: Number, required: true },
    status: {
        type: String,
        enum: ['pending', 'done', 'failed', 'needs_review'],
        default: 'pending',
        index: true
    },
    error: String,
    createdAt: { type: Number, default: () => Date.now() }
});

// Evita OverwriteModelError em hot reload / testes
const StakeModel = mongoose.models.Stake || mongoose.model('Stake', StakeSchema);
const StakeOpModel = mongoose.models.StakeOp || mongoose.model('StakeOp', StakeOpSchema);

// ============================================
// HELPERS
// ============================================
const round = (n) => Math.round((Number(n) + Number.EPSILON) * FACTOR) / FACTOR;

function parseAmount(value, label = 'Valor') {
    let n;
    if (typeof value === 'number') {
        n = value;
    } else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
        n = Number(value.trim());
    } else {
        throw new Error(`${label} inválido`);
    }
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} deve ser maior que zero`);
    if (n > MAX_AMOUNT) throw new Error(`${label} acima do limite permitido`);
    if (Math.abs(round(n) - n) > 1e-12) throw new Error(`${label} permite no máximo 8 casas decimais`);
    return round(n);
}

async function parseAddress(address) {
    // typeof string impede injeção NoSQL (ex.: { "$ne": null })
    if (typeof address !== 'string') throw new Error('Endereço inválido');
    const addr = address.trim();
    if (!addr || addr.length > 128) throw new Error('Endereço inválido');
    if (addr === STAKE_POOL_ADDRESS) throw new Error('Endereço inválido');
    if (!(await wallet.isValidAddress(addr))) throw new Error('Endereço inválido');
    return addr;
}

// Fila por endereço: impede duas operações simultâneas do mesmo usuário neste processo.
// (Entre vários processos, a proteção é o controle otimista em mutateStake.)
const locks = new Map();
async function withAddressLock(address, fn) {
    const prev = locks.get(address) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chain = prev.then(() => gate);
    locks.set(address, chain);
    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (locks.get(address) === chain) locks.delete(address);
    }
}

// Reward acumulado desde lastRewardAt (juros simples sobre o principal)
function pendingFor(doc, now = Date.now()) {
    const staked = Number(doc.staked) || 0;
    if (staked <= 0) return 0;
    const last = doc.lastRewardAt || doc.lastUpdate || now;
    const elapsed = Math.max(0, now - last);
    return round(staked * (DEFAULT_APY / 100) * (elapsed / YEAR_MS));
}

function pushHistory(type, amount, now) {
    return { type, amount, timestamp: now };
}

// Atualização com controle otimista: só grava se o documento não mudou desde a leitura.
async function mutateStake(address, buildPlan, { create = false } = {}) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const doc = await StakeModel.findOne({ address }).lean();

        if (!doc) {
            if (!create) return { before: null, after: null };
            try {
                const now = Date.now();
                await StakeModel.create({ address, lastRewardAt: now, lastUpdate: now });
            } catch (e) {
                if (e.code !== 11000) throw e; // 11000 = outro processo criou antes
            }
            continue;
        }

        const now = Date.now();
        const plan = buildPlan(doc, now); // pode lançar erro de validação
        const filter = {
            address,
            staked: doc.staked,
            accrued: doc.accrued ?? null,
            rewards: doc.rewards,
            lastRewardAt: doc.lastRewardAt ?? null
        };
        const update = {
            $set: { ...plan.set, lastUpdate: now },
            $push: { history: { $each: [plan.history], $slice: -HISTORY_LIMIT } }
        };

        const after = await StakeModel.findOneAndUpdate(filter, update, { new: true }).lean();
        if (after) return { before: doc, after };
    }
    throw new Error('Operação concorrente em andamento, tente novamente');
}

async function startOp(address, type, amount) {
    const opId = crypto.randomUUID();
    await StakeOpModel.create({ opId, address, type, amount });
    return opId;
}

async function finishOp(opId, status, error) {
    try {
        await StakeOpModel.updateOne({ opId }, { $set: { status, error: error ? String(error).slice(0, 500) : undefined } });
    } catch (e) {
        console.error('❌ Falha ao atualizar diário de operações:', opId, e.message);
    }
}

function publicView(doc, now = Date.now()) {
    const pending = round((doc.accrued || 0) + pendingFor(doc, now));
    return {
        address: doc.address,
        staked: doc.staked || 0,
        rewards: doc.rewards || 0,         // já pagos
        pendingRewards: pending,           // disponíveis para resgate
        total: round((doc.staked || 0) + pending),
        lastUpdate: doc.lastUpdate
    };
}

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    if (mongoose.connection.readyState !== 1) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('MongoDB não conectou a tempo')), 15000);
            mongoose.connection.once('connected', () => { clearTimeout(timer); resolve(); });
        });
    }
    await StakeModel.init();
    await StakeOpModel.init();
    console.log('✅ Staking inicializado');
}

// ============================================
// FAZER STAKE
// ============================================
async function stake(address, amount) {
    const addr = await parseAddress(address);
    const value = parseAmount(amount, 'Valor do stake');
    if (value < MIN_STAKE) throw new Error(`Stake mínimo: ${MIN_STAKE} BRD`);

    return withAddressLock(addr, async () => {
        // Usa o menor entre saldo confirmado e total, para não stakear fundos pendentes
        const info = await wallet.getBalance(addr);
        const candidates = [info && info.balance, info && info.total].map(Number).filter(Number.isFinite);
        if (!candidates.length) throw new Error('Não foi possível obter o saldo');
        const available = Math.min(...candidates);
        if (available < value) throw new Error(`Saldo insuficiente: ${available} < ${value}`);

        const opId = await startOp(addr, 'stake', value);

        // 1) Move os fundos para o pool on-chain
        try {
            await blockchain.addTransaction({
                fromAddress: addr,
                toAddress: STAKE_POOL_ADDRESS,
                amount: value,
                timestamp: new Date().toISOString(),
                type: 'stake'
            });
        } catch (e) {
            await finishOp(opId, 'failed', e.message);
            throw e;
        }

        // 2) Credita o stake no banco
        try {
            const { after } = await mutateStake(addr, (doc, now) => ({
                set: {
                    staked: round(doc.staked + value),
                    accrued: round((doc.accrued || 0) + pendingFor(doc, now)),
                    lastRewardAt: now
                },
                history: pushHistory('stake', value, now)
            }), { create: true });
            await finishOp(opId, 'done');
            return publicView(after);
        } catch (e) {
            // Fundos já estão no pool: precisa de reconciliação manual
            await finishOp(opId, 'needs_review', e.message);
            console.error(`🚨 STAKE on-chain OK mas banco falhou (op ${opId}):`, e.message);
            throw new Error(`Stake enviado, mas o registro falhou. Referência: ${opId}`);
        }
    });
}

// ============================================
// FAZER UNSTAKE
// ============================================
async function unstake(address, amount) {
    const addr = await parseAddress(address);
    const value = parseAmount(amount, 'Valor do unstake');

    return withAddressLock(addr, async () => {
        const opId = await startOp(addr, 'unstake', value);

        // 1) Debita o banco primeiro (impede unstake duplicado)
        let debited;
        try {
            debited = await mutateStake(addr, (doc, now) => {
                if (doc.staked < value) {
                    throw new Error(`Stake insuficiente: ${doc.staked} < ${value}`);
                }
                return {
                    set: {
                        staked: round(doc.staked - value),
                        accrued: round((doc.accrued || 0) + pendingFor(doc, now)),
                        lastRewardAt: now
                    },
                    history: pushHistory('unstake', value, now)
                };
            });
            if (!debited.after) throw new Error('Stake insuficiente: 0 < ' + value);
        } catch (e) {
            await finishOp(opId, 'failed', e.message);
            throw e;
        }

        // 2) Devolve os fundos on-chain; se falhar, desfaz o débito
        try {
            await blockchain.addTransaction({
                fromAddress: STAKE_POOL_ADDRESS,
                toAddress: addr,
                amount: value,
                timestamp: new Date().toISOString(),
                type: 'unstake'
            });
        } catch (e) {
            try {
                await mutateStake(addr, (doc, now) => ({
                    set: { staked: round(doc.staked + value), lastRewardAt: doc.lastRewardAt ?? now },
                    history: pushHistory('unstake_reverted', value, now)
                }));
                await finishOp(opId, 'failed', e.message);
            } catch (revertErr) {
                await finishOp(opId, 'needs_review', `${e.message} | revert: ${revertErr.message}`);
                console.error(`🚨 UNSTAKE falhou e o revert também (op ${opId})`);
            }
            throw new Error('Falha ao devolver os fundos, tente novamente');
        }

        await finishOp(opId, 'done');
        return publicView(debited.after);
    });
}

// ============================================
// RESGATAR REWARDS
// ============================================
async function claimRewards(address) {
    const addr = await parseAddress(address);

    return withAddressLock(addr, async () => {
        let payout = 0;
        let opId = null;

        // 1) Zera o acumulado no banco e registra como pago
        let claimed;
        try {
            claimed = await mutateStake(addr, (doc, now) => {
                payout = round((doc.accrued || 0) + pendingFor(doc, now));
                if (payout < MIN_CLAIM) throw new Error('Sem rewards suficientes para resgatar');
                return {
                    set: {
                        accrued: 0,
                        rewards: round((doc.rewards || 0) + payout),
                        lastRewardAt: now
                    },
                    history: pushHistory('claim', payout, now)
                };
            });
            if (!claimed.after) throw new Error('Nenhum stake encontrado');
        } catch (e) {
            throw e;
        }

        opId = await startOp(addr, 'claim', payout);

        // 2) Cria a transação de reward; se falhar, desfaz
        try {
            await blockchain.addTransaction({
                fromAddress: null, // vem do sistema
                toAddress: addr,
                amount: payout,
                timestamp: new Date().toISOString(),
                type: 'reward'
            });
        } catch (e) {
            try {
                await mutateStake(addr, (doc, now) => ({
                    set: {
                        accrued: round((doc.accrued || 0) + payout),
                        rewards: round(Math.max(0, (doc.rewards || 0) - payout))
                    },
                    history: pushHistory('claim_reverted', payout, now)
                }));
                await finishOp(opId, 'failed', e.message);
            } catch (revertErr) {
                await finishOp(opId, 'needs_review', `${e.message} | revert: ${revertErr.message}`);
                console.error(`🚨 CLAIM falhou e o revert também (op ${opId})`);
            }
            throw new Error('Falha ao pagar o reward, tente novamente');
        }

        await finishOp(opId, 'done');
        return { ...publicView(claimed.after), claimed: payout };
    });
}

// ============================================
// CALCULAR REWARD PENDENTE (leitura)
// ============================================
async function calculateReward(address) {
    const addr = await parseAddress(address);
    const doc = await StakeModel.findOne({ address: addr }).lean();
    if (!doc) return 0;
    return round((doc.accrued || 0) + pendingFor(doc));
}

// ============================================
// DISTRIBUIR REWARD DIRETO (USO INTERNO)
// Não expor em rota pública. Ex.: bônus/airdrop controlado pelo sistema.
// ============================================
async function distributeReward(address, amount) {
    const addr = await parseAddress(address);
    const value = parseAmount(amount, 'Valor do reward');

    return withAddressLock(addr, async () => {
        const opId = await startOp(addr, 'reward', value);
        try {
            await blockchain.addTransaction({
                fromAddress: null,
                toAddress: addr,
                amount: value,
                timestamp: new Date().toISOString(),
                type: 'reward'
            });
        } catch (e) {
            await finishOp(opId, 'failed', e.message);
            throw e;
        }

        try {
            const { after } = await mutateStake(addr, (doc, now) => ({
                set: { rewards: round((doc.rewards || 0) + value) },
                history: pushHistory('reward', value, now)
            }), { create: true });
            await finishOp(opId, 'done');
            return publicView(after);
        } catch (e) {
            await finishOp(opId, 'needs_review', e.message);
            console.error(`🚨 REWARD on-chain OK mas banco falhou (op ${opId}):`, e.message);
            throw new Error(`Reward enviado, mas o registro falhou. Referência: ${opId}`);
        }
    });
}

// ============================================
// CONSULTAS
// ============================================
async function getActiveStakers(limit = 1000) {
    const max = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000);
    const docs = await StakeModel.find({ staked: { $gt: 0 } })
        .sort({ staked: -1 })
        .limit(max)
        .lean();
    return docs.map((d) => ({
        address: d.address,
        staked: d.staked,
        rewards: d.rewards,
        lastUpdate: d.lastUpdate
    }));
}

// Usado pelo site: /api/staking/top-stakers?limit=10
async function getTopStakers(limit = 10) {
    const max = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
    const docs = await StakeModel.find({ staked: { $gt: 0 } })
        .sort({ staked: -1 })
        .limit(max)
        .select('address staked -_id')
        .lean();
    return docs.map((d) => ({ address: d.address, staked: d.staked }));
}

async function getStake(address) {
    const addr = await parseAddress(address);
    const doc = await StakeModel.findOne({ address: addr }).lean();
    if (!doc) {
        return { address: addr, staked: 0, rewards: 0, pendingRewards: 0, total: 0 };
    }
    return publicView(doc);
}

// Alias — o server.js chama getRewards
async function getRewards(address) {
    return getStake(address);
}

async function getStakingStats() {
    const [agg] = await StakeModel.aggregate([{
        $group: {
            _id: null,
            totalStaked: { $sum: '$staked' },
            totalRewards: { $sum: '$rewards' },
            activeStakers: { $sum: { $cond: [{ $gt: ['$staked', 0] }, 1, 0] } }
        }
    }]);

    return {
        totalStaked: round(agg ? agg.totalStaked : 0),
        totalRewards: round(agg ? agg.totalRewards : 0),
        activeStakers: agg ? agg.activeStakers : 0,
        apy: DEFAULT_APY
    };
}

// Operações que precisam de conferência manual (chain e banco divergiram)
async function getOpsNeedingReview(limit = 100) {
    const max = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    return StakeOpModel.find({ status: { $in: ['needs_review', 'pending'] } })
        .sort({ createdAt: -1 })
        .limit(max)
        .lean();
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    initialize,
    stake,
    unstake,
    claimRewards,
    calculateReward,
    distributeReward,
    getActiveStakers,
    getTopStakers,
    getStake,
    getRewards,
    getStakingStats,
    getOpsNeedingReview,
    STAKE_POOL_ADDRESS,
    MIN_STAKE,
    StakeModel
};
