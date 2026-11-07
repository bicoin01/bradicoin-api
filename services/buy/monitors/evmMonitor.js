// services/buy/monitors/evmMonitor.js
// ============================================
// Monitor de pagamentos Ethereum (só ETH nativo)
// v3 — rastreia TX real, dedupe por txHash, confirmações reais,
//       valida valor, alinhado ao schema do BuyOrder
// ============================================
// ⚠️ BNB foi REMOVIDO daqui. BNB + USDT-BEP20 são cobertos
//    pelo binanceMonitor v3. Rodar os dois = double-detection.
// ============================================

const { ethers } = require('ethers');
const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

// ===== CONFIG =====
const ETH_RPC              = process.env.BUY_ETH_RPC || 'https://eth.llamarpc.com';
const ETH_RPC_FALLBACK     = process.env.BUY_ETH_RPC_FALLBACK || 'https://rpc.ankr.com/eth';
const ETH_CONFIRMATIONS    = parseInt(process.env.BUY_ETH_CONFIRMATIONS || '12');
const ETH_AMOUNT_TOLERANCE = parseFloat(process.env.BUY_ETH_AMOUNT_TOLERANCE || '0.02');

const POLL_INTERVAL_MS     = 30 * 1000;
const MAX_BLOCKS_PER_POLL  = 100;
const LOOKBACK_BLOCKS      = 50;

// ===== ESTADO =====
let provider = null;
let intervalHandle = null;
let isRunning = false;
let lastProcessedBlock = null;

// ============================================
// PROVIDER
// ============================================
function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(
      ETH_RPC,
      { chainId: 1, name: 'mainnet' },
      { staticNetwork: true }
    );
    provider.on?.('error', () => {
      logger.warn('[evmMonitor] RPC primário falhou, usando fallback');
      provider = new ethers.JsonRpcProvider(
        ETH_RPC_FALLBACK,
        { chainId: 1, name: 'mainnet' },
        { staticNetwork: true }
      );
    });
  }
  return provider;
}

function normalizeAddress(a) {
  try { return ethers.getAddress(a); } catch { return null; }
}

function valueMatches(expectedBaseUnits, receivedRaw, tolerance) {
  if (!expectedBaseUnits) return true;
  try {
    const expected = BigInt(expectedBaseUnits);
    const received = BigInt(receivedRaw);
    if (expected === 0n) return received > 0n;
    const diff = received > expected ? received - expected : expected - received;
    const maxDiff = (expected * BigInt(Math.round(tolerance * 10000))) / 10000n;
    return diff <= maxDiff;
  } catch {
    return true;
  }
}

// ============================================
// REGISTRA PAGAMENTO
// ============================================
async function registerPayment(order, info) {
  try {
    const currentBlock = await getProvider().getBlockNumber();
    const confirmations = Math.max(0, currentBlock - info.blockNumber + 1);
    const isPaid = confirmations >= info.requiredConfirmations;

    const valueOk = valueMatches(
      order.expectedPaymentAmount,
      info.rawAmount,
      ETH_AMOUNT_TOLERANCE
    );
    if (!valueOk) {
      logger.warn(
        `[evmMonitor] ${order.orderId}: valor diferente do esperado ` +
        `(esperado ${order.expectedPaymentAmount}, recebido ${info.rawAmount.toString()}) — ignorando`
      );
      return;
    }

    const updated = await BuyOrder.findOneAndUpdate(
      {
        orderId: order.orderId,
        status: { $in: ['pending', 'detected'] },
        paymentTxHash: { $ne: info.txHash }
      },
      {
        $set: {
          paymentTxHash: info.txHash,
          paymentAmount: info.rawAmount.toString(),
          paymentBlock: info.blockNumber,
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
        logger.info(
          `✅ ETH PAGO: ${order.orderId} — ${info.displayAmount} ` +
          `(${confirmations} conf, tx ${info.txHash.slice(0, 12)}…)`
        );
      } else {
        logger.info(
          `⏳ ETH detectado: ${order.orderId} — ${info.displayAmount} ` +
          `(${confirmations}/${info.requiredConfirmations} conf)`
        );
      }
    }
  } catch (err) {
    logger.warn(`[evmMonitor] registerPayment ${order.orderId}: ${err.message}`);
  }
}

// ============================================
// SCAN — ETH NATIVO
// ============================================
async function scanEthNative(fromBlock, toBlock) {
  const p = getProvider();

  const orders = await BuyOrder.find({
    currency: 'ETH',
    paymentNetwork: 'ethereum',
    status: { $in: ['pending', 'detected'] }
  }).limit(50);

  if (orders.length === 0) return;

  const byAddress = new Map();
  for (const o of orders) {
    const addr = normalizeAddress(o.depositAddress);
    if (!addr) continue;
    if (!byAddress.has(addr)) byAddress.set(addr, []);
    byAddress.get(addr).push(o);
  }

  for (let bn = fromBlock; bn <= toBlock; bn++) {
    let block;
    try { block = await p.getBlock(bn, true); } catch { continue; }
    if (!block || !block.transactions) continue;

    for (const tx of block.transactions) {
      if (!tx.to) continue;
      const to = normalizeAddress(tx.to);
      if (!to || !byAddress.has(to)) continue;
      if (!tx.value || tx.value === 0n) continue;

      const matchedOrders = byAddress.get(to);
      for (const order of matchedOrders) {
        const display = ethers.formatEther(tx.value);
        await registerPayment(order, {
          txHash: tx.hash,
          rawAmount: tx.value,
          displayAmount: `${parseFloat(display).toFixed(8)} ETH`,
          blockNumber: bn,
          requiredConfirmations: ETH_CONFIRMATIONS
        });
      }
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
    const p = getProvider();
    const currentBlock = await p.getBlockNumber();

    if (lastProcessedBlock === null) {
      lastProcessedBlock = Math.max(0, currentBlock - LOOKBACK_BLOCKS);
      logger.info(`[evmMonitor] boot — começando do bloco ${lastProcessedBlock} (atual ${currentBlock})`);
    }

    if (currentBlock <= lastProcessedBlock) return;

    const fromBlock = lastProcessedBlock + 1;
    const toBlock = Math.min(currentBlock, fromBlock + MAX_BLOCKS_PER_POLL - 1);

    const pendingCount = await BuyOrder.countDocuments({
      currency: 'ETH',
      paymentNetwork: 'ethereum',
      status: { $in: ['pending', 'detected'] }
    });

    if (pendingCount === 0) {
      lastProcessedBlock = toBlock;
      return;
    }

    await scanEthNative(fromBlock, toBlock);
    lastProcessedBlock = toBlock;
  } catch (err) {
    logger.error(`[evmMonitor] poll erro: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

// ============================================
// START / STOP
// ============================================
function start() {
  if (process.env.BUY_ETH_ENABLED === 'false') {
    logger.info('⚠️ evmMonitor DESATIVADO (BUY_ETH_ENABLED=false)');
    return;
  }
  if (intervalHandle) return;

  logger.info(`✅ evmMonitor ATIVO — ETH nativo (${ETH_CONFIRMATIONS} conf)`);
  intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
  poll();
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('🛑 evmMonitor parado');
  }
}

module.exports = { start, stop, poll };
