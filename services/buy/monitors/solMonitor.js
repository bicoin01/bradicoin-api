// services/buy/monitors/solMonitor.js
// ============================================
// Monitor de pagamentos Solana
// ============================================
// Consulta o saldo do endereço de depósito via RPC Solana.
//
// Se BUY_SOL_ADDRESS não estiver no .env, o monitor fica desativado.
//
// Requer: npm install @solana/web3.js
//
// ============================================

const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

const SOL_ADDRESS = process.env.BUY_SOL_ADDRESS || null;
const SOL_RPC = process.env.BUY_SOL_RPC || 'https://api.mainnet-beta.solana.com';
const POLL_INTERVAL_MS = 30 * 1000;

let connection = null;
let intervalHandle = null;
let isRunning = false;

// ============================================
// LOOP PRINCIPAL
// ============================================
async function poll() {
    if (isRunning) return;
    isRunning = true;

    try {
        // Importa dinamicamente pra não quebrar se lib não estiver instalada
        let solana;
        try {
            solana = require('@solana/web3.js');
        } catch (_) {
            logger.warn('⚠️ solMonitor: @solana/web3.js não instalado — rode: npm install @solana/web3.js');
            isRunning = false;
            return;
        }

        if (!connection) {
            connection = new solana.Connection(SOL_RPC, 'confirmed');
        }

        const orders = await BuyOrder.find({
            currency: 'SOL',
            status: 'pending',
            expiresAt: { $gt: new Date() }
        }).limit(50);

        if (orders.length === 0) {
            isRunning = false;
            return;
        }

        logger.info(`🔍 SOL: checando ${orders.length} pedido(s)`);

        for (const order of orders) {
            try {
                const pubkey = new solana.PublicKey(order.depositAddress);
                const balanceLamports = await connection.getBalance(pubkey);
                if (balanceLamports === 0) continue;

                const balanceSol = balanceLamports / 1e9;
                logger.info(`💰 SOL recebido em ${order.depositAddress}: ${balanceSol} SOL`);

                const updated = await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'pending' },
                    {
                        $set: {
                            status: 'paid',
                            paidAt: new Date(),
                            paymentTxHash: 'sol_check',
                            paymentConfirmations: 1
                        }
                    },
                    { new: true }
                );

                if (updated) {
                    logger.info(`✅ SOL pago: ${order.orderId} (${balanceSol} SOL)`);
                }
            } catch (err) {
                logger.warn(`⚠️ Erro SOL ${order.orderId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`❌ solMonitor erro: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

// ============================================
// START/STOP
// ============================================
function start() {
    if (!SOL_ADDRESS) {
        logger.info('⚠️ solMonitor DESATIVADO (BUY_SOL_ADDRESS não configurado)');
        return;
    }

    if (intervalHandle) return;

    logger.info(`✅ solMonitor ATIVO (${SOL_ADDRESS.substring(0, 8)}..., ${SOL_RPC})`);
    intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        logger.info('🛑 solMonitor parado');
    }
}

module.exports = { start, stop, poll };
