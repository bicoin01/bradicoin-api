// services/buy/creditWorker.js
// ============================================
// Worker que processa pedidos em 'paid' e credita BRD
// ============================================

const BuyOrder = require('../../models/BuyOrder');
const { creditPurchase } = require('./creditPurchase');
const { logger } = require('../../middleware/error');

const POLL_INTERVAL_MS = parseInt(process.env.BUY_CREDIT_POLL_MS || '15000');
const BATCH_SIZE      = parseInt(process.env.BUY_CREDIT_BATCH || '20');
const MAX_ATTEMPTS    = parseInt(process.env.BUY_CREDIT_MAX_ATTEMPTS || '5');

let intervalHandle = null;
let isRunning = false;
let ioRef = null;

async function processPaidOrders() {
    if (isRunning) return;
    isRunning = true;

    try {
        const paidOrders = await BuyOrder.find({
            status: 'paid',
            creditTxHash: null
        })
            .sort({ paidAt: 1 })
            .limit(BATCH_SIZE)
            .lean();

        if (paidOrders.length === 0) return;

        logger.info(`[creditWorker] processando ${paidOrders.length} pedido(s) 'paid'`);

        for (const order of paidOrders) {
            const attempts = order.metadata?.creditAttempts || 0;
            if (attempts >= MAX_ATTEMPTS) {
                logger.error(`[creditWorker] ${order.orderId}: excedeu ${MAX_ATTEMPTS} tentativas — failed`);
                await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'paid' },
                    { $set: { status: 'failed', failureReason: `max_attempts_reached (${attempts})` } }
                );
                continue;
            }

            try {
                const result = await creditPurchase(order.orderId, { io: ioRef });
                if (result.ok) logger.info(`[creditWorker] ✅ ${order.orderId} creditado`);
                else logger.warn(`[creditWorker] ⚠️ ${order.orderId}: ${result.reason}`);
            } catch (err) {
                logger.error(`[creditWorker] ❌ ${order.orderId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`[creditWorker] erro no ciclo: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

function start({ io } = {}) {
    if (process.env.BUY_CREDIT_ENABLED === 'false') {
        logger.info('⚠️ creditWorker DESATIVADO');
        return;
    }
    if (intervalHandle) return;

    ioRef = io || global.io || null;

    logger.info(
        `✅ creditWorker ATIVO (cada ${POLL_INTERVAL_MS / 1000}s, batch=${BATCH_SIZE}, maxAttempts=${MAX_ATTEMPTS})`
    );

    intervalHandle = setInterval(processPaidOrders, POLL_INTERVAL_MS);
    processPaidOrders();
}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        logger.info('🛑 creditWorker parado');
    }
}

module.exports = { start, stop, processPaidOrders };
