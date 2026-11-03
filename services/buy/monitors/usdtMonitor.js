// services/buy/monitors/usdtMonitor.js
// ============================================
// Monitor de pagamentos USDT (ERC-20 e BEP-20)
// ============================================
// Consulta eventos 'Transfer' dos contratos USDT.
//
// Se BUY_USDT_ETH_ADDRESS e/ou BUY_USDT_BNB_ADDRESS não estiverem
// no .env, cada monitor desativa.
//
// ============================================

const { ethers } = require('ethers');
const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

const POLL_INTERVAL_MS = 30 * 1000;

// ABIs mínimas pra ler Transfer e balanceOf
const ERC20_ABI = [
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)'
];

// ===== ETH USDT =====
const USDT_ETH_ADDRESS = process.env.BUY_USDT_ETH_ADDRESS || null;
const USDT_ETH_CONTRACT = process.env.BUY_USDT_CONTRACT_ETH || '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const ETH_RPC = process.env.BUY_ETH_RPC || 'https://eth.llamarpc.com';

// ===== BNB USDT =====
const USDT_BNB_ADDRESS = process.env.BUY_USDT_BNB_ADDRESS || null;
const USDT_BNB_CONTRACT = process.env.BUY_USDT_CONTRACT_BNB || '0x55d398326f99059fF775485246999027B3197955';
const BNB_RPC = process.env.BUY_BNB_RPC || 'https://bsc-dataseed.binance.org';

let ethProvider = null;
let bnbProvider = null;
let ethInterval = null;
let bnbInterval = null;
let ethRunning = false;
let bnbRunning = false;

// ============================================
// CHECA USDT NA ETHEREUM
// ============================================
async function checkEthUsdtOrders() {
    if (ethRunning) return;
    ethRunning = true;

    try {
        const orders = await BuyOrder.find({
            currency: 'USDT',
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

        const usdtContract = new ethers.Contract(USDT_ETH_CONTRACT, ERC20_ABI, ethProvider);
        const decimals = await usdtContract.decimals().catch(() => 6n);

        logger.info(`🔍 USDT-ETH: checando ${orders.length} pedido(s)`);

        for (const order of orders) {
            try {
                const balance = await usdtContract.balanceOf(order.depositAddress);
                if (balance === 0n) continue;

                const balanceUsdt = parseFloat(ethers.formatUnits(balance, decimals));
                logger.info(`💰 USDT-ETH recebido em ${order.depositAddress}: ${balanceUsdt} USDT`);

                const updated = await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'pending' },
                    {
                        $set: {
                            status: 'paid',
                            paidAt: new Date(),
                            paymentTxHash: 'usdt_eth_check',
                            paymentConfirmations: 12
                        }
                    },
                    { new: true }
                );

                if (updated) {
                    logger.info(`✅ USDT-ETH pago: ${order.orderId}`);
                }
            } catch (err) {
                logger.warn(`⚠️ Erro USDT-ETH ${order.orderId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`❌ usdtMonitor ETH erro: ${err.message}`);
    } finally {
        ethRunning = false;
    }
}

// ============================================
// CHECA USDT NA BNB
// ============================================
async function checkBnbUsdtOrders() {
    if (bnbRunning) return;
    bnbRunning = true;

    try {
        const orders = await BuyOrder.find({
            currency: 'USDT',
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

        const usdtContract = new ethers.Contract(USDT_BNB_CONTRACT, ERC20_ABI, bnbProvider);
        const decimals = await usdtContract.decimals().catch(() => 18n);

        logger.info(`🔍 USDT-BNB: checando ${orders.length} pedido(s)`);

        for (const order of orders) {
            try {
                const balance = await usdtContract.balanceOf(order.depositAddress);
                if (balance === 0n) continue;

                const balanceUsdt = parseFloat(ethers.formatUnits(balance, decimals));
                logger.info(`💰 USDT-BNB recebido em ${order.depositAddress}: ${balanceUsdt} USDT`);

                const updated = await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'pending' },
                    {
                        $set: {
                            status: 'paid',
                            paidAt: new Date(),
                            paymentTxHash: 'usdt_bnb_check',
                            paymentConfirmations: 15
                        }
                    },
                    { new: true }
                );

                if (updated) {
                    logger.info(`✅ USDT-BNB pago: ${order.orderId}`);
                }
            } catch (err) {
                logger.warn(`⚠️ Erro USDT-BNB ${order.orderId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`❌ usdtMonitor BNB erro: ${err.message}`);
    } finally {
        bnbRunning = false;
    }
}

// ============================================
// START/STOP
// ============================================
function start() {
    if (USDT_ETH_ADDRESS) {
        if (!ethInterval) {
            logger.info(`✅ usdtMonitor ETH ATIVO (${USDT_ETH_CONTRACT.substring(0, 10)}...)`);
            ethInterval = setInterval(checkEthUsdtOrders, POLL_INTERVAL_MS);
        }
    } else {
        logger.info('⚠️ usdtMonitor ETH DESATIVADO (BUY_USDT_ETH_ADDRESS não configurado)');
    }

    if (USDT_BNB_ADDRESS) {
        if (!bnbInterval) {
            logger.info(`✅ usdtMonitor BNB ATIVO (${USDT_BNB_CONTRACT.substring(0, 10)}...)`);
            bnbInterval = setInterval(checkBnbUsdtOrders, POLL_INTERVAL_MS);
        }
    } else {
        logger.info('⚠️ usdtMonitor BNB DESATIVADO (BUY_USDT_BNB_ADDRESS não configurado)');
    }
}

function stop() {
    if (ethInterval) { clearInterval(ethInterval); ethInterval = null; }
    if (bnbInterval) { clearInterval(bnbInterval); bnbInterval = null; }
    logger.info('🛑 usdtMonitor parado');
}

module.exports = { start, stop, checkEthUsdtOrders, checkBnbUsdtOrders };
