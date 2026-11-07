// services/buy/monitors/binanceMonitor.js
// ============================================
// Monitor de pagamentos Binance Chain (BNB nativo + USDT-BEP20)
// v3 — rastreia TX real, dedupe por txHash, confirmações reais,
//       valida valor, alinhado ao schema do BuyOrder
// ============================================

const { ethers } = require('ethers');
const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

// ===== CONFIG =====
const BNB_RPC             = process.env.BUY_BNB_RPC || 'https://bsc-dataseed.binance.org';
const BNB_RPC_FALLBACK    = process.env.BUY_BNB_RPC_FALLBACK || 'https://bsc-dataseed1.defibit.io';
const BNB_CONFIRMATIONS   = parseInt(process.env.BUY_BNB_CONFIRMATIONS || '15');
const USDT_BEP20_CONTRACT = process.env.BUY_USDT_CONTRACT_BNB || '0x55d398326f99059fF775485246999027B3197955';
const USDT_CONFIRMATIONS  = parseInt(process.env.BUY_USDT_BEP20_CONFIRMATIONS || '15');
const AMOUNT_TOLERANCE    = parseFloat(process.env.BUY_BNB_AMOUNT_TOLERANCE || '0.02');

const POLL_INTERVAL_MS    = 30 * 1000;
const MAX_BLOCKS_PER_POLL = 200;
const LOOKBACK_BLOCKS     = 100;

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)'
];

// ===== ESTADO =====
let provider = null;
let usdtContract = null;
let usdtDecimals = 18n;
let intervalHandle = null;
let isRunning = false;
let lastProcessedBlock = null;

// ============================================
// PROVIDER
// ============================================
function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(
      BNB_RPC,
      { chainId: 56, name: 'bsc' },
      { staticNetwork: true }
    );
    provider.on?.('error', () => {
      logger.warn('[binanceMonitor] RPC primário falhou, usando fallback');
      provider = new ethers.JsonRpcProvider(
        BNB_RPC_FALLBACK,
        { chainId: 56, name: 'bsc' },
        { staticNetwork: true }
      );
    });
  }
  return provider;
}

async function getUsdtContract() {
  if (!usdtContract) {
    usdtContract = new ethers.Contract(USDT_BEP20_CONTRACT, ERC20_ABI, getProvider());
    try { usdtDecimals = await usdtContract.decimals(); }
    catch { usdtDecimals = 18n; }
  }
  return usdtContract;
}

// ============================================
// HELPERS
// ============================================
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
// REGISTRA PAGAMENTO (com dedupe + confirmações)
// ============================================
async function registerPayment(order, info) {
  try {
    const currentBlock = await getProvider().getBlockNumber();
    const confirmations = Math.max(0, currentBlock - info.blockNumber + 1);
    const isPaid = confirmations >= info.requiredConfirmations;

    const valueOk = valueMatches(
      order.expectedPaymentAmount,
      info.rawAmount,
      AMOUNT_TOLERANCE
    );
    if (!valueOk) {
      logger.warn(
        `[binanceMonitor] ${order.orderId}: valor diferente do esperado ` +
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
          `✅ ${info.asset} PAGO: ${order.orderId} — ${info.displayAmount} ` +
          `(${confirmations} conf, tx ${info.txHash.slice(0, 12)}…)`
        );
      } else {
        logger.info(
          `⏳ ${info.asset} detectado: ${order.orderId} — ${info.displayAmount} ` +
          `(${confirmations}/${info.requiredConfirmations} conf)`
        );
      }
    }
  } catch (err) {
    logger.warn(`[binanceMonitor] registerPayment ${order.orderId}: ${err.message}`);
  }
}

// ============================================
// SCAN — BNB NATIVO
// ============================================
async function scanBnbNative(fromBlock, toBlock) {
  const p = getProvider();

  const orders = await BuyOrder.find({
    currency: 'BNB',
    paymentNetwork: 'bsc',
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
          displayAmount: `${parseFloat(display).toFixed(8)} BNB`,
          asset: 'BNB',
          blockNumber: bn,
          requiredConfirmations: BNB_CONFIRMATIONS
        });
      }
    }
  }
}

// ============================================
// SCAN — USDT BEP-20
// ============================================
async function scanUsdtBep20(fromBlock, toBlock) {
  const contract = await getUsdtContract();
  const decimals = usdtDecimals ?? 18n;

  const orders = await BuyOrder.find({
    currency: 'USDT',
    paymentNetwork: 'bsc',
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

  const targets = Array.from(byAddress.keys());
  if (targets.length === 0) return;

  for (let bn = fromBlock; bn <= toBlock; bn += MAX_BLOCKS_PER_POLL) {
    const end = Math.min(bn + MAX_BLOCKS_PER_POLL - 1, toBlock);

    let events;
    try {
      events = await contract.queryFilter(
        contract.filters.Transfer(null, targets),
        bn,
        end
      );
    } catch (err) {
      logger.warn(`[binanceMonitor] queryFilter USDT ${bn}-${end}: ${err.message}`);
      continue;
    }

    for (const ev of events) {
      const to = normalizeAddress(ev.args.to);
      const matchedOrders = byAddress.get(to);
      if (!matchedOrders) continue;

      const display = ethers.formatUnits(ev.args.value, decimals);
      for (const order of matchedOrders) {
        await registerPayment(order, {
          txHash: ev.transactionHash,
          rawAmount: ev.args.value,
          displayAmount: `${parseFloat(display).toFixed(6)} USDT`,
          asset: 'USDT-BEP20',
          blockNumber: ev.blockNumber,
          requiredConfirmations: USDT_CONFIRMATIONS
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
      logger.info(`[binanceMonitor] boot — começando do bloco ${lastProcessedBlock} (atual ${currentBlock})`);
    }

    if (currentBlock <= lastProcessedBlock) return;

    const fromBlock = lastProcessedBlock + 1;
    const toBlock = Math.min(currentBlock, fromBlock + MAX_BLOCKS_PER_POLL - 1);

    const pendingCount = await BuyOrder.countDocuments({
      currency: { $in: ['BNB', 'USDT'] },
      paymentNetwork: 'bsc',
      status: { $in: ['pending', 'detected'] }
    });

    if (pendingCount === 0) {
      lastProcessedBlock = toBlock;
      return;
    }

    await scanBnbNative(fromBlock, toBlock);
    await scanUsdtBep20(fromBlock, toBlock);

    lastProcessedBlock = toBlock;
  } catch (err) {
    logger.error(`[binanceMonitor] poll erro: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

// ============================================
// START / STOP
// ============================================
function start() {
  const bnbEnabled  = process.env.BUY_BNB_ENABLED !== 'false';
  const usdtEnabled = process.env.BUY_USDT_BEP20_ENABLED !== 'false';

  if (!bnbEnabled && !usdtEnabled) {
    logger.info('⚠️ binanceMonitor DESATIVADO (BUY_BNB_ENABLED e BUY_USDT_BEP20_ENABLED false)');
    return;
  }
  if (intervalHandle) return;

  logger.info(`✅ binanceMonitor ATIVO (RPC: ${BNB_RPC.substring(0, 30)}…)`);
  logger.info(`   ├─ BNB nativo:  ${bnbEnabled ? 'ON' : 'OFF'} (${BNB_CONFIRMATIONS} conf)`);
  logger.info(`   └─ USDT BEP-20: ${usdtEnabled ? 'ON' : 'OFF'} (${USDT_CONFIRMATIONS} conf)`);

  intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
  poll();
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('🛑 binanceMonitor parado');
  }
}

module.exports = { start, stop, poll };
