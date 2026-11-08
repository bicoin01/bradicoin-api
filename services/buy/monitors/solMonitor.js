// services/buy/monitors/solanaMonitor.js
// v3 — rastreia TX real via getSignaturesForAddress + getParsedTransaction
//       dedupe por signature, confirmações reais, valida valor
// ============================================

const BuyOrder = require('../../../models/BuyOrder');
const { logger } = require('../../../middleware/error');

// ===== CONFIG =====
const SOL_RPC           = process.env.BUY_SOL_RPC || 'https://api.devnet.solana.com';
const SOL_RPC_FALLBACK  = process.env.BUY_SOL_RPC_FALLBACK || null;
const SOL_CONFIRMATIONS = parseInt(process.env.BUY_SOL_CONFIRMATIONS || '1');
const AMOUNT_TOLERANCE  = parseFloat(process.env.BUY_SOL_AMOUNT_TOLERANCE || '0.02');

const POLL_INTERVAL_MS  = 30 * 1000;
const LOOKBACK_SIGS     = 50;

// ===== ESTADO =====
let connection = null;
let intervalHandle = null;
let isRunning = false;
let web3 = null;

// Cache: depositAddress → última signature processada
// Evita re-processar tudo a cada poll
const lastSigByAddress = new Map();

// ============================================
// CONEXÃO (lazy)
// ============================================
function getConnection() {
    if (connection) return connection;

    try {
        web3 = require('@solana/web3.js');
    } catch (_) {
        throw new Error('@solana/web3.js não instalado — rode: npm install @solana/web3.js');
    }

    connection = new web3.Connection(SOL_RPC, 'confirmed');
    logger.info(`[solanaMonitor] conectado a ${SOL_RPC.substring(0, 40)}…`);
    return connection;
}

// ============================================
// VALIDA VALOR (com tolerância)
// ============================================
function valueMatches(expectedLamports, receivedLamports, tolerance) {
    if (!expectedLamports) return true;
    try {
        const expected = BigInt(expectedLamports);
        const received = BigInt(receivedLamports);
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
        const valueOk = valueMatches(
            order.expectedPaymentAmount,
            info.lamports,
            AMOUNT_TOLERANCE
        );
        if (!valueOk) {
            logger.warn(
                `[solanaMonitor] ${order.orderId}: valor diferente ` +
                `(esperado ${order.expectedPaymentAmount}, recebido ${info.lamports}) — ignorando`
            );
            return;
        }

        const isPaid = info.confirmed && info.confirmations >= SOL_CONFIRMATIONS;

        // Dedupe: só atualiza se ainda não tem essa signature registrada
        const updated = await BuyOrder.findOneAndUpdate(
            {
                orderId: order.orderId,
                status: { $in: ['pending', 'detected'] },
                paymentTxHash: { $ne: info.signature }
            },
            {
                $set: {
                    paymentTxHash: info.signature,
                    paymentAmount: info.lamports.toString(),
                    paymentBlock: info.slot,
                    paymentConfirmations: info.confirmations,
                    detectedAt: order.detectedAt || new Date(),
                    status: isPaid ? 'paid' : 'detected',
                    ...(isPaid ? { paidAt: new Date() } : {})
                }
            },
            { new: true }
        );

        if (updated) {
            const sol = (info.lamports / 1e9).toFixed(9);
            if (isPaid) {
                logger.info(
                    `✅ SOL PAGO: ${order.orderId} — ${sol} SOL ` +
                    `(slot ${info.slot}, ${info.confirmations} conf, sig ${info.signature.slice(0, 12)}…)`
                );
            } else {
                logger.info(
                    `⏳ SOL detectado: ${order.orderId} — ${sol} SOL ` +
                    `(${info.confirmations}/${SOL_CONFIRMATIONS} conf)`
                );
            }
        }
    } catch (err) {
        logger.warn(`[solanaMonitor] registerPayment ${order.orderId}: ${err.message}`);
    }
}

// ============================================
// VERIFICA UM PEDIDO
// ============================================
async function checkOrder(order) {
    const conn = getConnection();
    const addr = order.depositAddress;
    if (!addr) return;

    let pubkey;
    try {
        pubkey = new web3.PublicKey(addr);
    } catch {
        logger.warn(`[solanaMonitor] endereço Solana inválido: ${addr}`);
        return;
    }

    // Pega as últimas N signatures do endereço
    let sigs;
    try {
        sigs = await conn.getSignaturesForAddress(pubkey, { limit: LOOKBACK_SIGS });
    } catch (err) {
        logger.warn(`[solanaMonitor] getSignatures ${order.orderId}: ${err.message}`);
        return;
    }

    if (!sigs || sigs.length === 0) return;

    // Filtra signatures já processadas (evita reprocessar)
    const lastSig = lastSigByAddress.get(addr);
    let newSigs = sigs;

    if (lastSig) {
        const idx = sigs.findIndex(s => s.signature === lastSig);
        newSigs = idx >= 0 ? sigs.slice(0, idx) : sigs;
    }

    if (newSigs.length === 0) return;

    // Slot atual pra calcular confirmações
    let currentSlot;
    try { currentSlot = await conn.getSlot(); }
    catch { currentSlot = null; }

    // Processa em ordem cronológica (mais antiga primeiro)
    // ⚠️ NÃO usa .reverse() (mutaria o array original) — usa [...newSigs].reverse()
    for (const sigInfo of [...newSigs].reverse()) {
        if (sigInfo.err) continue;

        let tx;
        try {
            tx = await conn.getParsedTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });
        } catch (err) {
            logger.warn(
                `[solanaMonitor] getParsedTransaction ` +
                `${sigInfo.signature.slice(0, 12)}: ${err.message}`
            );
            continue;
        }

        if (!tx || !tx.meta) continue;

        // Confirmações
        const confirmations = currentSlot && sigInfo.slot
            ? Math.max(0, currentSlot - sigInfo.slot)
            : (sigInfo.confirmationStatus === 'finalized' ? 1 : 0);

        // Detecta transferência SOL pro nosso endereço via diff de balances
        const accountKeys = tx.transaction.message.accountKeys.map(k => {
            // accountKeys pode ser array de objetos {pubkey} ou strings
            return typeof k === 'string' ? k : k.pubkey.toBase58();
        });
        const ourIndex = accountKeys.indexOf(addr);

        if (ourIndex >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
            const pre = tx.meta.preBalances[ourIndex] || 0;
            const post = tx.meta.postBalances[ourIndex] || 0;
            const received = post - pre;

            if (received > 0) {
                await registerPayment(order, {
                    signature: sigInfo.signature,
                    lamports: received,
                    slot: sigInfo.slot,
                    confirmations,
                    confirmed: sigInfo.confirmationStatus === 'confirmed' ||
                               sigInfo.confirmationStatus === 'finalized'
                });
            }
        }
    }

    // Atualiza cache com a signature mais recente
    if (sigs.length > 0) {
        lastSigByAddress.set(addr, sigs[0].signature);
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
            currency: 'SOL',
            paymentNetwork: 'solana',
            status: { $in: ['pending', 'detected'] },
            expiresAt: { $gt: new Date() }
        }).limit(50);

        if (orders.length === 0) {
            isRunning = false;
            return;
        }

        for (const order of orders) {
            try {
                await checkOrder(order);
            } catch (err) {
                logger.warn(`[solanaMonitor] pedido ${order.orderId}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`[solanaMonitor] poll erro: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

// ============================================
// START / STOP
// ============================================
function start() {
    if (process.env.BUY_SOL_ENABLED === 'false') {
        logger.info('⚠️ solanaMonitor DESATIVADO (BUY_SOL_ENABLED=false)');
        return;
    }
    if (intervalHandle) return;

    // Verifica que a lib está instalada antes de ligar
    try {
        getConnection();
    } catch (err) {
        logger.error(`⚠️ solanaMonitor NÃO iniciado: ${err.message}`);
        return;
    }

    logger.info(`✅ solanaMonitor ATIVO (${SOL_CONFIRMATIONS} conf, ${POLL_INTERVAL_MS / 1000}s)`);
    intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
    poll();
}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        logger.info('🛑 solanaMonitor parado');
    }
}

module.exports = { start, stop, poll };
