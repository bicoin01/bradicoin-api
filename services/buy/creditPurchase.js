// services/buy/creditPurchase.js
// ============================================
// Credita BRD na wallet do usuário após pagamento confirmado
// ============================================
// Fluxo atômico:
//   1. Trava o pedido: paid → crediting
//   2. Debita da tesouraria (controle contábil)
//   3. Cria TX de sistema: treasury → user
//   4. Aplica imediatamente (opcional, UX melhor)
//   5. Marca: crediting → credited
//   6. Emite WebSocket pro usuário
//
// Se qualquer etapa falhar, reverte e libera a tesouraria.
// ============================================

const BuyOrder = require('../../models/BuyOrder');
const Treasury = require('../../models/Treasury');
const blockchain = require('../../blockchain');
const walletService = require('../../wallet');
const { logger } = require('../../middleware/error');

// Se true: aplica a TX imediatamente (não espera mineração)
const APPLY_IMMEDIATELY = process.env.BUY_CREDIT_APPLY_IMMEDIATELY !== 'false';

// ============================================
// CREDITA UM PEDIDO
// ============================================
async function creditPurchase(orderId, { io } = {}) {
    const log = (msg, level = 'info') => {
        const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info;
        fn(`[creditPurchase] ${orderId}: ${msg}`);
    };

    // ===== 1. TRAVA O PEDIDO (paid → crediting) =====
    const order = await BuyOrder.findOneAndUpdate(
        { orderId, status: 'paid', creditTxHash: null },
        {
            $set: {
                status: 'crediting',
                'metadata.creditingStartedAt': new Date()
            }
        },
        { new: true }
    );

    if (!order) {
        const current = await BuyOrder.findOne({ orderId }).lean();
        if (!current) return { ok: false, reason: 'order_not_found' };
        if (current.status === 'credited') return { ok: false, reason: 'already_credited', order: current };
        if (current.status === 'crediting') return { ok: false, reason: 'already_crediting', order: current };
        return { ok: false, reason: `invalid_status_${current.status}`, order: current };
    }

    const amountStr = order.amountBr.toString();
    const amountNum = parseFloat(amountStr);

    if (!Number.isFinite(amountNum) || amountNum <= 0) {
        await _fail(order.orderId, 'amount_invalid');
        return { ok: false, reason: 'amount_invalid' };
    }

    log(`💰 Iniciando crédito: ${amountStr} BRD → ${order.toWallet}`);

    let treasuryDebited = false;
    let txHash = null;

    try {
        // ===== 2. DEBITA DA TESOURARIA =====
        try {
            await Treasury.debit(amountStr);
            treasuryDebited = true;
            log(`📉 Tesouraria debitada em ${amountStr} BRD`);
        } catch (err) {
            log(`❌ Falha ao debitar tesouraria: ${err.message}`, 'error');
            await _fail(order.orderId, `treasury_debit_failed: ${err.message}`);
            return { ok: false, reason: 'treasury_debit_failed', error: err.message };
        }

        // ===== 3. CRIA A TX DE SISTEMA =====
        const tx = {
            fromAddress: null,
            toAddress: order.toWallet,
            amount: amountNum,
            fee: 0,
            type: 'buy_brd',
            timestamp: new Date().toISOString(),
            metadata: {
                orderId: order.orderId,
                currency: order.currency,
                paymentNetwork: order.paymentNetwork,
                paymentTxHash: order.paymentTxHash,
                amountUsd: order.amountUsd,
                priceAtOrder: order.priceAtOrder
            }
        };

        let txResult;
        try {
            txResult = await blockchain.addTransaction(tx);
            txHash = txResult.hash;
            log(`📝 TX criada: ${txHash.substring(0, 16)}… (status=${txResult.status})`);
        } catch (err) {
            log(`❌ Falha ao criar TX: ${err.message}`, 'error');
            if (treasuryDebited) await _revertTreasury(amountStr, log);
            await _fail(order.orderId, `tx_create_failed: ${err.message}`);
            return { ok: false, reason: 'tx_create_failed', error: err.message };
        }

        // ===== 4. APLICA IMEDIATAMENTE (opcional) =====
        if (APPLY_IMMEDIATELY) {
            try {
                blockchain.pendingTransactions = blockchain.pendingTransactions.filter(
                    t => t.hash !== txHash
                );

                const TransactionModel = require('../../models/Transaction');
                await TransactionModel.updateOne(
                    { hash: txHash },
                    { $set: { status: 'confirmed', confirmedAt: new Date() } }
                );
                await walletService.creditBalance(order.toWallet, amountStr);
                log(`⚡ TX aplicada imediatamente (saldo creditado)`);

                blockchain.emit('tx:new', {
                    hash: txHash,
                    fromAddress: null,
                    toAddress: order.toWallet,
                    amount: amountStr,
                    type: 'buy_brd',
                    status: 'confirmed'
                });
            } catch (err) {
                log(`⚠️ Aplicação imediata falhou: ${err.message}. TX fica na mempool.`, 'warn');
            }
        }

        // ===== 5. MARCA COMO CREDITADO =====
        const credited = await BuyOrder.findOneAndUpdate(
            { orderId: order.orderId, status: 'crediting' },
            {
                $set: {
                    status: 'credited',
                    creditTxHash: txHash,
                    creditedAt: new Date(),
                    'metadata.creditAppliedImmediately': APPLY_IMMEDIATELY
                }
            },
            { new: true }
        );

        await Treasury.markCredited(amountStr).catch(e =>
            log(`⚠️ markCredited falhou: ${e.message}`, 'warn')
        );

        log(`✅ CREDITADO: ${order.orderId} — ${amountStr} BRD → ${order.toWallet.substring(0, 12)}…`);

        // ===== 6. WEBSOCKET =====
        try {
            const ioRef = io || global.io;
            if (ioRef) {
                ioRef.emit('buy:credited', {
                    orderId: order.orderId,
                    toWallet: order.toWallet,
                    amountBr: amountStr,
                    creditTxHash: txHash,
                    currency: order.currency,
                    creditedAt: credited?.creditedAt
                });
                if (order.userId) {
                    ioRef.to(`user:${order.userId}`).emit('buy:credited', {
                        orderId: order.orderId,
                        amountBr: amountStr,
                        creditTxHash: txHash
                    });
                }
                log('📡 WebSocket buy:credited emitido');
            }
        } catch (wsErr) {
            log(`⚠️ WS emit falhou: ${wsErr.message}`, 'warn');
        }

        return {
            ok: true,
            order: credited?.toObject(),
            amountBr: amountStr,
            creditTxHash: txHash
        };

    } catch (err) {
        log(`❌ Erro inesperado: ${err.message}`, 'error');
        if (treasuryDebited) await _revertTreasury(amountStr, log);
        await _fail(order.orderId, `unexpected: ${err.message}`);
        return { ok: false, reason: 'unexpected_error', error: err.message };
    }
}

// ============================================
// HELPERS
// ============================================
async function _fail(orderId, reason) {
    try {
        await BuyOrder.findOneAndUpdate(
            { orderId, status: 'crediting' },
            {
                $set: {
                    status: 'paid',
                    failureReason: reason,
                    'metadata.lastCreditAttemptAt': new Date()
                },
                $inc: { 'metadata.creditAttempts': 1 }
            }
        );
    } catch (err) {
        logger.error(`[creditPurchase] _fail(${orderId}) falhou: ${err.message}`);
    }
}

async function _revertTreasury(amountStr, log) {
    try {
        await Treasury.findOneAndUpdate(
            { key: 'brd_main' },
            { $inc: { balance: amountStr, totalSold: `-${amountStr}` } }
        );
        log(`↩️ Tesouraria revertida (+${amountStr} BRD)`);
    } catch (err) {
        log(`🚨 FALHA AO REVERTER TESOURARIA: ${err.message}`, 'error');
    }
}

module.exports = { creditPurchase };
