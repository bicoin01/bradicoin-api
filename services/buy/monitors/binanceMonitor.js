// services/buy/monitors/binanceMonitor.js
// v2 — rastreia TX (não saldo), com confirmações reais e dedupe por txHash
// ============================================

const { ethers } = require('ethers');
const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

// ===== CONFIG =====
const BNB_ADDRESS        = process.env.BUY_BNB_ADDRESS || null;
const BNB_RPC            = process.env.BUY_BNB_RPC || 'https://bsc-dataseed.binance.org';
const BNB_RPC_FALLBACK   = process.env.BUY_BNB_RPC_FALLBACK || 'https://bsc-dataseed1.defibit.io';
const BNB_CONFIRMATIONS  = parseInt(process.env.BUY_BNB_CONFIRMATIONS || '15');

const USDT_BNB_ADDRESS      = process.env.BUY_USDT_BNB_ADDRESS || null;
const USDT_BNB_CONTRACT     = process.env.BUY_USDT_CONTRACT_BNB || '0x55d398326f99059fF775485246999027B3197955';
const USDT_CONFIRMATIONS    = parseInt(process.env.BUY_USDT_BNB_CONFIRMATIONS || '15');

const POLL_INTERVAL_MS   = 30 * 1000;
const MAX_BLOCKS_PER_POLL = 200; // evita varrer 1000 blocos de uma vez
const LOOKBACK_BLOCKS    = 100;  // no boot, começa N blocos atrás

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

// Último bloco processado por rede (BNB Chain é uma só, então 1 chave)
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
    // fallback simples: se o provider atual falhar, troca
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
    usdtContract = new ethers.Contract(USDT_BNB_CONTRACT, ERC20_ABI, getProvider());
    try { usdtDecimals = await usdtContract.decimals(); }
    catch { usdtDecimals = 18n; }
  }
  return usdtContract;
}

// ============================================
// HELPERS
// ============================================
async function getLastBlock() {
  const p = getProvider();
  const current = await p.getBlockNumber();
  if (lastProcessedBlock === null) {
    lastProcessedBlock = Math.max(0, current - LOOKBACK_BLOCKS);
    logger.info(`[binanceMonitor] boot — começando do bloco ${lastProcessedBlock} (atual ${current})`);
  }
  return current;
}

function normalizeAddress(a) {
  try { return ethers.getAddress(a); } catch { return null; }
}

// ============================================
// BNB NATIVO — rastreia tx.to == depositAddress
// ============================================
async function scanBnbNative(fromBlock, toBlock) {
  if (!BNB_ADDRESS) return;

  const p = getProvider();

  // Busca pedidos pendentes (ou detectados aguardando confirmação)
  const orders = await BuyOrder.find({
    paymentCurrency: 'BNB',
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
      // tx.to é o destinatário (contrato ou EOA)
      if (!tx.to) continue;
      const to = normalizeAddress(tx.to);
      if (!to || !byAddress.has(to)) continue;

      // BNB nativo = tx.value > 0 e tx.to == endereço
      if (!tx.value || tx.value === 0n) continue;

      const matchedOrders = byAddress.get(to);
      for (const order of matchedOrders) {
        const valueBnb = parseFloat(ethers.formatEther(tx.value));
        await registerPayment(order, {
          txHash: tx.hash,
          amount: valueBnb,
          currency: 'BNB',
          blockNumber: bn,
          requiredConfirmations: BNB_CONFIRMATIONS
        });
      }
    }
  }
}

// ============================================
// USDT BEP-20 — rastreia evento Transfer
// ============================================
async function scanUsdtBep20(fromBlock, toBlock) {
  if (!USDT_BNB_ADDRESS) return;

  const contract = await getUsdtContract();
  const decimals = usdtDecimals ?? 18n;

  const orders = await BuyOrder.find({
    paymentCurrency: 'USDT_BEP20',
    status: { $in: ['pending', 'detected'] }
  }).limit(50);

  if (orders.length === 0) return;

  // Endereço de depósito → pedidos
  const byAddress = new Map();
  for (const o of orders) {
    const addr = normalizeAddress(o.depositAddress);
    if (!addr) continue;
    if (!byAddress.has(addr)) byAddress.set(addr, []);
    byAddress.get(addr).push(o);
  }

  // Lista de endereços únicos (filtro `to` do evento)
  const targets = Array.from(byAddress.keys());
  if (targets.length === 0) return;

  // Chunk de blocos pra evitar `queryFilter` pesado
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

      const amount = parseFloat(ethers.formatUnits(ev.args.value, decimals));
      for (const order of matchedOrders) {
        await registerPayment(order, {
          txHash: ev.transactionHash,
          amount,
          currency: 'USDT_BEP20',
          blockNumber: ev.blockNumber,
          requiredConfirmations: USDT_CONFIRMATIONS
        });
      }
    }
  }
}

// ============================================
// REGISTRA PAGAMENTO (dedupe + confirmações)
// ============================================
async function registerPayment(order, info) {
  try {
    const currentBlock = await getProvider().getBlockNumber();
    const confirmations = Math.max(0, currentBlock - info.blockNumber);
    const isPaid = confirmations >= info.requiredConfirmations;

    // Dedupe: só atualiza se ainda não tem esse txHash registrado
    const filter = { orderId: order.orderId, paymentTxHash: { $ne: info.txHash } };
    const update = {
      $set: {
        paymentTxHash: info.txHash,
        paymentAmount: info.amount,
        paymentCurrency: info.currency,
        paymentBlock: info.blockNumber,
        paymentConfirmations: confirmations,
        detectedAt: order.detectedAt || new Date(),
        status: isPaid ? 'paid' : 'detected'
      }
    };
    if (isPaid) update.$set.paidAt = new Date();

    const updated = await BuyOrder.findOneAndUpdate(filter, update, { new: true });

    if (updated) {
      if (isPaid) {
        logger.info(`✅ ${info.currency} PAGO: ${order.orderId} — ${info.amount} (tx ${info.txHash.slice(0, 10)}… ${confirmations} conf)`);
      } else {
        logger.info(`⏳ ${info.currency} detectado: ${order.orderId} — ${info.amount} (${confirmations}/${info.requiredConfirmations} conf)`);
      }
    }
    // se updated == null, era duplicata ou já pago — ignora silenciosamente
  } catch (err) {
    logger.warn(`[binanceMonitor] registerPayment ${order.orderId}: ${err.message}`);
  }
}

// ============================================
// LOOP
// ============================================
async function poll() {
  if (isRunning) return;
  isRunning = true;

  try {
    const currentBlock = await getLastBlock();

    if (lastProcessedBlock === null || currentBlock <= lastProcessedBlock) return;

    // Limita quantos blocos varremos por poll
    const fromBlock = lastProcessedBlock + 1;
    const toBlock = Math.min(currentBlock, fromBlock + MAX_BLOCKS_PER_POLL - 1);

    // Só loga se houver algo pendente
    const pendingCount = await BuyOrder.countDocuments({
      paymentCurrency: { $in: ['BNB', 'USDT_BEP20'] },
      status: { $in: ['pending', 'detected'] }
    });
    if (pendingCount === 0) {
      lastProcessedBlock = toBlock;
      return;
    }

    logger.debug?.(`[binanceMonitor] poll bloco ${fromBlock}→${toBlock} (${pendingCount} pendentes)`);

    if (BNB_ADDRESS)      await scanBnbNative(fromBlock, toBlock);
    if (USDT_BNB_ADDRESS) await scanUsdtBep20(fromBlock, toBlock);

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
  const hasBnb = !!BNB_ADDRESS;
  const hasUsdt = !!USDT_BNB_ADDRESS;

  if (!hasBnb && !hasUsdt) {
    logger.info('⚠️ binanceMonitor DESATIVADO (BUY_BNB_ADDRESS e BUY_USDT_BNB_ADDRESS não configurados)');
    return;
  }
  if (intervalHandle) return;

  logger.info(`✅ binanceMonitor ATIVO (RPC: ${BNB_RPC.substring(0, 30)}…)`);
  logger.info(`   ├─ BNB nativo:  ${hasBnb ? BNB_ADDRESS.substring(0, 10) + '…' : '⚠️ DESATIVADO'} (${BNB_CONFIRMATIONS} conf)`);
  logger.info(`   └─ USDT BEP-20: ${hasUsdt ? USDT_BNB_ADDRESS.substring(0, 10) + '…' : '⚠️ DESATIVADO'} (${USDT_CONFIRMATIONS} conf)`);

  intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
  poll(); // roda já no boot
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('🛑 binanceMonitor parado');
  }
}

module.exports = { start, stop, poll };
