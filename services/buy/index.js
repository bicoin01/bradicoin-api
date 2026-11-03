// services/buy/index.js
// ============================================
// Orquestrador dos workers de compra
// ============================================
// - Inicia os 4 monitores (BTC, ETH/BNB, USDT, SOL)
// - Inicia o creditWorker (credita BRD quando pagamento detectado)
// - Inicia o expirationWorker (marca pedidos expirados)
//
// ============================================

const transactions = require('../../transactions');
const BuyOrder = require('../../models/BuyOrder');
const { logger } = require('../../middleware/error');

const btcMonitor = require('./monitors/btcMonitor');
const evmMonitor = require('./monitors/evmMonitor');
const usdtMonitor = require('./monitors/usdtMonitor');
const solMonitor = require('./monitors/solMonitor');

let creditInterval = null;
let expirationInterval = null;
let ioRef = null;

const CREDIT_INTERVAL_MS = 10 * 1000;       // a cada 10s
const EXPIRATION_INTERVAL_MS = 60 * 1000;   // a cada 1min

// ============================================
// CREDIT WORKER
// ============================================
async function creditWorker() {
    try {
        const orders = await BuyOrder.findPaid(50);

        if (orders.length === 0) return;

        logger.info(`💳 creditWorker: ${orders.length} pedido(s) para creditar`);

        for (const order of orders) {
            try {
                const result = await transactions.creditPurchase({
                    orderId: order.orderId,
                    toAddress: order.toWallet,
                    amount: order.amountBr.toString()
                });

                logger.info(`✅ Creditado: ${order.orderId} → ${result.newBalance} BRD`);

                if (ioRef) {
                    ioRef.emit('buy:credited', {
                        orderId: order.orderId,
                        toWallet: order.toWallet,
                        amount: order.amountBr.toString(),
                        txHash: result.txHash
                    });
                }
            } catch (err) {
                logger.error(`❌ Falha ao creditar ${order.orderId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`❌ creditWorker erro: ${err.message}`);
    }
}

// ============================================
// EXPIRATION WORKER
// ============================================
async function expirationWorker() {
    try {
        const expired = await BuyOrder.findExpired();

        if (expired.length === 0) return;

        logger.info(`⏰ expirationWorker: ${expired.length} pedido(s) expirado(s)`);

        for (const order of expired) {
            await BuyOrder.markExpired(order.orderId);
            logger.info(`⏰ Pedido expirado: ${order.orderId}`);
        }
    } catch (err) {
        logger.error(`❌ expirationWorker erro: ${err.message}`);
    }
}

// ============================================
// START
// ============================================
async function startBuyWorkers({ io } = {}) {
    ioRef = io || null;

    logger.info('');
    logger.info('════════════════════════════════════════');
    logger.info('🛒 Iniciando workers de compra...');
    logger.info('════════════════════════════════════════');

    // Inicia monitores
    btcMonitor.start();
    evmMonitor.start();
    usdtMonitor.start();
    solMonitor.start();

    // Inicia creditWorker
    if (!creditInterval) {
        creditInterval = setInterval(creditWorker, CREDIT_INTERVAL_MS);
        logger.info(`✅ creditWorker ATIVO (a cada ${CREDIT_INTERVAL_MS/1000}s)`);
    }

    // Inicia expirationWorker
    if (!expirationInterval) {
        expirationInterval = setInterval(expirationWorker, EXPIRATION_INTERVAL_MS);
        logger.info(`✅ expirationWorker ATIVO (a cada ${EXPIRATION_INTERVAL_MS/1000}s)`);
    }

    logger.info('════════════════════════════════════════');
    logger.info('');
}

// ============================================
// STOP
// ============================================
function stopBuyWorkers() {
    btcMonitor.stop();
    evmMonitor.stop();
    usdtMonitor.stop();
    solMonitor.stop();

    if (creditInterval) { clearInterval(creditInterval); creditInterval = null; }
    if (expirationInterval) { clearInterval(expirationInterval); expirationInterval = null; }

    logger.info('🛑 Workers de compra parados');
}

module.exports = { startBuyWorkers, stopBuyWorkers };
