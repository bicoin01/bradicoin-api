// atomic-swap/engine/htlc.js
// ============================================
// HTLC Engine — Hash Time-Locked Contract na Bradicoin
// ============================================
// Implementa lock/claim/refund usando as primitivas
// de WalletModel (debit/credit) e TransactionModel.
// ============================================

const crypto = require('crypto');
const { sha256 } = require('@noble/hashes/sha2');
const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');

const HTLCModel = require('../../models/HTLC');
const WalletModel = require('../../models/Wallet');
const TransactionModel = require('../../models/Transaction');
const wallet = require('../../wallet');
const blockchain = require('../../blockchain');

// ============================================
// CONFIG
// ============================================
const CONFIG = {
    MIN_AMOUNT: 0.00000001,
    MIN_TIMELOCK_SECONDS: 3600,          // 1h
    MAX_TIMELOCK_SECONDS: 7 * 24 * 3600, // 7 dias
    DEFAULT_TIMELOCK_SECONDS: 24 * 3600, // 24h
    HTLC_FEE_BRD: 0.001                  // taxa fixa em BRD
};

// ============================================
// HELPERS
// ============================================
function generateHtlcId() {
    return 'HTLC_' + crypto.randomBytes(16).toString('hex');
}

function generateSecret() {
    // 32 bytes random
    return crypto.randomBytes(32).toString('hex');
}

function hashSecret(secret) {
    return bytesToHex(sha256(utf8ToBytes(secret)));
}

function validateHashlock(hashlock) {
    if (!hashlock || typeof hashlock !== 'string') return false;
    return /^[a-fA-F0-9]{64}$/.test(hashlock);
}

function validateTimelock(timelock) {
    if (!Number.isFinite(timelock)) return false;
    const now = Math.floor(Date.now() / 1000);
    const delta = timelock - now;
    return delta >= CONFIG.MIN_TIMELOCK_SECONDS && delta <= CONFIG.MAX_TIMELOCK_SECONDS;
}

// ============================================
// LOCK — Cria HTLC travando fundos do sender
// ============================================
/**
 * @param {Object} opts
 * @param {string} opts.sender         - endereço Bradicoin (Br...)
 * @param {string} opts.receiver       - endereço Bradicoin (Br...)
 * @param {string|number} opts.amount  - valor em BRD
 * @param {string} opts.hashlock       - H = sha256(S) em hex
 * @param {number} opts.timelock       - unix timestamp (segundos)
 * @param {string} [opts.swapId]       - id do swap cross-chain
 * @returns {Promise<Object>}          - HTLC público
 */
async function lock({ sender, receiver, amount, hashlock, timelock, swapId = null }) {
    // 1. Validações básicas
    const senderNorm = wallet.normalizeAddress(sender);
    const receiverNorm = wallet.normalizeAddress(receiver);

    if (!wallet.isValidAddress(senderNorm)) throw new Error('sender inválido');
    if (!wallet.isValidAddress(receiverNorm)) throw new Error('receiver inválido');
    if (senderNorm === receiverNorm) throw new Error('sender e receiver iguais');

    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum < CONFIG.MIN_AMOUNT) {
        throw new Error(`amount deve ser >= ${CONFIG.MIN_AMOUNT}`);
    }

    if (!validateHashlock(hashlock)) {
        throw new Error('hashlock inválido (esperado sha256 hex 64 chars)');
    }
    if (!validateTimelock(timelock)) {
        throw new Error(`timelock inválido (deve estar entre +${CONFIG.MIN_TIMELOCK_SECONDS}s e +${CONFIG.MAX_TIMELOCK_SECONDS}s)`);
    }

    // 2. Verifica que receiver existe
    const receiverWallet = await WalletModel.findOne({
        address: receiverNorm,
        status: 'active'
    });
    if (!receiverWallet) throw new Error('receiver não encontrado ou inativo');

    // 3. Verifica que sender existe e tem saldo
    const senderWallet = await WalletModel.findOne({
        address: senderNorm,
        status: 'active'
    });
    if (!senderWallet) throw new Error('sender não encontrado ou inativo');

    const totalDebit = amountNum + CONFIG.HTLC_FEE_BRD;
    if (parseFloat(senderWallet.balance.toString()) < totalDebit) {
        throw new Error(`Saldo insuficiente: precisa ${totalDebit} BRD`);
    }

    // 4. Anti-replay: hashlock não pode estar ativo
    const existing = await HTLCModel.findOne({
        hashlock: hashlock.toLowerCase(),
        status: 'locked'
    });
    if (existing) throw new Error('hashlock já em uso em outro HTLC ativo');

    // 5. Cria o HTLC
    const htlcId = generateHtlcId();
    const now = Math.floor(Date.now() / 1000);

    const htlc = await HTLCModel.create({
        htlcId,
        chain: 'bradicoin',
        sender: senderNorm,
        receiver: receiverNorm,
        amount: amountNum.toString(),
        token: 'BRD',
        hashlock: hashlock.toLowerCase(),
        timelock,
        status: 'locked',
        swapId,
        metadata: {
            createdAtUnix: now,
            fee: CONFIG.HTLC_FEE_BRD
        }
    });

    // 6. Debita sender (atomicamente)
    try {
        await WalletModel.debit(senderNorm, totalDebit.toFixed(8));
    } catch (e) {
        await HTLCModel.deleteOne({ htlcId });
        throw new Error(`Falha ao debitar sender: ${e.message}`);
    }

    // 7. Credita taxa no fee collector
    const feeCollector = process.env.FEE_COLLECTOR_ADDRESS;
    if (feeCollector && CONFIG.HTLC_FEE_BRD > 0) {
        try {
            await WalletModel.credit(feeCollector, CONFIG.HTLC_FEE_BRD.toFixed(8));
        } catch (e) {
            console.error('Erro ao creditar fee HTLC:', e.message);
        }
    }

    // 8. Registra transação
    const txHash = blockchain.calculateTxHash({
        fromAddress: senderNorm,
        toAddress: `HTLC:${htlcId}`,
        amount: amountNum,
        fee: CONFIG.HTLC_FEE_BRD,
        nonce: senderWallet.nonce,
        type: 'htlc_lock',
        timestamp: new Date().toISOString()
    });

    try {
        await TransactionModel.create({
            hash: txHash,
            from: senderNorm,
            to: `HTLC:${htlcId}`,
            amount: amountNum.toString(),
            fee: CONFIG.HTLC_FEE_BRD.toString(),
            nonce: senderWallet.nonce,
            type: 'htlc_lock',
            signature: 'HTLC_INTERNAL',
            publicKey: 'HTLC_INTERNAL',
            status: 'confirmed',
            timestamp: new Date(),
            metadata: { htlcId, hashlock, timelock }
        });
    } catch (e) {
        if (e.code !== 11000) console.error('Erro ao registrar tx htlc_lock:', e.message);
    }

    // 9. Atualiza o HTLC com o txHashLock
    htlc.txHashLock = txHash;
    await htlc.save();

    console.log(`🔒 HTLC locked: ${htlcId} | ${amountNum} BRD | ${senderNorm} → ${receiverNorm}`);

    return htlc.toPublic();
}

// ============================================
// CLAIM — Receiver resgata com preimage
// ============================================
/**
 * @param {Object} opts
 * @param {string} opts.htlcId
 * @param {string} opts.preimage   - S tal que sha256(S) == hashlock
 * @param {string} opts.claimer    - endereço do receiver (deve bater)
 */
async function claim({ htlcId, preimage, claimer }) {
    if (!htlcId) throw new Error('htlcId obrigatório');
    if (!preimage) throw new Error('preimage obrigatório');

    const htlc = await HTLCModel.findOne({ htlcId });
    if (!htlc) throw new Error('HTLC não encontrado');
    if (htlc.status !== 'locked') throw new Error(`HTLC não está locked (status=${htlc.status})`);

    const claimerNorm = wallet.normalizeAddress(claimer);
    if (claimerNorm !== htlc.receiver) {
        throw new Error('Apenas o receiver pode resgatar');
    }

    // Verifica preimage
    const computed = hashSecret(preimage);
    if (computed.toLowerCase() !== htlc.hashlock.toLowerCase()) {
        throw new Error('Preimage inválido');
    }

    // Timelock ainda válido? (pode resgatar até o timelock)
    const now = Math.floor(Date.now() / 1000);
    if (now >= htlc.timelock) {
        throw new Error('HTLC expirado — use refund');
    }

    // Credita receiver
    const amountStr = htlc.amount.toString();
    await WalletModel.credit(htlc.receiver, amountStr);

    // Atualiza HTLC
    htlc.status = 'claimed';
    htlc.preimage = preimage;
    htlc.claimedAt = new Date();

    // Registra transação
    const txHash = blockchain.calculateTxHash({
        fromAddress: `HTLC:${htlcId}`,
        toAddress: htlc.receiver,
        amount: htlc.amount,
        fee: 0,
        nonce: 0,
        type: 'htlc_claim',
        timestamp: new Date().toISOString()
    });

    htlc.txHashClaim = txHash;
    await htlc.save();

    try {
        await TransactionModel.create({
            hash: txHash,
            from: `HTLC:${htlcId}`,
            to: htlc.receiver,
            amount: amountStr,
            fee: '0',
            nonce: 0,
            type: 'htlc_claim',
            signature: 'HTLC_INTERNAL',
            publicKey: 'HTLC_INTERNAL',
            status: 'confirmed',
            timestamp: new Date(),
            metadata: { htlcId, preimage }
        });
    } catch (e) {
        if (e.code !== 11000) console.error('Erro ao registrar tx htlc_claim:', e.message);
    }

    console.log(`✅ HTLC claimed: ${htlcId} | ${amountStr} BRD → ${htlc.receiver}`);

    return htlc.toPublic();
}

// ============================================
// REFUND — Sender recupera após timelock
// ============================================
async function refund({ htlcId, refunder }) {
    if (!htlcId) throw new Error('htlcId obrigatório');

    const htlc = await HTLCModel.findOne({ htlcId });
    if (!htlc) throw new Error('HTLC não encontrado');
    if (htlc.status !== 'locked') throw new Error(`HTLC não está locked (status=${htlc.status})`);

    const refunderNorm = wallet.normalizeAddress(refunder);
    if (refunderNorm !== htlc.sender) {
        throw new Error('Apenas o sender pode refundar');
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < htlc.timelock) {
        throw new Error(`Timelock ainda ativo (expira em ${htlc.timelock - now}s)`);
    }

    // Devolve fundos ao sender
    const amountStr = htlc.amount.toString();
    await WalletModel.credit(htlc.sender, amountStr);

    htlc.status = 'refunded';
    htlc.refundedAt = new Date();

    const txHash = blockchain.calculateTxHash({
        fromAddress: `HTLC:${htlcId}`,
        toAddress: htlc.sender,
        amount: htlc.amount,
        fee: 0,
        nonce: 0,
        type: 'htlc_refund',
        timestamp: new Date().toISOString()
    });

    htlc.txHashRefund = txHash;
    await htlc.save();

    try {
        await TransactionModel.create({
            hash: txHash,
            from: `HTLC:${htlcId}`,
            to: htlc.sender,
            amount: amountStr,
            fee: '0',
            nonce: 0,
            type: 'htlc_refund',
            signature: 'HTLC_INTERNAL',
            publicKey: 'HTLC_INTERNAL',
            status: 'confirmed',
            timestamp: new Date(),
            metadata: { htlcId }
        });
    } catch (e) {
        if (e.code !== 11000) console.error('Erro ao registrar tx htlc_refund:', e.message);
    }

    console.log(`↩️  HTLC refunded: ${htlcId} | ${amountStr} BRD → ${htlc.sender}`);

    return htlc.toPublic();
}

// ============================================
// QUERIES
// ============================================
async function getHtlc(htlcId) {
    const htlc = await HTLCModel.findOne({ htlcId });
    if (!htlc) throw new Error('HTLC não encontrado');
    return htlc.toPublic();
}

async function listHtlcs({ address, status, chain, limit = 50, offset = 0 } = {}) {
    const query = {};
    if (address) {
        const norm = wallet.normalizeAddress(address);
        query.$or = [{ sender: norm }, { receiver: norm }];
    }
    if (status) query.status = status;
    if (chain) query.chain = chain;

    limit = Math.min(Math.max(1, limit), 100);

    const [htlcs, total] = await Promise.all([
        HTLCModel.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit),
        HTLCModel.countDocuments(query)
    ]);

    return {
        total,
        htlcs: htlcs.map(h => h.toPublic()),
        limit,
        offset,
        hasMore: offset + limit < total
    };
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
    CONFIG,
    // Geração de segredos
    generateSecret,
    hashSecret,
    generateHtlcId,
    // Operações
    lock,
    claim,
    refund,
    // Queries
    getHtlc,
    listHtlcs,
    // Validação
    validateHashlock,
    validateTimelock
};
