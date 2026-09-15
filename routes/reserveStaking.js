// routes/reserveStaking.js
// ============================================
// Staking do Fundo de Reserva - BradiChain (v2.0)
// ============================================
// ⚠️ USO PESSOAL — APRs altos (130% / 50%) mantidos.
// Em produção pública, reduzir para 5-15%.
// ============================================

const express = require('express');
const router = express.Router();
const { Decimal128 } = require('mongoose').Schema.Types;

const { ReserveModel } = require('../models/Reserve');
const { ReserveStakeModel, POOLS } = require('../models/ReserveStake');
const WalletModel = require('../models/Wallet');
const wallet = require('../wallet');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../middleware/error');

// ============================================
// GET /api/v1/reserve-staking/pools
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
            maxStake: p.maxStake,
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
// ============================================
// ⚠️ Lógica:
//   1. Debita do saldo do usuário (atomic)
//   2. Credita no Reserve (atomic)
//   3. Cria registro de stake
//
router.post(
    '/stake',
    authenticate,
    asyncHandler(async (req, res) => {
        const { amount, poolKey } = req.body;

        // ===== VALIDAÇÕES =====
        if (!amount || !poolKey) {
            throw new AppError('Valor e pool são obrigatórios', 400);
        }

        const pool = POOLS[poolKey];
        if (!pool) {
            throw new AppError('Pool inválido', 400);
        }

        const amountNum = parseFloat(amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            throw new AppError('Valor inválido', 400);
        }

        const minStake = parseFloat(pool.minStake);
        if (amountNum < minStake) {
            throw new AppError(`Mínimo para ${pool.name}: ${minStake} BRD`, 400);
        }

        const maxStake = parseFloat(pool.maxStake);
        if (amountNum > maxStake) {
            throw new AppError(`Máximo para ${pool.name}: ${maxStake} BRD`, 400);
        }

        // ===== CARREGA WALLET DO USUÁRIO =====
        const userWallet = await WalletModel.findOne({
            userId: req.user._id,
            status: 'active'
        });

        if (!userWallet) {
            throw new AppError('Você precisa ter uma carteira ativa', 404);
        }

        // ===== VERIFICA SE JÁ TEM STAKE ATIVO =====
        const existing = await ReserveStakeModel.getActiveStake(req.user._id);
        if (existing) {
            throw new AppError(
                'Você já tem um stake ativo. Faça unstake antes de criar outro.',
                409
            );
        }

        // ===== VERIFICA SALDO =====
        const balanceNum = parseFloat(userWallet.balance.toString());
        if (balanceNum < amountNum) {
            throw new AppError(`Saldo insuficiente: ${balanceNum} BRD`, 400);
        }

        // ===== DEBITA DO USUÁRIO (atomic) =====
        const amountStr = amountNum.toString();
        await WalletModel.debit(userWallet.address, amountStr);

        // ===== CREDITA NO RESERVE (atomic) =====
        await ReserveModel.receiveStake(amountStr);

        // ===== CRIA REGISTRO DE STAKE =====
        const now = Date.now();
        const stake = await ReserveStakeModel.create({
            userId: req.user._id,
            address: userWallet.address,
            poolKey,
            poolName: pool.name,
            amount: Decimal128.fromString(amountStr),
            apr: pool.apr,
            seconds: pool.seconds,
            startTime: new Date(now),
            endTime: new Date(now + pool.seconds * 1000),
            status: 'active'
        });

        res.json({
            success: true,
            message: `Stake de ${amountNum} BRD criado em ${pool.name}`,
            data: {
                stake: {
                    id: stake._id,
                    pool: stake.poolName,
                    poolKey: stake.poolKey,
                    amount: stake.amount.toString(),
                    apr: stake.apr,
                    seconds: stake.seconds,
                    startTime: stake.startTime,
                    endTime: stake.endTime,
                    expectedReward: stake.getExpectedReward().toString(),
                    status: stake.status
                }
            }
        });
    })
);

// ============================================
// POST /api/v1/reserve-staking/unstake
// ============================================
router.post(
    '/unstake',
    authenticate,
    asyncHandler(async (req, res) => {
        // ===== PEGA STAKE ATIVO =====
        const stake = await ReserveStakeModel.getActiveStake(req.user._id);
        if (!stake) {
            throw new AppError('Você não tem stake ativo', 404);
        }

        // ===== VERIFICA SE JÁ PODE SACAR =====
        if (!stake.isReady()) {
            const remaining = stake.getTimeRemaining();
            throw new AppError(
                `Stake ainda bloqueado. Faltam ${Math.ceil(remaining / 1000)} segundos`,
                400
            );
        }

        // ===== CALCULA RECOMPENSA =====
        const rewardNum = parseFloat(stake.getExpectedReward());
        const principalNum = parseFloat(stake.amount.toString());
        const totalReturn = principalNum + rewardNum;

        const principalStr = principalNum.toString();
        const rewardStr = rewardNum.toFixed(8);

        // ===== DEBITA PRINCIPAL + REWARD DO RESERVE =====
        const totalStr = (principalNum + rewardNum).toFixed(8);
        await ReserveModel.debit(totalStr, 'reward');

        // ===== CREDITA NO USUÁRIO (atomic) =====
        await WalletModel.credit(stake.address, principalStr);
        if (rewardNum > 0) {
            await WalletModel.credit(stake.address, rewardStr);
        }

        // ===== ATUALIZA O STAKE =====
        stake.status = 'completed';
        stake.reward = Decimal128.fromString(rewardStr);
        stake.totalReturn = Decimal128.fromString(totalStr);
        stake.rewardPaid = true;
        stake.completedAt = new Date();
        await stake.save();

        res.json({
            success: true,
            message: `Unstake realizado! ${totalReturn.toFixed(4)} BRD creditado`,
            data: {
                stakeId: stake._id,
                principal: principalStr,
                reward: rewardStr,
                totalReturn: totalStr,
                newBalance: 'Consulte /api/v1/wallet/balance/' + stake.address
            }
        });
    })
);

// ============================================
// GET /api/v1/reserve-staking/stakes
// ============================================
router.get(
    '/stakes',
    authenticate,
    asyncHandler(async (req, res) => {
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const stakes = await ReserveStakeModel.getUserStakes(req.user._id, limit);

        const formatted = stakes.map((s) => ({
            id: s._id,
            pool: s.poolName,
            poolKey: s.poolKey,
            amount: s.amount?.toString() || '0',
            apr: s.apr,
            seconds: s.seconds,
            startTime: s.startTime,
            endTime: s.endTime,
            status: s.status,
            reward: s.reward?.toString() || '0',
            totalReturn: s.totalReturn?.toString() || '0',
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
// ============================================
router.get(
    '/active',
    authenticate,
    asyncHandler(async (req, res) => {
        const stake = await ReserveStakeModel.getActiveStake(req.user._id);

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
                    amount: stake.amount.toString(),
                    apr: stake.apr,
                    seconds: stake.seconds,
                    startTime: stake.startTime,
                    endTime: stake.endTime,
                    status: stake.status,
                    expectedReward: stake.getExpectedReward().toString(),
                    progress: stake.getProgress(),
                    timeRemaining: stake.getTimeRemaining(),
                    isReady: stake.isReady()
                }
            }
        });
    })
);

// ============================================
// GET /api/v1/reserve-staking/stats
// ============================================
router.get(
    '/stats',
    asyncHandler(async (req, res) => {
        const stats = await ReserveStakeModel.getStats();
        res.json({
            success: true,
            data: stats
        });
    })
);

// ============================================
// EXPORTS
// ============================================
module.exports = router;
