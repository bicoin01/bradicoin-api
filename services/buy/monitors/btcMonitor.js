// services/buy/monitors/btcMonitor.js
// ============================================
// Monitor de pagamentos Bitcoin
// ============================================
// Consulta a API pública do Blockstream (Esplora) a cada 30s
// pra ver se algum pedido 'pending' recebeu pagamento no endereço.
//
// Se BUY_BTC_ADDRESS não estiver no .env, o monitor fica desativado.
//
// ============================================

const axios = require('axios');
const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

// ===== CONFIG =====
const BTC_ADDRESS = process.env.BUY_BTC_ADDRESS || null;
const BTC_API = process.env.BUY_BTC_API || 'https://blockstream.info/api';
const BTC_CONFIRMATIONS = parseInt(process.env.BUY_BTC_CONFIRMATIONS || '2');
const POLL_INTERVAL_MS = 30 * 1000; // 30 segundos

let intervalHandle = null;
let isRunning = false;

// ============================================
// CONSULTA A API DO BLOCKSTREAM
// ============================================
async function getAddressTxs(address) {
    const url = `${BTC_API}/address/${address}/txs`;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data || [];
}

async function getTxConfirmations(txid) {
    try {
        const url = `${BTC_API}/tx/${txid}/status`;
        const res = await axios.get(url, { timeout: 10000 });
        return {
            confirmed: res.data.confirmed || false,
            block_height: res.data.block_height || null
        };
    } catch (err) {
        return { confirmed: false, block_height: null };
    }
}

// ============================================
// VERIFICA UM PEDIDO ESPECÍFICO
// ============================================
async function checkOrder(order) {
    try {
        // Pega transações do endereço de depósito
        const txs = await getAddressTxs(order.depositAddress);
        if (!txs || txs.length === 0) return;

        // Procura tx que enviou pro nosso endereço
        // (a API do Blockstream retorna txs onde o endereço aparece,
        //  então filtramos pelas que têm 'vout' pro nosso endereço)
        for (const tx of txs) {
            const txid = tx.txid;

            // Verifica se a saída vai pro nosso endereço
            const vout = (tx.vout || []).find(v => 
                v.scriptpubkey_address === order.depositAddress
            );
            if (!vout) continue;

            const amountSats = vout.value || 0;
            if (amountSats <= 0) continue;

            // Verifica confirmações
            const { confirmed, block_height } = await getTxConfirmations(txid);
            if (!confirmed) continue;

            // Conta confirmações: pega altura atual e subtrai
            // (simplificação: se confirmou 1 bloco, já conta como confirmado)
            // Para contar confirmações reais, precisaríamos do tip height.
            // Aqui usamos uma abordagem simples: se confirmou, conta como 1.
            // Para produção, consultar /blocks/tip/height e calcular.
            let confirmations = 1;
            try {
                const tipRes = await axios.get(`${BTC_API}/blocks/tip/height`, { timeout: 5000 });
                const tipHeight = parseInt(tipRes.data);
                confirmations = tipHeight - block_height + 1;
            } catch (_) {}

            // Já tem confirmações suficientes?
            if (confirmations >= BTC_CONFIRMATIONS) {
                // Marca como 'paid'
                const updated = await BuyOrder.findOneAndUpdate(
                    { orderId: order.orderId, status: 'pending' },
                    {
                        $set: {
                            status: 'paid',
                            paidAt: new Date(),
                            paymentTxHash: txid,
                            paymentConfirmations: confirmations
                        }
                    },
                    { new: true }
                );

                if (updated) {
                    logger.info(`💰 BTC pago: ${order.orderId} (${amountSats} sats, ${confirmations} conf, tx: ${txid.substring(0, 12)}...)`);
                }
                return;
            }
        }
    } catch (err) {
        logger.warn(`⚠️ Erro ao checar pedido BTC ${order.orderId}: ${err.message}`);
    }
}

// ============================================
// LOOP PRINCIPAL
// ============================================
async function poll() {
    if (isRunning) return;
    isRunning = true;

    try {
        // Pega todos pedidos pending em BTC
        const orders = await BuyOrder.find({
            currency: 'BTC',
            status: 'pending',
            expiresAt: { $gt: new Date() }
        }).limit(50);

        if (orders.length === 0) {
            isRunning = false;
            return;
        }

        logger.info(`🔍 BTC: checando ${orders.length} pedido(s) pending`);

        for (const order of orders) {
            await checkOrder(order);
        }
    } catch (err) {
        logger.error(`❌ btcMonitor erro: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

// ============================================
// START/STOP
// ============================================
function start() {
    if (!BTC_ADDRESS) {
        logger.info('⚠️ btcMonitor DESATIVADO (BUY_BTC_ADDRESS não configurado)');
        return;
    }

    if (intervalHandle) return;

    logger.info(`✅ btcMonitor ATIVO (endereço: ${BTC_ADDRESS.substring(0, 12)}..., ${BTC_CONFIRMATIONS} confirmações, a cada ${POLL_INTERVAL_MS/1000}s)`);
    intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        logger.info('🛑 btcMonitor parado');
    }
}

module.exports = { start, stop, poll };
