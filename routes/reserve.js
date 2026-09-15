// routes/reserve.js
// ============================================
// Rotas do Fundo de Reserva - BradiChain (v2.0)
// ============================================
// ⚠️ Só admin pode chamar.
// 🔐 Não-custodial: o servidor NUNCA vê a privateKey do Reserve.
//     A página do Reserve assina localmente e envia a TX assinada.
// ============================================

const express = require('express');
const router = express.Router();

const { ReserveModel, RESERVE_ADDRESS } = require('../models/Reserve');
const WalletModel = require('../models/Wallet');
const wallet = require('../wallet');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../middleware/error');

// ============================================
// GET /api/v1/reserve/stats
// ============================================
router.get(
    '/stats',
    asyncHandler(async (req, res) => {
        const info = await ReserveModel.getInfo();

        res.json({
            success: true,
            data: info
        });
    })
);

// ============================================
// GET /api/v1/reserve/address
// ============================================
router.get(
    '/address',
    asyncHandler(async (req, res) => {
        res.json({
            success: true,
            data: { address: RESERVE_ADDRESS }
        });
    })
);

// ============================================
// GET /api/v1/reserve/balance/:address
// ============================================
router.get(
    '/balance/:address',
    asyncHandler(async (req, res) => {
        const { address } = req.params;

        if (!wallet.isValidAddress(address)) {
            throw new AppError('Endereço inválido', 400);
        }

        const walletDoc = await WalletModel.findOne({ address }).select(
            'address balance nonce status'
        ).lean();

        if (!walletDoc) {
            throw new AppError('Carteira não encontrada', 404);
        }

        res.json({
            success: true,
            data: {
                address: walletDoc.address,
                balance: walletDoc.balance.toString(),
                nonce: walletDoc.nonce,
                status: walletDoc.status
            }
        });
    })
);

// ============================================
// GET /api/v1/reserve/nonce
// ============================================
// ⚠️ A página do Reserve precisa disso para assinar a próxima TX
//
router.get(
    '/nonce',
    asyncHandler(async (req, res) => {
        const walletDoc = await WalletModel.findOne({ address: RESERVE_ADDRESS })
            .select('nonce')
            .lean();

        if (!walletDoc) {
            throw new AppError('Reserve não encontrado no banco', 404);
        }

        res.json({
            success: true,
            data: {
                address: RESERVE_ADDRESS,
                nonce: walletDoc.nonce
            }
        });
    })
);

// ============================================
// POST /api/v1/reserve/send
// ============================================
// ⚠️ NÃO USAR — use /api/v1/admin/reserve/send
// (que já está no server.js)
//
// Essa rota foi substituída pela do server.js que verifica
// assinatura local. Mantida apenas como compatibilidade.
//
router.post(
    '/send',
    authenticate,
    requireAdmin,
    asyncHandler(async (req, res) => {
        throw new AppError(
            'Use /api/v1/admin/reserve/send — a TX precisa ser assinada localmente',
            410
        );
    })
);

// ============================================
// EXPORTS
// ============================================
module.exports = router;
