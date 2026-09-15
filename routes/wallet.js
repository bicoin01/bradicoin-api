// routes/wallet.js
// ============================================
// Rotas de carteira - BradiChain (v2.0)
// ============================================
// 🔐 NÃO-CUSTODIAL: o cliente gera a chave e envia
// apenas publicKey + address. O servidor NUNCA vê a privateKey.
// ============================================

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const wallet = require('../wallet');
const WalletModel = require('../models/Wallet');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../middleware/error');

// ============================================
// RATE LIMITERS
// ============================================

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1h
    max: 5,
    message: { success: false, error: 'Muitas carteiras criadas. Tente novamente em 1 hora.' }
});

const queryLimiter = rateLimit({
    windowMs: 60 * 1000, // 1min
    max: 60,
    message: { success: false, error: 'Muitas consultas. Aguarde um instante.' }
});

// ============================================
// POST /api/v1/wallet/register
// ============================================
// Registra uma carteira nova. O cliente gera:
//   - privateKey (fica só no cliente)
//   - publicKey (envia)
//   - address (envia — derivado da publicKey)
//
router.post(
    '/register',
    authenticate,
    registerLimiter,
    asyncHandler(async (req, res) => {
        const { address, publicKey } = req.body;

        if (!address || !publicKey) {
            throw new AppError('address e publicKey são obrigatórios', 400);
        }

        // Chama a função do wallet.js (que valida + registra)
        const result = await wallet.registerWallet({
            address,
            publicKey,
            userId: req.user._id,
            username: req.user.username
        });

        // Vincula a carteira ao usuário
        await User.findByIdAndUpdate(
            req.user._id,
            { walletAddress: result.address }
        );

        res.status(201).json({
            success: true,
            message: 'Carteira registrada com sucesso',
            data: result
        });
    })
);

// ============================================
// GET /api/v1/wallet/balance/:address
// ============================================
router.get(
    '/balance/:address',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const { address } = req.params;

        if (!wallet.isValidAddress(address)) {
            throw new AppError('Endereço inválido', 400);
        }

        const result = await wallet.getBalance(address);

        res.json({
            success: true,
            data: result
        });
    })
);

// ============================================
// GET /api/v1/wallet/history/:address
// ============================================
router.get(
    '/history/:address',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const { address } = req.params;
        const { limit = 50 } = req.query;

        if (!wallet.isValidAddress(address)) {
            throw new AppError('Endereço inválido', 400);
        }

        const limitNum = Math.min(Math.max(1, parseInt(limit) || 50), 100);

        const result = await wallet.getHistory(address, limitNum);

        res.json({
            success: true,
            data: {
                address,
                transactions: result,
                count: result.length
            }
        });
    })
);

// ============================================
// GET /api/v1/wallet/nonce/:address
// ============================================
// ⚠️ CRÍTICO: o cliente precisa disso para assinar a próxima TX
//
router.get(
    '/nonce/:address',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const { address } = req.params;

        if (!wallet.isValidAddress(address)) {
            throw new AppError('Endereço inválido', 400);
        }

        const walletDoc = await WalletModel.findOne({ address })
            .select('nonce status')
            .lean();

        if (!walletDoc) {
            throw new AppError('Carteira não encontrada', 404);
        }

        res.json({
            success: true,
            data: {
                address,
                nonce: walletDoc.nonce,
                status: walletDoc.status
            }
        });
    })
);

// ============================================
// GET /api/v1/wallet/public-key/:address
// ============================================
router.get(
    '/public-key/:address',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const { address } = req.params;

        if (!wallet.isValidAddress(address)) {
            throw new AppError('Endereço inválido', 400);
        }

        const publicKey = await wallet.getPublicKey(address);

        if (!publicKey) {
            throw new AppError('Carteira não encontrada', 404);
        }

        res.json({
            success: true,
            data: {
                address,
                publicKey
            }
        });
    })
);

// ============================================
// GET /api/v1/wallet/me
// ============================================
router.get(
    '/me',
    authenticate,
    asyncHandler(async (req, res) => {
        const walletDoc = await WalletModel.findOne({ userId: req.user._id });

        if (!walletDoc) {
            return res.json({
                success: true,
                data: null,
                message: 'Usuário ainda não tem carteira'
            });
        }

        res.json({
            success: true,
            data: walletDoc.toPublic()
        });
    })
);

// ============================================
// GET /api/v1/wallet/stats
// ============================================
router.get(
    '/stats',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const stats = await wallet.getNetworkStats();
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
