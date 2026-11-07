// services/buy/monitors/btcMonitor.js
// ============================================
// Monitor de pagamentos Bitcoin
// v3 — rastreia TX real, dedupe por txHash, confirmações reais,
//       valida valor, alinhado ao schema do BuyOrder
// ============================================

const axios = require('axios');
const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

// ===== CONFIG =====
const BTC_API              = process.env.BUY_BTC_API || 'https://blockstream.info/api';
const BTC_API_FALLBACK     = process.env.BUY_BTC_API_FALLBACK || 'https://mempool.space/api';
const BTC_CONFIRMATIONS    = parseInt(process.env.BUY_BTC_CONFIRMATIONS || '2');
const BTC_AMOUNT_TOLERANCE = parseFloat(process.env.BUY_BTC_AMOUNT_TOLERANCE || '0.02');
const POLL_INTERVAL_MS     = 30 * 1000;
const PER_ORDER_TIMEOUT    = 15000;

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
    if (err.response?.status === 429 || err.code === 'ECONNABORTED' || (err.response?.status || 0) >= 500) {
      const other = currentApiBase === BTC_API ? BTC_API_FALLBACK : BTC_API;
      logger.warn(`[btcMonitor] ${currentApiBase} falhou (${err.response?.status || err.code}), tentando ${other}`);
      currentApiBase = other;
      return await tryBase(other);
    }
    throw err;
  }
}

// ============================================
// TIP HEIGHT (cache 15s)
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
// VALIDA VALOR
// ============================================
function valueMatches(expectedSats, receivedSats, tolerance) {
  if (!expectedSats) return true;
  const expected = BigInt(expectedSats);
  const received = BigInt(receivedSats);
  if (expected === 0n) return received > 0n;
  const diff = received > expected ? received - expected : expected - received;
  const maxDiff = (expected * BigInt(Math.round(tolerance * 10000))) / 10000n;
  return diff <= maxDiff;
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

    // Ignora tx de saída (change)
    const isOutgoing = (tx.vin || []).some(v =>
      v.prevout?.scriptpubkey_address === addr
    );
    if (isOutgoing) continue;

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

    // Valida valor
    if (!valueMatches(order.expectedPaymentAmount, amountSats, BTC_AMOUNT_TOLERANCE)) {
      logger.warn(
        `[btcMonitor] ${order.orderId}: valor diferente ` +
        `(esperado ${order.expectedPaymentAmount} sats, recebido ${amountSats}) — ignorando`
      );
      continue;
    }

    const isPaid = confirmations >= BTC_CONFIRMATIONS;

    // Dedupe por txHash
    const updated = await BuyOrder.findOneAndUpdate(
      {
        orderId: order.orderId,
        status: { $in: ['pending', 'detected'] },
        paymentTxHash: { $ne: txid }
      },
      {
        $set: {
          paymentTxHash: txid,
          paymentAmount: amountSats.toString(),
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
      const btc = (amountSats / 1e8).toFixed(8);
      if (isPaid) {
        logger.info(`✅ BTC PAGO: ${order.orderId} — ${btc} BTC (${confirmations} conf, tx ${txid.slice(0, 12)}…)`);
      } else {
        logger.info(`⏳ BTC detectado: ${order.orderId} — ${btc} BTC (${confirmations}/${BTC_CONFIRMATIONS} conf)`);
      }
      return; // 1 tx por pedido já basta
    }
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
      currency: 'BTC',
      paymentNetwork: 'bitcoin',
      status: { $in: ['pending', 'detected'] },
      expiresAt: { $gt: new Date() }
    }).limit(50);

    if (orders.length === 0) {
      isRunning = false;
      return;
    }

    const tipHeight = await getTipHeight();

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
    logger.error(`[btcMonitor] poll erro: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

// ============================================
// START / STOP
// ============================================
function start() {
  if (process.env.BUY_BTC_ENABLED === 'false') {
    logger.info('⚠️ btcMonitor DESATIVADO (BUY_BTC_ENABLED=false)');
    return;
  }
  if (intervalHandle) return;

  logger.info(`✅ btcMonitor ATIVO (${BTC_CONFIRMATIONS} conf, ${POLL_INTERVAL_MS / 1000}s)`);
  intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
  poll();
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('🛑 btcMonitor parado');
  }
}

module.exports = { start, stop, poll };
