// routes/reserve.js
// ============================================
// Rotas do Fundo de Reserva - Bradicoin
// ============================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');
const blockchainWallet = require('../wallet');
const blockchain = require('../blockchain');
const { ReserveModel, RESERVE_ADDRESS, MAX_SAFE_BALANCE } = require('../models/Reserve');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');

// ============================================
// HELPERS
// ============================================

function round8(n) {
    return Math.round(n * 100000000) / 100000000;
}

function generateTxId() {
    return 'tx_' + crypto.randomBytes(16).toString('hex');
}

// ============================================
// GET /api/v1/reserve/stats
// Estatísticas do fundo
// ============================================

router.get(
    '/stats',
    asyncHandler(async (req, res) => {
        const reserve = await ReserveModel.getReserve();

        res.json({
            success: true,
            data: {
                address: reserve.address,
                balance: reserve.balance,
                initialBalance: reserve.initialBalance,
                totalSent: reserve.totalSent,
                totalMinted: reserve.totalMinted,
                totalRewardsPaid: reserve.totalRewardsPaid,
                autoReplenish: reserve.autoReplenish,
                maxBalance: reserve.maxBalance,
                lastActivity: reserve.lastActivity
            }
        });
    })
);

// ============================================
// POST /api/v1/reserve/send
// Fundo envia BRD pra uma wallet + auto-reposição
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

        if (!blockchainWallet.isValidAddress(to)) {
            return res.status(400).json({
                success: false,
                error: 'Endereço de destino inválido'
            });
        }

        if (to === RESERVE_ADDRESS) {
            return res.status(400).json({
                success: false,
                error: 'Não é possível enviar para o próprio fundo'
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

        // ===== CAP DE SEGURANÇA =====
        const reserve = await ReserveModel.getReserve();
        if (sendAmount > MAX_SAFE_BALANCE) {
            return res.status(400).json({
                success: false,
                error: `Valor excede o limite de segurança (${MAX_SAFE_BALANCE} BRD)`
            });
        }

        // ===== REGISTRA ENVIO NA BLOCKCHAIN =====
        const txId = generateTxId();

        await blockchain.addTransaction({
            fromAddress: RESERVE_ADDRESS,
            toAddress: to,
            amount: sendAmount,
            fee: 0,
            timestamp: new Date().toISOString(),
            type: 'reserve_send',
            txId,
            message: message || null
        });

        // ===== AUTO-REPOSIÇÃO NA BLOCKCHAIN =====
        const mintTxId = generateTxId();
        await blockchain.addTransaction({
            fromAddress: null, // sistema
            toAddress: RESERVE_ADDRESS,
            amount: sendAmount,
            fee: 0,
            timestamp: new Date().toISOString(),
            type: 'reserve_mint',
            txId: mintTxId,
            message: 'Auto-reposição do fundo'
        });

        // ===== ATUALIZA ESTATÍSTICAS DO FUNDO =====
        await ReserveModel.recordSend(sendAmount);

        res.json({
            success: true,
            message: `${sendAmount} BRD enviado do Fundo de Reserva`,
            data: {
                txId,
                mintTxId,
                from: RESERVE_ADDRESS,
                to,
                amount: sendAmount,
                autoReplenished: true,
                status: 'pending',
                note: 'Transação será confirmada em até 30 segundos'
            }
        });
    })
);

// ============================================
// GET /api/v1/reserve/address
// Endereço oficial do fundo
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
// EXPORTS
// ============================================

module.exports = router;
