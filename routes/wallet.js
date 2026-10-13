// routes/wallet.js
// ============================================
// Rotas de carteira - BradiChain (v2.1)
// ============================================
// 🔐 NÃO-CUSTODIAL: o cliente gera a chave e envia
// apenas publicKey + address. O servidor NUNCA vê a privateKey.
//
// 📝 v2.1 — Correções:
//   [1] /balance/:address agora retorna 404 se wallet não existe
//   [2] /history/:address agora retorna 404 se wallet não existe
//   [3] Normalização de endereço (case-insensitive) em todas as rotas
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
// 📝 v2.1 — Retorna 404 quando a wallet não existe
// ============================================
router.get(
    '/balance/:address',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const { address } = req.params;

        // Valida formato
        if (!wallet.isValidAddress(address)) {
            throw new AppError('Endereço inválido (deve começar com "Br" e ter 40 caracteres)', 400);
        }

        // Normaliza (case-insensitive)
        const normalized = wallet.normalizeAddress
            ? wallet.normalizeAddress(address)
            : address;

        const result = await wallet.getBalance(normalized);

        // ✅ NOVO: se a wallet não existe, retorna 404
        if (result.exists === false) {
            return res.status(404).json({
                success: false,
                error: 'Wallet not found',
                address: result.address
            });
        }

        res.json({
            success: true,
            data: result
        });
    })
);

// ============================================
// GET /api/v1/wallet/history/:address
// ============================================
// 📝 v2.1 — Retorna 404 quando a wallet não existe
// ============================================
router.get(
    '/history/:address',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const { address } = req.params;
        const { limit = 50 } = req.query;

        // Valida formato
        if (!wallet.isValidAddress(address)) {
            throw new AppError('Endereço inválido (deve começar com "Br" e ter 40 caracteres)', 400);
        }

        // Normaliza (case-insensitive)
        const normalized = wallet.normalizeAddress
            ? wallet.normalizeAddress(address)
            : address;

        // ✅ NOVO: verifica se a wallet existe antes de buscar histórico
        const balance = await wallet.getBalance(normalized);
        if (balance.exists === false) {
            return res.status(404).json({
                success: false,
                error: 'Wallet not found',
                address: balance.address
            });
        }

        const limitNum = Math.min(Math.max(1, parseInt(limit) || 50), 100);

        const result = await wallet.getHistory(normalized, limitNum);

        res.json({
            success: true,
            data: {
                address: normalized,
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
// (já retornava 404 corretamente — mantido)
// ============================================
router.get(
    '/nonce/:address',
    queryLimiter,
    asyncHandler(async (req, res) => {
        const { address } = req.params;

        if (!wallet.isValidAddress(address)) {
            throw new AppError('Endereço inválido (deve começar com "Br" e ter 40 caracteres)', 400);
        }

        // Normaliza (case-insensitive)
        const normalized = wallet.normalizeAddress
            ? wallet.normalizeAddress(address)
            : address;

        const walletDoc = await WalletModel.findOne({ address: normalized })
            .select('nonce status')
            .lean();

        if (!walletDoc) {
            return res.status(404).json({
                success: false,
                error: 'Wallet not found',
                address: normalized
            });
        }

        res.json({
            success: true,
            data: {
                address: normalized,
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
            throw new AppError('Endereço inválido (deve começar com "Br" e ter 40 caracteres)', 400);
        }

        // Normaliza (case-insensitive)
        const normalized = wallet.normalizeAddress
            ? wallet.normalizeAddress(address)
            : address;

        const publicKey = await wallet.getPublicKey(normalized);

        if (!publicKey) {
            return res.status(404).json({
                success: false,
                error: 'Wallet not found',
                address: normalized
            });
        }

        res.json({
            success: true,
            data: {
                address: normalized,
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
