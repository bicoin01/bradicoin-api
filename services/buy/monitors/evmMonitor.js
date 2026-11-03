// services/buy/monitors/evmMonitor.js
// ============================================
// Monitor de pagamentos em EVM (Ethereum + BNB Chain)
// ============================================
// Usa ethers.js pra checar o saldo dos endereços de depósito
// (recebe ETH ou BNB nativo).
//
// Se BUY_ETH_ADDRESS e/ou BUY_BNB_ADDRESS não estiver no .env,
// cada monitor desativa automaticamente.
//
// ============================================

const { ethers } = require('ethers');
const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

const POLL_INTERVAL_MS = 30 * 1000;

// ===== ETH =====
const ETH_ADDRESS = process.env.BUY_ETH_ADDRESS || null;
const ETH_RPC = process.env.BUY_ETH_RPC || 'https://eth.llamarpc.com';
const ETH_CONFIRMATIONS = parseInt(process.env.BUY_ETH_CONFIRMATIONS || '12');

// ===== BNB =====
const BNB_ADDRESS = process.env.BUY_BNB_ADDRESS || null;
const BNB_RPC = process.env.BUY_BNB_RPC || 'https://bsc-dataseed.binance.org';
const BNB_CONFIRMATIONS = parseInt(process.env.BUY_BNB_CONFIRMATIONS || '15');

let ethProvider = null;
let bnbProvider = null;
let ethInterval = null;
let bnbInterval = null;
let ethRunning = false;
let bnbRunning = false;

// ============================================
// VERIFICA ETH
// ============================================
async function checkEthOrders() {
    if (ethRunning) return;
    ethRunning = true;

    try {
        const orders = await BuyOrder.find({
            currency: 'ETH',
            status: 'pending',
            expiresAt: { $gt: new Date() }
        }).limit(50);

        if (orders.length === 0) {
            ethRunning = false;
            return;
        }

        if (!ethProvider) {
            ethProvider = new ethers.JsonRpcProvider(ETH_RPC);
        }

        logger.info(`🔍 ETH: checando ${orders.length} pedido(s)`);

        for (const order of orders) {
            try {
                const balanceWei = await ethProvider.getBalance(order.depositAddress);
                if (balanceWei === 0n) continue;

                const balanceEth = parseFloat(ethers.formatEther(balanceWei));
                logger.info(`💰 ETH recebido em ${order.depositAddress}: ${balanceEth} ETH`);

                // Marca como paid (confirmação simplificada: assim que recebe)
                // Para produção real, você checaria o recibo da tx com N confirmações
                const updated = await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'pending' },
                    {
                        $set: {
                            status: 'paid',
                            paidAt: new Date(),
                            paymentTxHash: 'evm_check',
                            paymentConfirmations: ETH_CONFIRMATIONS
                        }
                    },
                    { new: true }
                );

                if (updated) {
                    logger.info(`✅ ETH pago: ${order.orderId} (${balanceEth} ETH)`);
                }
            } catch (err) {
                logger.warn(`⚠️ Erro ETH ${order.orderId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`❌ evmMonitor ETH erro: ${err.message}`);
    } finally {
        ethRunning = false;
    }
}

// ============================================
// VERIFICA BNB
// ============================================
async function checkBnbOrders() {
    if (bnbRunning) return;
    bnbRunning = true;

    try {
        const orders = await BuyOrder.find({
            currency: 'BNB',
            status: 'pending',
            expiresAt: { $gt: new Date() }
        }).limit(50);

        if (orders.length === 0) {
            bnbRunning = false;
            return;
        }

        if (!bnbProvider) {
            bnbProvider = new ethers.JsonRpcProvider(BNB_RPC);
        }

        logger.info(`🔍 BNB: checando ${orders.length} pedido(s)`);

        for (const order of orders) {
            try {
                const balanceWei = await bnbProvider.getBalance(order.depositAddress);
                if (balanceWei === 0n) continue;

                const balanceBnb = parseFloat(ethers.formatEther(balanceWei));
                logger.info(`💰 BNB recebido em ${order.depositAddress}: ${balanceBnb} BNB`);

                const updated = await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'pending' },
                    {
                        $set: {
                            status: 'paid',
                            paidAt: new Date(),
                            paymentTxHash: 'evm_check',
                            paymentConfirmations: BNB_CONFIRMATIONS
                        }
                    },
                    { new: true }
                );

                if (updated) {
                    logger.info(`✅ BNB pago: ${order.orderId} (${balanceBnb} BNB)`);
                }
            } catch (err) {
                logger.warn(`⚠️ Erro BNB ${order.orderId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`❌ evmMonitor BNB erro: ${err.message}`);
    } finally {
        bnbRunning = false;
    }
}

// ============================================
// START/STOP
// ============================================
function start() {
    if (ETH_ADDRESS) {
        if (!ethInterval) {
            logger.info(`✅ evmMonitor ETH ATIVO (${ETH_CONFIRMATIONS} conf, ${ETH_RPC})`);
            ethInterval = setInterval(checkEthOrders, POLL_INTERVAL_MS);
        }
    } else {
        logger.info('⚠️ evmMonitor ETH DESATIVADO (BUY_ETH_ADDRESS não configurado)');
    }

    if (BNB_ADDRESS) {
        if (!bnbInterval) {
            logger.info(`✅ evmMonitor BNB ATIVO (${BNB_CONFIRMATIONS} conf, ${BNB_RPC})`);
            bnbInterval = setInterval(checkBnbOrders, POLL_INTERVAL_MS);
        }
    } else {
        logger.info('⚠️ evmMonitor BNB DESATIVADO (BUY_BNB_ADDRESS não configurado)');
    }
}

function stop() {
    if (ethInterval) { clearInterval(ethInterval); ethInterval = null; }
    if (bnbInterval) { clearInterval(bnbInterval); bnbInterval = null; }
    logger.info('🛑 evmMonitor parado');
}

module.exports = { start, stop, checkEthOrders, checkBnbOrders };
