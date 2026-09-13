// routes/wallet.js
// ============================================
// Rotas de wallet - Bradicoin (integração blockchain + auth)
// ============================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const blockchainWallet = require('../wallet'); // ← seu wallet.js da raiz
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');

// ============================================
// CONFIGURAÇÕES
// ============================================

const FEE_AMOUNT = 0.015;         // Fee fixa por envio (0.015 BRD)
const MIN_SEND = 0.17;            // Mínimo para enviar
const AIRDROP_ENABLED = false;    // ⏸️ DESATIVADO — você ativa depois
const AIRDROP_MIN = 5;
const AIRDROP_MAX = 15;
const AIRDROP_COOLDOWN_HOURS = 6;

// ============================================
// HELPERS
// ============================================

function round8(n) {
    return Math.round(n * 100000000) / 100000000;
}

function generateTxId() {
    return 'tx_' + crypto.randomBytes(16).toString('hex');
}

// Vincula um user do auth com uma wallet do blockchain wallet.js
async function getOrCreateUserWallet(userId) {
    let walletDoc = await Wallet.findOne({ userId });

    if (!walletDoc) {
        // Cria nova wallet via wallet.js (que já salva no Mongo + gera endereço)
        const user = await User.findById(userId);
        const username = user.username + '_' + userId.toString().slice(-6);

        const result = await blockchainWallet.createWallet(username);

        // Atualiza o WalletModel com o userId (vinculação)
        walletDoc = await Wallet.findOneAndUpdate(
            { address: result.address },
            { $set: { userId } },
            { new: true }
        );

        // Vincula ao User também
        await User.findByIdAndUpdate(userId, {
            $set: { walletAddress: result.address }
        });
    }

    return walletDoc;
}

// ============================================
// POST /api/v1/wallet/create
// Cria carteira pro usuário logado
// ============================================

router.post(
    '/create',
    authenticate,
    asyncHandler(async (req, res) => {
        // Verifica se já tem
        const existing = await Wallet.findOne({ userId: req.userId });
        if (existing) {
            return res.status(409).json({
                success: false,
                error: 'Você já tem uma carteira',
                data: { wallet: formatWallet(existing) }
            });
        }

        // Cria via wallet.js (blockchain + Mongo)
        const user = await User.findById(req.userId);
        const username = user.username + '_' + req.userId.toString().slice(-6);

        const result = await blockchainWallet.createWallet(username);

        // Vincula userId
        const walletDoc = await Wallet.findOneAndUpdate(
            { address: result.address },
            { $set: { userId: req.userId } },
            { new: true }
        );

        // Vincula ao User
        await User.findByIdAndUpdate(req.userId, {
            $set: { walletAddress: result.address }
        });

        res.status(201).json({
            success: true,
            message: 'Carteira criada com sucesso',
            data: {
                wallet: formatWallet(walletDoc),
                initialBalance: result.initialBalance,
                note: result.note
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
        const walletDoc = await getOrCreateUserWallet(req.userId);

        // Pega saldo REAL da blockchain
        const balanceData = await blockchainWallet.getBalance(walletDoc.address);

        res.json({
            success: true,
            data: {
                wallet: {
                    address: walletDoc.address,
                    username: walletDoc.username,
                    publicKey: walletDoc.publicKey,
                    createdAt: walletDoc.createdAt
                },
                balance: {
                    confirmed: balanceData.balance,
                    pending: balanceData.pending,
                    total: balanceData.total
                }
            }
        });
    })
);

// ============================================
// GET /api/v1/wallet/address
// ============================================

router.get(
    '/address',
    authenticate,
    asyncHandler(async (req, res) => {
        const walletDoc = await getOrCreateUserWallet(req.userId);

        res.json({
            success: true,
            data: { address: walletDoc.address }
        });
    })
);

// ============================================
// GET /api/v1/wallet/balance
// ============================================

router.get(
    '/balance',
    authenticate,
    asyncHandler(async (req, res) => {
        const walletDoc = await getOrCreateUserWallet(req.userId);
        const balanceData = await blockchainWallet.getBalance(walletDoc.address);

        res.json({
            success: true,
            data: {
                address: walletDoc.address,
                confirmed: balanceData.balance,
                pending: balanceData.pending,
                total: balanceData.total,
                exists: balanceData.exists
            }
        });
    })
);

// ============================================
// POST /api/v1/wallet/send
// ============================================

router.post(
    '/send',
    authenticate,
    asyncHandler(async (req, res) => {
        const { to, amount, message } = req.body;

        // ===== VALIDAÇÕES =====
        if (!to || amount === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Destinatário e valor são obrigatórios'
            });
        }

        const sendAmount = parseFloat(amount);

        if (isNaN(sendAmount) || sendAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Valor inválido'
            });
        }

        if (sendAmount < MIN_SEND) {
            return res.status(400).json({
                success: false,
                error: `Valor mínimo para enviar é ${MIN_SEND} BRD`
            });
        }

        // Valida endereço de destino
        if (!blockchainWallet.isValidAddress(to)) {
            return res.status(400).json({
                success: false,
                error: 'Endereço de destino inválido'
            });
        }

        // Pega carteira do remetente
        const fromWallet = await getOrCreateUserWallet(req.userId);

        if (fromWallet.address === to) {
            return res.status(400).json({
                success: false,
                error: 'Você não pode enviar para si mesmo'
            });
        }

        // Verifica se destinatário existe
        const toWalletExists = await Wallet.findOne({ address: to });
        if (!toWalletExists) {
            return res.status(404).json({
                success: false,
                error: 'Endereço de destino não encontrado'
            });
        }

        // ===== VERIFICA SALDO =====
        const balanceData = await blockchainWallet.getBalance(fromWallet.address);
        const totalDebit = round8(sendAmount + FEE_AMOUNT);

        if (balanceData.total < totalDebit) {
            return res.status(400).json({
                success: false,
                error: `Saldo insuficiente. Necessário: ${totalDebit} BRD. Você tem: ${balanceData.total} BRD`
            });
        }

        // ===== ADICIONA NA BLOCKCHAIN =====
        const txId = generateTxId();

        // Transação principal (envio)
        await blockchainWallet.addTransaction({
            fromAddress: fromWallet.address,
            toAddress: to,
            amount: sendAmount,
            fee: FEE_AMOUNT,
            timestamp: new Date().toISOString(),
            type: 'transfer',
            txId,
            message: message || null
        });

        // Transação de fee (se quiser registrar)
        // (opcional - você pode remover isso se não quiser)

        res.json({
            success: true,
            message: `Transação enviada. Aguardando confirmação na blockchain...`,
            data: {
                txId,
                from: fromWallet.address,
                to,
                amount: sendAmount,
                fee: FEE_AMOUNT,
                totalDebit,
                status: 'pending',
                note: 'A transação será confirmada em até 30 segundos quando o próximo bloco for minerado'
            }
        });
    })
);

// ============================================
// GET /api/v1/wallet/history
// ============================================

router.get(
    '/history',
    authenticate,
    asyncHandler(async (req, res) => {
        const walletDoc = await getOrCreateUserWallet(req.userId);
        const limit = parseInt(req.query.limit) || 50;

        const history = await blockchainWallet.getHistory(walletDoc.address, limit);

        // Formata pro frontend
        const formatted = history.map((tx) => {
            const isSent = tx.fromAddress === walletDoc.address;
            return {
                txId: tx.txId || null,
                type: isSent ? 'sent' : 'received',
                direction: isSent ? 'out' : 'in',
                from: tx.fromAddress || 'SYSTEM',
                to: tx.toAddress,
                amount: tx.amount,
                fee: tx.fee || 0,
                message: tx.message || null,
                confirmed: tx.confirmed,
                blockIndex: tx.blockIndex || null,
                createdAt: tx.timestamp
            };
        });

        res.json({
            success: true,
            data: {
                address: walletDoc.address,
                transactions: formatted,
                count: formatted.length
            }
        });
    })
);

// ============================================
// POST /api/v1/wallet/airdrop
// (DESATIVADO por enquanto)
// ============================================

router.post(
    '/airdrop',
    authenticate,
    asyncHandler(async (req, res) => {
        if (!AIRDROP_ENABLED) {
            return res.status(403).json({
                success: false,
                error: 'Airdrop temporariamente desativado. Volte em breve!',
                code: 'AIRDROP_DISABLED'
            });
        }

        // ... (lógica de airdrop pra quando ativar)
        // Por enquanto, apenas retorna aviso
    })
);

// ============================================
// GET /api/v1/wallet/airdrop/status
// ============================================

router.get(
    '/airdrop/status',
    authenticate,
    asyncHandler(async (req, res) => {
        res.json({
            success: true,
            data: {
                enabled: AIRDROP_ENABLED,
                message: AIRDROP_ENABLED
                    ? 'Airdrop disponível'
                    : 'Airdrop temporariamente desativado'
            }
        });
    })
);

// ============================================
// HELPER — Formata wallet pra resposta
// ============================================

function formatWallet(walletDoc) {
    return {
        address: walletDoc.address,
        username: walletDoc.username,
        publicKey: walletDoc.publicKey,
        createdAt: walletDoc.createdAt
    };
}

// ============================================
// EXPORTS
// ============================================

module.exports = router;
