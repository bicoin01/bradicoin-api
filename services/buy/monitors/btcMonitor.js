// services/buy/monitors/btcMonitor.js
// v2 — rastreia tx real, dedupe por txHash, confirmações reais,
//      valida valor, ignora tx de saída (change/vin), cacheia tip height
// ============================================

const axios = require('axios');
const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

// ===== CONFIG =====
const BTC_ADDRESS         = process.env.BUY_BTC_ADDRESS || null;
const BTC_API             = process.env.BUY_BTC_API || 'https://blockstream.info/api';
const BTC_API_FALLBACK    = process.env.BUY_BTC_API_FALLBACK || 'https://mempool.space/api';
const BTC_CONFIRMATIONS   = parseInt(process.env.BUY_BTC_CONFIRMATIONS || '2');
const BTC_AMOUNT_TOLERANCE = parseFloat(process.env.BUY_BTC_AMOUNT_TOLERANCE || '0.02'); // 2%
const POLL_INTERVAL_MS    = 30 * 1000;
const PER_ORDER_TIMEOUT   = 15000;

// ===== ESTADO =====
let intervalHandle = null;
let isRunning = false;
let currentApiBase = BTC_API;
let tipHeightCache = { height: null, at: 0 };

// ============================================
// HTTP HELPER (com fallback + timeout)
// ============================================
async function apiGet(path, timeout = 10000) {
  const tryBase = async (base) => {
    const res = await axios.get(`${base}${path}`, { timeout });
    return res.data;
  };
  try {
    return await tryBase(currentApiBase);
  } catch (err) {
    // Se for 429 / 5xx / timeout, troca pro fallback e tenta de novo
    if (err.response?.status === 429 || err.code === 'ECONNABORTED' || err.response?.status >= 500) {
      const other = currentApiBase === BTC_API ? BTC_API_FALLBACK : BTC_API;
      logger.warn(`[btcMonitor] ${currentApiBase} falhou (${err.response?.status || err.code}), tentando ${other}`);
      currentApiBase = other;
      return await tryBase(other);
    }
    throw err;
  }
}

// ============================================
// TIP HEIGHT (cache 15s — evita 50 chamadas por poll)
// ============================================
async function getTipHeight() {
  const now = Date.now();
  if (tipHeightCache.height && (now - tipHeightCache.at) < 15000) {
    return tipHeightCache.height;
  }
  const data = await apiGet('/blocks/tip/height', 5000);
  const h = parseInt(data);
  tipHeightCache = { height: h, at: now };
  return h;
}

// ============================================
// TXS DO ENDEREÇO
// ============================================
async function getAddressTxs(address) {
  return (await apiGet(`/address/${address}/txs`, 10000)) || [];
}

// ============================================
// VERIFICA UM PEDIDO
// ============================================
async function checkOrder(order, tipHeight) {
  const addr = order.depositAddress;
  if (!addr) return;

  const txs = await getAddressTxs(addr);
  if (!txs || txs.length === 0) return;

  for (const tx of txs) {
    const txid = tx.txid;

    // Ignora tx onde nosso endereço está no input (é SAÍDA, não pagamento)
    const isOutgoing = (tx.vin || []).some(v =>
      v.prevout?.scriptpubkey_address === addr
    );
    if (isOutgoing) continue;

    // Pega só os vouts que pagam o nosso endereço
    const vouts = (tx.vout || []).filter(v =>
      v.scriptpubkey_address === addr
    );
    if (vouts.length === 0) continue;

    const amountSats = vouts.reduce((s, v) => s + (v.value || 0), 0);
    if (amountSats <= 0) continue;

    // Confirmações
    let confirmations = 0;
    let blockHeight = null;
    if (tx.status?.confirmed) {
      blockHeight = tx.status.block_height;
      confirmations = Math.max(1, tipHeight - blockHeight + 1);
    }

    // Valor esperado (se o pedido tem)
    const expectedSats = order.expectedAmountSats || order.amountSats || null;
    let valueOk = true;
    if (expectedSats && expectedSats > 0) {
      const diff = Math.abs(amountSats - expectedSats) / expectedSats;
      valueOk = diff <= BTC_AMOUNT_TOLERANCE;
    }

    const isPaid = confirmations >= BTC_CONFIRMATIONS && valueOk;

    // Dedupe: não reprocessa o mesmo txid
    const updated = await BuyOrder.findOneAndUpdate(
      {
        orderId: order.orderId,
        status: { $in: ['pending', 'detected'] },
        paymentTxHash: { $ne: txid }
      },
      {
        $set: {
          paymentTxHash: txid,
          paymentAmount: amountSats / 1e8, // em BTC
          paymentAmountSats: amountSats,
          paymentBlock: blockHeight,
          paymentConfirmations: confirmations,
          detectedAt: order.detectedAt || new Date(),
          status: isPaid ? 'paid' : 'detected',
          ...(isPaid ? { paidAt: new Date() } : {})
        }
      },
      { new: true }
    );

    if (updated) {
      if (isPaid) {
        logger.info(`💰 BTC PAGO: ${order.orderId} — ${amountSats} sats (${confirmations} conf, tx ${txid.slice(0, 12)}…)`);
      } else {
        logger.info(`⏳ BTC detectado: ${order.orderId} — ${amountSats} sats (${confirmations}/${BTC_CONFIRMATIONS} conf)`);
      }
      return; // 1 tx por pedido já basta
    }
    // se updated == null, era duplicata ou já pago — segue pra próxima tx
  }
}

// ============================================
// LOOP
// ============================================
async function poll() {
  if (isRunning) return;
  isRunning = true;

  try {
    const orders = await BuyOrder.find({
      paymentCurrency: 'BTC',                 // ⚠️ troque pra 'currency' se for o caso
      status: { $in: ['pending', 'detected'] },
      expiresAt: { $gt: new Date() }
    }).limit(50);

    if (orders.length === 0) {
      isRunning = false;
      return;
    }

    const tipHeight = await getTipHeight();

    // Processa com concorrência limitada (2 por vez) pra não estourar a API
    const queue = [...orders];
    const CONCURRENCY = 2;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length) {
          const order = queue.shift();
          try {
            await Promise.race([
              checkOrder(order, tipHeight),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PER_ORDER_TIMEOUT))
            ]);
          } catch (err) {
            logger.warn(`[btcMonitor] pedido ${order.orderId}: ${err.message}`);
          }
        }
      })
    );
  } catch (err) {
    logger.error(`❌ btcMonitor erro: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

// ============================================
// START / STOP
// ============================================
function start() {
  if (!BTC_ADDRESS) {
    logger.info('⚠️ btcMonitor DESATIVADO (BUY_BTC_ADDRESS não configurado)');
    return;
  }
  if (intervalHandle) return;

  logger.info(`✅ btcMonitor ATIVO (endereço: ${BTC_ADDRESS.substring(0, 12)}…, ${BTC_CONFIRMATIONS} conf, ${POLL_INTERVAL_MS / 1000}s)`);
  intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
  poll(); // roda já no boot
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('🛑 btcMonitor parado');
  }
}

module.exports = { start, stop, poll };
