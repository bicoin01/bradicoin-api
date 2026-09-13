// routes/wallet.js
// ============================================
// Rotas de wallet - Bradicoin
// Integração: blockchain + auth + seed phrase
// ============================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const blockchainWallet = require('../wallet'); // wallet.js da raiz
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');

// ============================================
// CONFIGURAÇÕES
// ============================================

const FEE_AMOUNT = 0.015;         // Fee por envio (0.015 BRD ≈ $0.15)
const MIN_SEND = 0.17;            // Mínimo para enviar
const AIRDROP_ENABLED = false;    // ⏸️ Desativado
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

// Deriva endereço a partir da seed (mesmo algoritmo do frontend)
// Frontend faz: SHA256(seed).substring(0, 38) com prefixo "Br"
// Aqui validamos apenas o formato — o app já manda pronto
function isValidAddressFormat(address) {
    return typeof address === 'string' &&
           address.startsWith('Br') &&
           address.length >= 20 &&
           address.length <= 60;
}

// Busca wallet vinculada ao user
async function getUserWallet(userId) {
    const user = await User.findById(userId);
    if (!user || !user.walletAddress) return null;

    const WalletModel = blockchainWallet.WalletModel;

    // 1) tenta pelo userId (mais confiável)
    let wallet = await WalletModel.findOne({ userId });
    if (wallet) return wallet;

    // 2) fallback: pelo endereço salvo no User
    wallet = await WalletModel.findOne({ address: user.walletAddress });

    // 3) auto-heal: se achou por endereço mas sem userId, vincula
    if (wallet && !wallet.userId) {
        wallet.userId = userId;
        await wallet.save();
    }

    return wallet;
}

// ============================================
// POST /api/v1/wallet/create
// Cria carteira nova (usuário logado, vindo do /register)
// ============================================

router.post(
    '/create',
    authenticate,
    asyncHandler(async (req, res) => {
        const { address, publicKey, username } = req.body;

        // ===== VALIDAÇÕES =====
        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Endereço é obrigatório'
            });
        }

        if (!isValidAddressFormat(address)) {
            return res.status(400).json({
                success: false,
                error: 'Formato de endereço inválido'
            });
        }

        // ===== VERIFICA SE JÁ TEM WALLET =====
        const user = await User.findById(req.userId);
        if (user.walletAddress) {
            const existing = await blockchainWallet.WalletModel.findOne({
                address: user.walletAddress
            });
            if (existing) {
                return res.status(409).json({
                    success: false,
                    error: 'Você já tem uma carteira',
                    data: {
                        wallet: {
                            address: existing.address,
                            username: existing.username,
                            publicKey: existing.publicKey,
                            createdAt: existing.createdAt
                        }
                    }
                });
            }
        }

        // ===== VERIFICA SE ENDEREÇO JÁ EXISTE =====
        const WalletModel = blockchainWallet.WalletModel;
        const addressExists = await WalletModel.findOne({ address });
        if (addressExists) {
            return res.status(409).json({
                success: false,
                error: 'Este endereço já está em uso'
            });
        }

        // ===== VERIFICA USERNAME =====
        // O wallet.js exige username único. Usamos o do User + sufixo
        // se estiver em uso, ou o username que veio do frontend
        let finalUsername = username || user.username;
        const usernameInUse = await WalletModel.findOne({ username: finalUsername });
        if (usernameInUse) {
            finalUsername = `${user.username}_${req.userId.toString().slice(-6)}`;
        }

        // ===== CRIA WALLET USANDO wallet.js =====
        // ⚠️ wallet.js gera endereço próprio. Vamos sobrepor com o do frontend
        // pra garantir que seja o MESMO derivado da seed.
        const result = await blockchainWallet.createWallet(finalUsername);

        // Atualiza a wallet com o endereço que veio do frontend
        // (e publicKey se fornecida)
        await WalletModel.findOneAndUpdate(
            { address: result.address },
            {
                $set: {
                    address: address,               // sobrescreve com o do frontend
                    publicKey: publicKey || result.publicKey,
                    userId: req.userId              // 🆕 vincula ao user
                }
            }
        );

        // Vincula ao User
        user.walletAddress = address;
        await user.save();

        // ===== RETORNA =====
        res.status(201).json({
            success: true,
            message: 'Carteira criada com sucesso',
            data: {
                wallet: {
                    address: address,
                    username: finalUsername,
                    publicKey: publicKey || result.publicKey,
                    createdAt: result.createdAt
                },
                initialBalance: result.initialBalance || 1000,
                note: 'Saldo será confirmado quando o próximo bloco for minerado'
            }
        });
    })
);

// ============================================
// POST /api/v1/wallet/import
// Importa carteira existente via seed phrase
// ============================================

router.post(
    '/import',
    authenticate,
    asyncHandler(async (req, res) => {
        const { seed, password } = req.body;

        if (!seed) {
            return res.status(400).json({
                success: false,
                error: 'Seed phrase é obrigatória'
            });
        }

        // ===== DERIVA ENDEREÇO DA SEED (mesmo algoritmo do frontend) =====
        // SHA256(seed) → primeiros 38 chars → prefixo "Br"
        const seedHash = crypto
            .createHash('sha256')
            .update(seed.trim())
            .digest('hex');
        const derivedAddress = 'Br' + seedHash.substring(0, 38);

        // ===== VERIFICA SE ESSA WALLET JÁ EXISTE =====
        const WalletModel = blockchainWallet.WalletModel;
        const existingWallet = await WalletModel.findOne({ address: derivedAddress });

        if (existingWallet) {
            // Carteira já existe — só vincula ao usuário atual
            const user = await User.findById(req.userId);
            user.walletAddress = derivedAddress;
            await user.save();

            // Atualiza userId na wallet
            await WalletModel.findOneAndUpdate(
                { address: derivedAddress },
                { $set: { userId: req.userId } }
            );

            return res.json({
                success: true,
                message: 'Carteira importada com sucesso (já existia)',
                data: {
                    wallet: {
                        address: existingWallet.address,
                        username: existingWallet.username,
                        publicKey: existingWallet.publicKey,
                        createdAt: existingWallet.createdAt
                    }
                }
            });
        }

        // ===== CRIA NOVA WALLET COM ENDEREÇO DERIVADO =====
        const user = await User.findById(req.userId);
        let finalUsername = user.username;
        const usernameInUse = await WalletModel.findOne({ username: finalUsername });
        if (usernameInUse) {
            finalUsername = `${user.username}_${req.userId.toString().slice(-6)}`;
        }

        const result = await blockchainWallet.createWallet(finalUsername);

        // Sobrescreve com o endereço derivado da seed
        await WalletModel.findOneAndUpdate(
            { address: result.address },
            {
                $set: {
                    address: derivedAddress,
                    userId: req.userId
                }
            }
        );

        user.walletAddress = derivedAddress;
        await user.save();

        res.json({
            success: true,
            message: 'Carteira importada com sucesso',
            data: {
                wallet: {
                    address: derivedAddress,
                    username: finalUsername,
                    publicKey: result.publicKey,
                    createdAt: result.createdAt
                }
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
        const user = await User.findById(req.userId);

        if (!user.walletAddress) {
            return res.status(404).json({
                success: false,
                error: 'Você ainda não tem uma carteira',
                code: 'NO_WALLET'
            });
        }

        const walletDoc = await getUserWallet(req.userId);
        if (!walletDoc) {
            return res.status(404).json({
                success: false,
                error: 'Carteira não encontrada',
                code: 'WALLET_NOT_FOUND'
            });
        }

        // Saldo REAL da blockchain
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
        const user = await User.findById(req.userId);

        if (!user.walletAddress) {
            return res.status(404).json({
                success: false,
                error: 'Você ainda não tem uma carteira',
                code: 'NO_WALLET'
            });
        }

        res.json({
            success: true,
            data: { address: user.walletAddress }
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
        const user = await User.findById(req.userId);

        if (!user.walletAddress) {
            return res.status(404).json({
                success: false,
                error: 'Você ainda não tem uma carteira',
                code: 'NO_WALLET'
            });
        }

        const balanceData = await blockchainWallet.getBalance(user.walletAddress);

        res.json({
            success: true,
            data: {
                address: user.walletAddress,
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

        if (!blockchainWallet.isValidAddress(to)) {
            return res.status(400).json({
                success: false,
                error: 'Endereço de destino inválido'
            });
        }

        // ===== CARREGA CARTEIRA =====
        const user = await User.findById(req.userId);
        if (!user.walletAddress) {
            return res.status(404).json({
                success: false,
                error: 'Você ainda não tem uma carteira',
                code: 'NO_WALLET'
            });
        }

        if (user.walletAddress === to) {
            return res.status(400).json({
                success: false,
                error: 'Você não pode enviar para si mesmo'
            });
        }

        // ===== VERIFICA DESTINATÁRIO =====
        const WalletModel = blockchainWallet.WalletModel;
        const toWallet = await WalletModel.findOne({ address: to });
        if (!toWallet) {
            return res.status(404).json({
                success: false,
                error: 'Endereço de destino não encontrado'
            });
        }

        // ===== VERIFICA SALDO =====
        const balanceData = await blockchainWallet.getBalance(user.walletAddress);
        const totalDebit = round8(sendAmount + FEE_AMOUNT);

        if (balanceData.total < totalDebit) {
            return res.status(400).json({
                success: false,
                error: `Saldo insuficiente. Necessário: ${totalDebit} BRD. Você tem: ${balanceData.total} BRD`
            });
        }

        // ===== ENVIA PRA BLOCKCHAIN =====
        const txId = generateTxId();

        await blockchainWallet.addTransaction({
            fromAddress: user.walletAddress,
            toAddress: to,
            amount: sendAmount,
            fee: FEE_AMOUNT,
            timestamp: new Date().toISOString(),
            type: 'transfer',
            txId,
            message: message || null
        });

        res.json({
            success: true,
            message: `Transação enviada. Aguardando confirmação na blockchain...`,
            data: {
                txId,
                from: user.walletAddress,
                to,
                amount: sendAmount,
                fee: FEE_AMOUNT,
                totalDebit,
                status: 'pending',
                note: 'A transação será confirmada em até 30 segundos'
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
        const user = await User.findById(req.userId);

        if (!user.walletAddress) {
            return res.status(404).json({
                success: false,
                error: 'Você ainda não tem uma carteira',
                code: 'NO_WALLET'
            });
        }

        const limit = parseInt(req.query.limit) || 50;
        const history = await blockchainWallet.getHistory(user.walletAddress, limit);

        const formatted = history.map((tx) => {
            const isSent = tx.fromAddress === user.walletAddress;
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
                address: user.walletAddress,
                transactions: formatted,
                count: formatted.length
            }
        });
    })
);

// ============================================
// POST /api/v1/wallet/airdrop
// ⏸️ DESATIVADO
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

        // (lógica pra quando ativar)
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
// EXPORTS
// ============================================

module.exports = router;
