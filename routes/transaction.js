// routes/transaction.js
// ============================================
// Rotas de transação - BradiChain (v2.0)
// ============================================
// 🔐 NÃO-CUSTODIAL: o cliente assina a TX e envia
// apenas { fromAddress, toAddress, amount, nonce, signature, publicKey }.
// O servidor verifica a assinatura antes de aceitar.
// ============================================

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const transactions = require('../transactions');
const wallet = require('../wallet');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../middleware/error');

// ============================================
// RATE LIMITERS
// ============================================

const submitLimiter = rateLimit({
    windowMs: 60 * 1000, // 1min
    max: 20,
    keyGenerator: (req) => req.user?._id?.toString() || req.ip,
    message: { success: false, error: 'Muitas transações. Aguarde 1 minuto.' }
});

const queryLimiter = rateLimit({
    windowMs: 60 * 1000, // 1min
    max: 60,
    message: { success: false, error: 'Muitas consultas. Aguarde um instante.' }
});

// ============================================
// POST /api/v1/transaction/submit
// ============================================
// ⚠️ ÚNICA rota que cria transações.
//
// Body esperado:
//   {
//     fromAddress, toAddress, amount, fee, nonce, timestamp,
//     type, signature, publicKey
//   }
//
// ⚠️ O cliente DEVE assinar a TX localmente com a privateKey.
// O servidor verifica a assinatura e NUNCA vê a privateKey.
//
router.post(
    '/submit',
    authenticate,
    submitLimiter,
    asyncHandler(async (req, res) => {
        const {
            fromAddress,
            toAddress,
            amount,
            fee,
            nonce,
            timestamp,
            type,
            signature,
            publicKey
        } = req.body;

        // 1. Validações de campos obrigatórios
        if (!fromAddress || !toAddress || amount === undefined) {
            throw new AppError('fromAddress, toAddress e amount são obrigatórios', 400);
        }

        if (!signature || !publicKey) {
            throw new AppError('signature e publicKey são obrigatórios', 400);
        }

        // 2. Verifica que o usuário autenticado é o dono da carteira
        if (req.user.walletAddress !== fromAddress) {
            throw new AppError('Você só pode enviar transações da sua própria carteira', 403);
        }

        // 3. Submete (o transactions.js faz todas as validações)
        const result = await transactions.submitSignedTransaction({
            fromAddress,
            toAddress,
            amount,
            fee: fee || '0',
            nonce,
            timestamp,
            type: type || 'transfer',
            signature,
            publicKey
        });

        res.json({
            success: true,
            data: result
        });
    })
);

// ============================================
// GET /api/v1/transaction/stats
// ============================================
// ⚠️ CUIDADO: registre /stats ANTES de /:hash
// senão o Express interpreta "stats" como um hash.
//
router.get(
    '/stats',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const stats = await transactions.getTransactionStats();
        res.json({
            success: true,
            data: stats
        });
    })
);

// ============================================
// GET /api/v1/transaction/:hash
// ============================================
router.get(
    '/:hash',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const { hash } = req.params;

        // Valida formato (SHA-256 = 64 hex)
        if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
            throw new AppError('Hash inválido', 400);
        }

        const tx = await transactions.getTransactionByHash(hash);

        res.json({
            success: true,
            data: tx
        });
    })
);

// ============================================
// EXPORTS
// ============================================
module.exports = router;
