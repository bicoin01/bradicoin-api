// routes/adminAirdrop.js
// ============================================
// Admin Airdrop Routes — BradiChain
// ============================================
// Endpoints protegidos por X-Admin-Key para gerenciar o pool de airdrop.
//
// Rotas:
//   POST   /api/v1/admin/airdrop/deposit   → adiciona BRD ao pool
//   POST   /api/v1/admin/airdrop/pause     → pausa o airdrop
//   POST   /api/v1/admin/airdrop/resume    → retoma o airdrop
//   GET    /api/v1/admin/airdrop/status    → consulta estado do pool
//
// Todas exigem o header:
//   X-Admin-Key: <valor de ADMIN_API_KEY no .env>
// ============================================

const express = require('express');
const router = express.Router();

const AirdropPool = require('../models/AirdropPool');
const { asyncHandler, AppError } = require('../middleware/error');
const { requireAdmin } = require('../middleware/adminAuth');

// Mesma campanha usada pelo airdropController
const CAMPAIGN = 'bradicoin-genesis';

// ============================================
// POST /api/v1/admin/airdrop/deposit
// Body: { amount: number, note?: string }
// ============================================
router.post(
    '/deposit',
    requireAdmin,
    asyncHandler(async (req, res) => {
        const rawAmount = req.body?.amount;
        const amount = Number(rawAmount);
        const note = (req.body?.note || 'Manual deposit').toString().slice(0, 200);

        // Validação
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new AppError('amount inválido. Deve ser um número > 0.', 400);
        }

        // Limite de segurança: 1 bilhão de BRD por depósito
        if (amount > 1_000_000_000) {
            throw new AppError('amount excede o limite máximo (1.000.000.000 BRD)', 400);
        }

        // Adiciona ao pool (cria se não existir)
        const pool = await AirdropPool.deposit(CAMPAIGN, amount, 'admin', note);

        console.log(
            `💰 Admin depositou +${amount} BRD no pool. ` +
            `Total depositado: ${pool.totalDeposited} | Restante: ${pool.remaining()}`
        );

        res.json({
            success: true,
            message: `+${amount} BRD adicionados ao pool`,
            data: {
                campaign: pool.campaign,
                totalDeposited: pool.totalDeposited,
                totalDistributed: pool.totalDistributed,
                remaining: pool.remaining(),
                enabled: pool.enabled,
                lastDepositAt: pool.lastDepositAt
            }
        });
    })
);

// ============================================
// POST /api/v1/admin/airdrop/pause
// Desabilita o airdrop sem zerar o saldo.
// ============================================
router.post(
    '/pause',
    requireAdmin,
    asyncHandler(async (req, res) => {
        const pool = await AirdropPool.setEnabled(CAMPAIGN, false);
        if (!pool) {
            throw new AppError('Pool não encontrado para esta campanha', 404);
        }

        console.log(`⏸️ Airdrop pausado pelo admin. Restante: ${pool.remaining()}`);

        res.json({
            success: true,
            message: 'Airdrop pausado',
            data: {
                campaign: pool.campaign,
                enabled: pool.enabled,
                remaining: pool.remaining()
            }
        });
    })
);

// ============================================
// POST /api/v1/admin/airdrop/resume
// Reativa o airdrop.
// ============================================
router.post(
    '/resume',
    requireAdmin,
    asyncHandler(async (req, res) => {
        const pool = await AirdropPool.setEnabled(CAMPAIGN, true);
        if (!pool) {
            throw new AppError('Pool não encontrado para esta campanha', 404);
        }

        console.log(`▶️ Airdrop retomado pelo admin. Restante: ${pool.remaining()}`);

        res.json({
            success: true,
            message: 'Airdrop retomado',
            data: {
                campaign: pool.campaign,
                enabled: pool.enabled,
                remaining: pool.remaining()
            }
        });
    })
);

// ============================================
// GET /api/v1/admin/airdrop/status
// Consulta estado atual do pool.
// ============================================
router.get(
    '/status',
    requireAdmin,
    asyncHandler(async (req, res) => {
        const pool = await AirdropPool.findByCampaign(CAMPAIGN);

        if (!pool) {
            return res.json({
                success: true,
                data: {
                    exists: false,
                    message:
                        'Pool ainda não criado. Faça o primeiro claim ou um deposit para criá-lo.'
                }
            });
        }

        res.json({
            success: true,
            data: {
                exists: true,
                campaign: pool.campaign,
                enabled: pool.enabled,
                totalDeposited: pool.totalDeposited,
                totalDistributed: pool.totalDistributed,
                remaining: pool.remaining(),
                lastDepositAt: pool.lastDepositAt,
                lastDistributedAt: pool.lastDistributedAt,
                totalDepositsCount: (pool.deposits || []).length
            }
        });
    })
);

// ============================================
// EXPORTS — ⚠️ padrão { router }
// ============================================
module.exports = { router };
