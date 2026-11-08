// services/buy/creditingWatchdog.js
// ============================================
// Watchdog do creditWorker
// ============================================
// Se o servidor cair no meio de um creditPurchase (status='crediting'),
// o pedido fica preso e o creditWorker nunca mais processa (só busca 'paid').
//
// Este job:
//   1. Roda a cada 5 min
//   2. Busca pedidos em 'crediting' com updatedAt > 10 min
//   3. Reseta pra 'paid' (creditWorker pega de novo)
//
// ⚠️ IMPORTANTE: antes de resetar, verifica se o crédito já foi
//    aplicado por algum motivo (creditTxHash preenchido). Se sim,
//    marca como 'credited' direto (não reseta).
// ============================================

const BuyOrder = require('../../models/BuyOrder');
const { logger } = require('../../middleware/error');

// ===== CONFIG =====
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;       // roda a cada 5 min
const STUCK_THRESHOLD_MS  = 10 * 60 * 1000;       // considera travado se > 10 min
const MAX_RESETS_PER_CYCLE = 20;                  // safety: não ressuscita 1000 pedidos de uma vez

// ===== ESTADO =====
let intervalHandle = null;
let ioRef = null;
let isRunning = false;

// ============================================
// RESET STUCK ORDERS
// ============================================
async function resetStuckCrediting() {
    if (isRunning) return;
    isRunning = true;

    try {
        const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS);

        // Busca pedidos presos em 'crediting'
        const stuck = await BuyOrder.find({
            status: 'crediting',
            updatedAt: { $lt: threshold }
        })
            .sort({ updatedAt: 1 })        // mais antigos primeiro
            .limit(MAX_RESETS_PER_CYCLE);

        if (stuck.length === 0) {
            isRunning = false;
            return;
        }

        logger.warn(
            `[creditingWatchdog] ${stuck.length} pedido(s) preso(s) em 'crediting' há mais de ${STUCK_THRESHOLD_MS / 60000} min — resetando`
        );

        for (const order of stuck) {
            try {
                // ⚠️ Safety check: se o crédito já foi aplicado
                // (creditTxHash preenchido), NÃO reseta — marca como credited
                if (order.creditTxHash) {
                    await BuyOrder.findOneAndUpdate(
                        { orderId: order.orderId, status: 'crediting' },
                        {
                            $set: {
                                status: 'credited',
                                creditedAt: order.creditedAt || new Date()
                            }
                        }
                    );
                    logger.info(
                        `[creditingWatchdog] ✅ ${order.orderId} já tinha creditTxHash — marcado como 'credited' (não reseta)`
                    );
                    continue;
                }

                // Reseta pra 'paid' — creditWorker pega de novo
                const reset = await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'crediting' },
                    {
                        $set: {
                            status: 'paid',
                            failureReason: null,
                            // Adiciona ao metadata pra auditoria
                            'metadata.watchdogResets': (order.metadata?.watchdogResets || 0) + 1,
                            'metadata.lastWatchdogResetAt': new Date()
                        }
                    },
                    { new: true }
                );

                if (reset) {
                    logger.warn(
                        `[creditingWatchdog] 🔄 ${order.orderId} resetado de 'crediting' → 'paid' ` +
                        `(preso desde ${order.updatedAt.toISOString()}, ${reset.metadata?.watchdogResets || 1}x reset)`
                    );

                    // Notifica via WS (se disponível)
                    if (ioRef) {
                        ioRef.emit('buy:watchdog_reset', {
                            orderId: order.orderId,
                            toWallet: order.toWallet,
                            amount: order.amountBr?.toString(),
                            resetCount: reset.metadata?.watchdogResets || 1
                        });
                    }
                }
            } catch (err) {
                logger.error(
                    `[creditingWatchdog] erro ao resetar ${order.orderId}: ${err.message}`
                );
            }
        }
    } catch (err) {
        logger.error(`[creditingWatchdog] erro no ciclo: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

// ============================================
// START / STOP
// ============================================
function start({ io } = {}) {
    if (intervalHandle) return;

    ioRef = io || null;

    logger.info(
        `✅ creditingWatchdog ATIVO (threshold ${STUCK_THRESHOLD_MS / 60000}min, ` +
        `a cada ${WATCHDOG_INTERVAL_MS / 60000}min)`
    );

    intervalHandle = setInterval(resetStuckCrediting, WATCHDOG_INTERVAL_MS);

    // Não roda no boot — deixa o creditWorker ter a 1ª chance
    // (se rodar no boot, pode resetar pedido que acabou de entrar em 'crediting')
}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        logger.info('🛑 creditingWatchdog parado');
    }
}

module.exports = {
    start,
    stop,
    resetStuckCrediting   // exporta pra testar manual
};
