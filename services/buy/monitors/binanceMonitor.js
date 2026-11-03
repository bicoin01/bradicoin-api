// services/buy/monitors/binanceMonitor.js
// ============================================
// Monitor de pagamentos Binance Chain (BNB + BEP-20)
// ============================================
// Monitora:
//   1. BNB nativo (envio direto pro endereço de depósito)
//   2. USDT BEP-20 (contrato 0x55d3...)
//
// Se BUY_BNB_ADDRESS não estiver no .env, desativa.
// Se BUY_USDT_BNB_ADDRESS não estiver no .env, desativa só o USDT-BEP20.
//
// ============================================

const { ethers } = require('ethers');
const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

// ===== CONFIG =====
const BNB_ADDRESS = process.env.BUY_BNB_ADDRESS || null;
const BNB_RPC = process.env.BUY_BNB_RPC || 'https://bsc-dataseed.binance.org';
const BNB_CONFIRMATIONS = parseInt(process.env.BUY_BNB_CONFIRMATIONS || '15');

const USDT_BNB_ADDRESS = process.env.BUY_USDT_BNB_ADDRESS || null;
const USDT_BNB_CONTRACT = process.env.BUY_USDT_CONTRACT_BNB || '0x55d398326f99059fF775485246999027B3197955';
const USDT_CONFIRMATIONS = parseInt(process.env.BUY_USDT_BNB_CONFIRMATIONS || '15');

const POLL_INTERVAL_MS = 30 * 1000; // 30 segundos

// ===== ABI MÍNIMA ERC-20 =====
const ERC20_ABI = [
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)'
];

// ===== ESTADO =====
let provider = null;
let usdtContract = null;
let usdtDecimals = null;
let intervalHandle = null;
let isRunning = false;

// ============================================
// INICIALIZA PROVIDER
// ============================================
function getProvider() {
    if (!provider) {
        provider = new ethers.JsonRpcProvider(BNB_RPC, {
            chainId: 56,
            name: 'bsc'
        }, {
            staticNetwork: true
        });
    }
    return provider;
}

async function getUsdtContract() {
    if (!usdtContract) {
        usdtContract = new ethers.Contract(USDT_BNB_CONTRACT, ERC20_ABI, getProvider());
        try {
            usdtDecimals = await usdtContract.decimals();
        } catch (_) {
            usdtDecimals = 18n; // BEP-20 USDT da Binance usa 18 decimals
        }
    }
    return usdtContract;
}

// ============================================
// VERIFICA SALDO BNB NATIVO
// ============================================
async function checkBnbNativeOrders() {
    if (!BNB_ADDRESS) return;

    try {
        const orders = await BuyOrder.find({
            currency: 'BNB',
            status: 'pending',
            expiresAt: { $gt: new Date() }
        }).limit(50);

        if (orders.length === 0) return;

        logger.info(`🔍 BNB: checando ${orders.length} pedido(s) pending`);

        const p = getProvider();

        for (const order of orders) {
            try {
                // Confere se o endereço de depósito é válido
                if (!ethers.isAddress(order.depositAddress)) {
                    logger.warn(`⚠️ Endereço BNB inválido: ${order.depositAddress}`);
                    continue;
                }

                const balanceWei = await p.getBalance(order.depositAddress);

                if (balanceWei === 0n) continue;

                const balanceBnb = parseFloat(ethers.formatEther(balanceWei));

                // ⚠️ Verificação mínima: BNB chegou. Para produção,
                //    você compararia com um valor mínimo esperado.
                logger.info(`💰 BNB recebido em ${order.depositAddress}: ${balanceBnb} BNB`);

                // Marca como pago
                const updated = await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'pending' },
                    {
                        $set: {
                            status: 'paid',
                            paidAt: new Date(),
                            paymentTxHash: `bnb_balance_${balanceWei.toString()}`,
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
        logger.error(`❌ binanceMonitor BNB nativo erro: ${err.message}`);
    }
}

// ============================================
// VERIFICA SALDO USDT BEP-20
// ============================================
async function checkUsdtBep20Orders() {
    if (!USDT_BNB_ADDRESS) return;

    try {
        // Busca pedidos que o usuário escolheu pagar com USDT (na BNB)
        const orders = await BuyOrder.find({
            currency: 'USDT',
            status: 'pending',
            expiresAt: { $gt: new Date() }
        }).limit(50);

        if (orders.length === 0) return;

        // Filtra só os que têm depositAddress BEP-20 configurado
        const validOrders = orders.filter(o => 
            ethers.isAddress(o.depositAddress)
        );

        if (validOrders.length === 0) return;

        logger.info(`🔍 USDT-BEP20: checando ${validOrders.length} pedido(s)`);

        const contract = await getUsdtContract();
        const decimals = usdtDecimals ?? 18n;

        for (const order of validOrders) {
            try {
                const balance = await contract.balanceOf(order.depositAddress);

                if (balance === 0n) continue;

                const balanceUsdt = parseFloat(
                    ethers.formatUnits(balance, decimals)
                );

                logger.info(`💰 USDT-BEP20 recebido em ${order.depositAddress}: ${balanceUsdt} USDT`);

                const updated = await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'pending' },
                    {
                        $set: {
                            status: 'paid',
                            paidAt: new Date(),
                            paymentTxHash: `usdt_bep20_${balance.toString()}`,
                            paymentConfirmations: USDT_CONFIRMATIONS
                        }
                    },
                    { new: true }
                );

                if (updated) {
                    logger.info(`✅ USDT-BEP20 pago: ${order.orderId} (${balanceUsdt} USDT)`);
                }
            } catch (err) {
                logger.warn(`⚠️ Erro USDT-BEP20 ${order.orderId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`❌ binanceMonitor USDT-BEP20 erro: ${err.message}`);
    }
}

// ============================================
// LOOP PRINCIPAL
// ============================================
async function poll() {
    if (isRunning) return;
    isRunning = true;

    try {
        // Roda os dois em sequência pra não sobrecarregar o RPC
        await checkBnbNativeOrders();
        await checkUsdtBep20Orders();
    } catch (err) {
        logger.error(`❌ binanceMonitor poll erro: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

// ============================================
// START/STOP
// ============================================
function start() {
    const hasBnb = !!BNB_ADDRESS;
    const hasUsdt = !!USDT_BNB_ADDRESS;

    if (!hasBnb && !hasUsdt) {
        logger.info('⚠️ binanceMonitor DESATIVADO (BUY_BNB_ADDRESS e BUY_USDT_BNB_ADDRESS não configurados)');
        return;
    }

    if (intervalHandle) return;

    logger.info(`✅ binanceMonitor ATIVO (RPC: ${BNB_RPC.substring(0, 30)}...)`);
    if (hasBnb) {
        logger.info(`   ├─ BNB nativo: ${BNB_ADDRESS.substring(0, 10)}... (${BNB_CONFIRMATIONS} conf)`);
    } else {
        logger.info('   ├─ BNB nativo: ⚠️ DESATIVADO');
    }
    if (hasUsdt) {
        logger.info(`   └─ USDT BEP-20: ${USDT_BNB_ADDRESS.substring(0, 10)}... (${USDT_CONFIRMATIONS} conf)`);
    } else {
        logger.info('   └─ USDT BEP-20: ⚠️ DESATIVADO');
    }

    intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        logger.info('🛑 binanceMonitor parado');
    }
}

// ============================================
// EXPORT
// ============================================
module.exports = {
    start,
    stop,
    poll,
    checkBnbNativeOrders,
    checkUsdtBep20Orders
};
