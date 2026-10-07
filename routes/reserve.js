// routes/reserve.js
// ============================================
// Rotas do Fundo de Reserva - Bradicoin (v3.0)
// ============================================
// 🔐 Uso pessoal: protegido por x-admin-key
// 💰 Assina server-side com RESERVE_PRIVATE_KEY
// ============================================

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const { ReserveModel, RESERVE_ADDRESS } = require('../models/Reserve');
const WalletModel = require('../models/Wallet');
const wallet = require('../wallet');
const transactions = require('../transactions');
const { decrypt } = require('../utils/crypto');
const { requireAdminKey } = require('../middleware/adminKey');
const { asyncHandler, AppError } = require('../middleware/error');

// ============================================
// GET /api/v1/reserve/info
// ============================================
router.get(
    '/info',
    asyncHandler(async (req, res) => {
        const info = await ReserveModel.getInfo();
        res.json({ success: true, data: info });
    })
);

// ============================================
// GET /api/v1/reserve/stats (alias para compatibilidade)
// ============================================
router.get(
    '/stats',
    asyncHandler(async (req, res) => {
        const info = await ReserveModel.getInfo();
        res.json({ success: true, data: info });
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
// GET /api/v1/reserve/balance
// ============================================
// Retorna saldo real do Reserve (WalletModel + ReserveModel)
//
router.get(
    '/balance',
    asyncHandler(async (req, res) => {
        const walletDoc = await WalletModel.findOne({ address: RESERVE_ADDRESS })
            .select('address balance nonce status')
            .lean();

        const reserveInfo = await ReserveModel.getInfo();

        res.json({
            success: true,
            data: {
                address: RESERVE_ADDRESS,
                walletBalance: walletDoc ? walletDoc.balance.toString() : '0',
                nonce: walletDoc ? walletDoc.nonce : 0,
                status: walletDoc ? walletDoc.status : 'not_found',
                reserve: {
                    balance: reserveInfo.balance,
                    totalSupply: reserveInfo.totalSupply,
                    maxSupply: reserveInfo.maxSupply
                }
            }
        });
    })
);

// ============================================
// POST /api/v1/reserve/send
// ============================================
// 🔐 Protegido por x-admin-key
// 💰 Assina server-side com RESERVE_PRIVATE_KEY (descriptografada)
//
router.post(
    '/send',
    requireAdminKey,
    asyncHandler(async (req, res) => {
        const { to, amount, fee = 0 } = req.body;

        // ==========================
        // VALIDAÇÕES
        // ==========================
        if (!to || !wallet.isValidAddress(to)) {
            throw new AppError('Endereço de destino inválido', 400);
        }

        const amountNum = parseFloat(amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            throw new AppError('Valor inválido', 400);
        }

        if (amountNum > 100_000_000_000_000) {
            throw new AppError('Valor máximo por transação: 100 trilhões BRD', 400);
        }

        const feeNum = parseFloat(fee) || 0;

        // ==========================
        // BUSCA WALLET DO RESERVE
        // ==========================
        const reserveWallet = await WalletModel.findOne({
            address: RESERVE_ADDRESS
        }).select('+encryptedPrivateKey');

        if (!reserveWallet) {
            throw new AppError(
                'Reserve não configurado no banco. Rode: node scripts/init-reserve-balance.js',
                500
            );
        }

        if (!reserveWallet.encryptedPrivateKey) {
            throw new AppError(
                'Reserve não tem chave privada configurada. Rode: node scripts/init-reserve-balance.js',
                500
            );
        }

        if (reserveWallet.status !== 'active') {
            throw new AppError('Reserve inativo', 403);
        }

        // ==========================
        // CHECA SALDO
        // ==========================
        const balance = parseFloat(reserveWallet.balance.toString());
        const totalCost = amountNum + feeNum;

        if (balance < totalCost) {
            throw new AppError(
                `Reserve sem saldo suficiente. Tem ${balance}, precisa ${totalCost}`,
                400
            );
        }

        // ==========================
        // DESCRIPTOGRAFA E ASSINA
        // ==========================
        let privateKey;
        try {
            privateKey = decrypt(reserveWallet.encryptedPrivateKey);
        } catch (e) {
            throw new AppError('Falha ao descriptografar chave do Reserve: ' + e.message, 500);
        }

        const signed = transactions.createSignedTransaction({
            fromAddress: RESERVE_ADDRESS,
            toAddress: to,
            amount: amountNum,
            fee: feeNum,
            nonce: reserveWallet.nonce,
            type: 'transfer',
            privateKey
        });

        // ==========================
        // SUBMETE
        // ==========================
        const result = await transactions.submitSignedTransaction(signed);

        // ==========================
        // ATUALIZA RESERVE MODEL
        // ==========================
        try {
            await ReserveModel.findOneAndUpdate(
                { address: RESERVE_ADDRESS },
                {
                    $inc: {
                        totalAirdropsPaid: Decimal128.fromString(amountNum.toString())
                    },
                    $set: { lastActivity: new Date() }
                }
            );
        } catch (e) {
            console.warn('Aviso: falha ao atualizar ReserveModel:', e.message);
        }

        console.log(`💰 Reserve enviou ${amountNum} BRD → ${to}`);

        res.json({
            success: true,
            data: {
                hash: result.hash,
                status: result.status,
                message: result.message,
                from: RESERVE_ADDRESS,
                to,
                amount: amountNum,
                fee: feeNum
            }
        });
    })
);

// ============================================
// EXPORTS
// ============================================
module.exports = router;
