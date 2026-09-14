// routes/reserveStaking.js
// ============================================
// Staking do Fundo de Reserva (130% APR / 50% APR)
// ============================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');
const blockchainWallet = require('../wallet');
const blockchain = require('../blockchain');
const { ReserveModel } = require('../models/Reserve');
const { ReserveStakeModel, POOLS, calcReward } = require('../models/ReserveStake');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');

function generateTxId() {
    return 'tx_' + crypto.randomBytes(16).toString('hex');
}

// ============================================
// GET /api/v1/reserve-staking/pools
// Lista os pools disponíveis
// ============================================

router.get(
    '/pools',
    asyncHandler(async (req, res) => {
        const pools = Object.entries(POOLS).map(([key, p]) => ({
            key,
            name: p.name,
            seconds: p.seconds,
            apr: p.apr,
            minStake: p.minStake,
            icon: p.icon
        }));

        res.json({
            success: true,
            data: { pools }
        });
    })
);

// ============================================
// POST /api/v1/reserve-staking/stake
// Cria stake com 130% APR / 50% APR
// ============================================

router.post(
    '/stake',
    authenticate,
    asyncHandler(async (req, res) => {
        const { amount, poolKey } = req.body;

        // ===== VALIDAÇÕES =====
        if (!amount || !poolKey) {
            return res.status(400).json({
                success: false,
                error: 'Valor e pool são obrigatórios'
            });
        }

        const pool = POOLS[poolKey];
        if (!pool) {
            return res.status(400).json({
                success: false,
                error: 'Pool inválido'
            });
        }

        const stakeAmount = parseFloat(amount);
        if (isNaN(stakeAmount) || stakeAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Valor inválido'
            });
        }

        if (stakeAmount < pool.minStake) {
            return res.status(400).json({
                success: false,
                error: `Mínimo para ${pool.name}: ${pool.minStake} BRD`
            });
        }

        // ===== CARREGA USER E WALLET =====
        const user = await User.findById(req.userId);
        if (!user || !user.walletAddress) {
            return res.status(404).json({
                success: false,
                error: 'Você precisa ter uma carteira'
            });
        }

        const WalletModel = blockchainWallet.WalletModel;
        const walletDoc = await WalletModel.findOne({ address: user.walletAddress });
        if (!walletDoc) {
            return res.status(404).json({
                success: false,
                error: 'Carteira não encontrada'
            });
        }

        // ===== VERIFICA SE JÁ TEM STAKE ATIVO =====
        const existing = await ReserveStakeModel.getActiveStake(req.userId);
        if (existing) {
            return res.status(409).json({
                success: false,
                error: 'Você já tem um stake ativo. Faça unstake antes de criar outro.',
                data: {
                    activeStake: {
                        id: existing._id,
                        pool: existing.poolName,
                        amount: existing.amount,
                        endTime: existing.endTime
                    }
                }
            });
        }

        // ===== VERIFICA SALDO =====
        const balanceData = await blockchainWallet.getBalance(user.walletAddress);
        if (balanceData.total < stakeAmount) {
            return res.status(400).json({
                success: false,
                error: `Saldo insuficiente. Você tem ${balanceData.total} BRD`
            });
        }

        // ===== DEBITA DO USUÁRIO (blockchain) =====
        const txId = generateTxId();
        await blockchain.addTransaction({
            fromAddress: user.walletAddress,
            toAddress: blockchainWallet.RESERVE_ADDRESS || 'Br7ReserveA9k2M8pQ5tN1vB4cD6wE0yU3iL',
            amount: stakeAmount,
            fee: 0,
            timestamp: new Date().toISOString(),
            type: 'reserve_stake',
            txId
        });

        // ===== CRIA REGISTRO DO STAKE =====
        const now = Date.now();
        const stake = await ReserveStakeModel.create({
            userId: req.userId,
            address: user.walletAddress,
            poolKey,
            poolName: pool.name,
            amount: stakeAmount,
            apr: pool.apr,
            seconds: pool.seconds,
            startTime: new Date(now),
            endTime: new Date(now + pool.seconds * 1000),
            status: 'active',
            txHash: txId
        });

        // ===== ATUALIZA ESTATÍSTICAS DO FUNDO =====
        const reserve = await ReserveModel.getReserve();
        reserve.totalStakes += 1;
        await reserve.save();

        res.json({
            success: true,
            message: `Stake de ${stakeAmount} BRD criado em ${pool.name}`,
            data: {
                stake: {
                    id: stake._id,
                    pool: stake.poolName,
                    amount: stake.amount,
                    apr: stake.apr,
                    seconds: stake.seconds,
                    startTime: stake.startTime,
                    endTime: stake.endTime,
                    expectedReward: stake.getExpectedReward(),
                    status: stake.status,
                    txHash: stake.txHash
                }
            }
        });
    })
);

// ============================================
// POST /api/v1/reserve-staking/unstake
// Libera o stake + recompensa
// ============================================

router.post(
    '/unstake',
    authenticate,
    asyncHandler(async (req, res) => {
        const user = await User.findById(req.userId);
        if (!user || !user.walletAddress) {
            return res.status(404).json({
                success: false,
                error: 'Você precisa ter uma carteira'
            });
        }

        // ===== PEGA STAKE ATIVO =====
        const stake = await ReserveStakeModel.getActiveStake(req.userId);
        if (!stake) {
            return res.status(404).json({
                success: false,
                error: 'Você não tem stake ativo'
            });
        }

        // ===== VERIFICA SE JÁ PODE SACAR =====
        if (!stake.isReady()) {
            const remaining = stake.getTimeRemaining();
            return res.status(400).json({
                success: false,
                error: `Stake ainda bloqueado. Faltam ${Math.ceil(remaining / 1000)} segundos`,
                data: {
                    remainingMs: remaining,
                    endTime: stake.endTime
                }
            });
        }

        // ===== CALCULA RECOMPENSA =====
        const reward = stake.getExpectedReward();
        const totalReturn = stake.amount + reward;

        // ===== CRÉDITO DO PRINCIPAL =====
        const txId1 = generateTxId();
        await blockchain.addTransaction({
            fromAddress: 'Br7ReserveA9k2M8pQ5tN1vB4cD6wE0yU3iL',
            toAddress: user.walletAddress,
            amount: stake.amount,
            fee: 0,
            timestamp: new Date().toISOString(),
            type: 'reserve_unstake',
            txId: txId1
        });

        // ===== CRÉDITO DA RECOMPENSA =====
        const txId2 = generateTxId();
        await blockchain.addTransaction({
            fromAddress: null, // sistema
            toAddress: user.walletAddress,
            amount: reward,
            fee: 0,
            timestamp: new Date().toISOString(),
            type: 'reserve_reward',
            txId: txId2
        });

        // ===== ATUALIZA O STAKE =====
        stake.status = 'completed';
        stake.reward = reward;
        stake.totalReturn = totalReturn;
        stake.completedAt = new Date();
        await stake.save();

        // ===== ATUALIZA ESTATÍSTICAS DO FUNDO =====
        await ReserveModel.recordReward(reward);

        res.json({
            success: true,
            message: `Unstake realizado! ${totalReturn.toFixed(4)} BRD creditado`,
            data: {
                stakeId: stake._id,
                principal: stake.amount,
                reward,
                totalReturn,
                txIdPrincipal: txId1,
                txIdReward: txId2,
                newBalance: 'Consulta /api/v1/wallet/balance'
            }
        });
    })
);

// ============================================
// GET /api/v1/reserve-staking/stakes
// Lista stakes do usuário
// ============================================

router.get(
    '/stakes',
    authenticate,
    asyncHandler(async (req, res) => {
        const limit = parseInt(req.query.limit) || 20;
        const stakes = await ReserveStakeModel.getUserStakes(req.userId, limit);

        const formatted = stakes.map((s) => ({
            id: s._id,
            pool: s.poolName,
            poolKey: s.poolKey,
            amount: s.amount,
            apr: s.apr,
            seconds: s.seconds,
            startTime: s.startTime,
            endTime: s.endTime,
            status: s.status,
            reward: s.reward,
            totalReturn: s.totalReturn,
            txHash: s.txHash,
            completedAt: s.completedAt,
            createdAt: s.createdAt
        }));

        res.json({
            success: true,
            data: {
                stakes: formatted,
                count: formatted.length
            }
        });
    })
);

// ============================================
// GET /api/v1/reserve-staking/active
// Stake ativo atual
// ============================================

router.get(
    '/active',
    authenticate,
    asyncHandler(async (req, res) => {
        const stake = await ReserveStakeModel.getActiveStake(req.userId);

        if (!stake) {
            return res.json({
                success: true,
                data: { active: null }
            });
        }

        res.json({
            success: true,
            data: {
                active: {
                    id: stake._id,
                    pool: stake.poolName,
                    poolKey: stake.poolKey,
                    amount: stake.amount,
                    apr: stake.apr,
                    seconds: stake.seconds,
                    startTime: stake.startTime,
                    endTime: stake.endTime,
                    status: stake.status,
                    expectedReward: stake.getExpectedReward(),
                    progress: stake.getProgress(),
                    timeRemaining: stake.getTimeRemaining(),
                    isReady: stake.isReady(),
                    txHash: stake.txHash
                }
            }
        });
    })
);

// ============================================
// EXPORTS
// ============================================

module.exports = router;
