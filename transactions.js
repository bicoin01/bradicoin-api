// transactions.js
// Bradicoin Blockchain - Transactions (v4.0)
// ============================================
// 🔐 NÃO-CUSTODIAL
// v4.0 — valores exatos (BigInt, 8 casas), anti-replay atômico, tipos internos
//        bloqueados para usuários, créditos internos idempotentes e com rollback
'use strict';

const mongoose = require('mongoose');
const Decimal128 = mongoose.Types.Decimal128;
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');

const TransactionModel = require('./models/Transaction');
const WalletModel = require('./models/Wallet');
const wallet = require('./wallet');
const blockchain = require('./blockchain');

// ============================================
// CONSTANTES
// ============================================
const SCALE = 8;
const UNIT = 10n ** BigInt(SCALE);

const MAX_AMOUNT = 100_000_000_000_000; // 100 trilhões de BRD
const MAX_FEE = 1000;
const MAX_UNITS = BigInt(MAX_AMOUNT) * UNIT;
const MAX_FEE_UNITS = BigInt(MAX_FEE) * UNIT;
const MAX_FUTURE_TIMESTAMP_MS = 5 * 60 * 1000;
const MAX_PAST_TIMESTAMP_MS = 10 * 60 * 1000;

// Tipos que um USUÁRIO pode assinar e enviar pela API.
// mint / reward / unstake / airdrop / buy / wallet_creation são SOMENTE internos.
const USER_TX_TYPES = new Set([
    'transfer', 'stake', 'tip', 'burn',
    'nft_mint', 'nft_transfer', 'token_create', 'token_transfer'
]);

// ============================================
// ERRO TIPADO (o server.js pode usar err.status / err.code)
// ============================================
class TxError extends Error {
    constructor(message, status = 400, code = 'TX_ERROR') {
        super(message);
        this.name = 'TxError';
        this.status = status;
        this.code = code;
    }
}

// ============================================
// VALORES EXATOS (sem float)
// ============================================
const CANONICAL_RE = /^(0|[1-9]\d{0,14})(\.\d{0,7}[1-9])?$/; // sem zeros à direita, sem notação científica
const LOOSE_RE = /^\d{1,15}(\.\d{1,8})?$/;

// canonical=true  → usado em tx assinadas (a string precisa ser idêntica à assinada)
// canonical=false → uso interno (airdrop/compra), aceita "100.50"
function parseUnits(value, label, canonical) {
    let s;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TxError(`${label} inválido`);
        s = canonical ? String(value) : value.toFixed(SCALE);
    } else if (typeof value === 'string') {
        s = canonical ? value : value.trim();
    } else {
        throw new TxError(`${label} inválido`);
    }

    if (!(canonical ? CANONICAL_RE : LOOSE_RE).test(s)) {
        throw new TxError(
            canonical
                ? `${label} inválido: use string decimal (ex.: "10.5"), máx. 8 casas, sem zeros à direita nem notação científica`
                : `${label} inválido (máx. 8 casas decimais)`
        );
    }
    const [int, frac = ''] = s.split('.');
    return { raw: s, units: BigInt(int) * UNIT + BigInt(frac.padEnd(SCALE, '0')) };
}

function fromUnits(units) {
    const neg = units < 0n;
    const u = neg ? -units : units;
    const int = (u / UNIT).toString();
    const frac = (u % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
    return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

// Decimal128 / string do banco → unidades (aceita notação científica)
function decimalToUnits(value) {
    const s = value === null || value === undefined ? '0' : value.toString();
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) throw new TxError('Valor numérico inválido no banco de dados', 500, 'DB_VALUE');
    const [, sign, int, frac = '', exp = '0'] = m;
    const shift = SCALE - (frac.length - Number(exp));
    let n = BigInt(int + frac);
    n = shift >= 0 ? n * 10n ** BigInt(shift) : n / 10n ** BigInt(-shift);
    return sign ? -n : n;
}

const toDecimal128 = (units) => Decimal128.fromString(fromUnits(units));

// ============================================
// HELPERS
// ============================================
function assertAddress(value, label) {
    if (typeof value !== 'string' || !value || value.length > 128) {
        throw new TxError(`${label} inválido`);
    }
    const normalized = wallet.normalizeAddress(value);
    if (!wallet.isValidAddress(normalized)) throw new TxError(`${label} inválido`);
    return normalized;
}

function getReserveAddress() {
    const raw = process.env.RESERVE_ADDRESS;
    if (!raw) throw new TxError('RESERVE_ADDRESS não configurado', 500, 'CONFIG');
    const addr = wallet.normalizeAddress(raw);
    if (!wallet.isValidAddress(addr)) throw new TxError('RESERVE_ADDRESS inválido', 500, 'CONFIG');
    return addr;
}

function normalizeHash(hash) {
    if (typeof hash !== 'string') throw new TxError('Hash é obrigatório');
    const h = hash.trim().replace(/^0x/i, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(h)) throw new TxError('Hash inválido');
    return h;
}

// Fila por endereço: serializa operações do mesmo remetente neste processo.
const locks = new Map();
async function withAddressLock(address, fn) {
    const prev = locks.get(address) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chain = prev.then(() => gate);
    locks.set(address, chain);
    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (locks.get(address) === chain) locks.delete(address);
    }
}

// ============================================
// INICIALIZAR (garante índices únicos anti-replay)
// ============================================
async function initialize() {
    if (mongoose.connection.readyState === 1) {
        const col = TransactionModel.collection;
        const indexes = [
            [{ hash: 1 }, { unique: true }],
            [{ signature: 1 }, { unique: true }],
            [{ from: 1, timestamp: -1 }, {}],
            [{ to: 1, timestamp: -1 }, {}]
        ];
        for (const [spec, opts] of indexes) {
            try {
                await col.createIndex(spec, opts);
            } catch (e) {
                console.warn(`⚠️ Índice ${JSON.stringify(spec)} não criado:`, e.message);
            }
        }
    }
    console.log('✅ Transactions inicializadas');
}

// ============================================
// HASH UNIFICADO — usado por transactions.js E blockchain.js
// ============================================
function calculateTxHash(tx, signature) {
    const payload = JSON.stringify({
        from: tx.fromAddress || tx.from || null,
        to: tx.toAddress || tx.to || null,
        amount: (tx.amount || '0').toString(),
        fee: (tx.fee || '0').toString(),
        nonce: tx.nonce || 0,
        type: tx.type || 'transfer',
        timestamp: tx.timestamp,
        signature: signature || tx.signature || 'system'
    });
    return bytesToHex(sha256(utf8ToBytes(payload)));
}

// ============================================
// STRING PARA ASSINATURA (formato inalterado)
// ============================================
function buildSignableMessage(tx) {
    return [
        tx.fromAddress,
        tx.toAddress,
        String(tx.amount),
        String(tx.fee || '0'),
        String(tx.nonce),
        tx.timestamp,
        tx.type || 'transfer'
    ].join('|');
}

// ============================================
// VALIDAÇÃO (tx enviada por usuário)
// ============================================
function validateUserPayload(p) {
    if (!p || typeof p !== 'object') throw new TxError('Payload inválido');

    const from = assertAddress(p.fromAddress, 'Endereço de origem');
    const to = assertAddress(p.toAddress, 'Endereço de destino');
    if (from === to) throw new TxError('Não é possível enviar para si mesmo');

    const amount = parseUnits(p.amount, 'Valor', true);
    if (amount.units < 1n) throw new TxError('Valor deve ser >= 0.00000001');
    if (amount.units > MAX_UNITS) throw new TxError(`Valor máximo por transação: ${MAX_AMOUNT} BRD`);

    const hasFee = p.fee !== undefined && p.fee !== null && p.fee !== '';
    const fee = parseUnits(hasFee ? p.fee : 0, 'Taxa', true);
    if (fee.units > MAX_FEE_UNITS) throw new TxError(`Taxa deve estar entre 0 e ${MAX_FEE} BRD`);

    if (!Number.isSafeInteger(p.nonce) || p.nonce < 0) throw new TxError('Nonce inválido');

    if (typeof p.timestamp !== 'string' || !p.timestamp) throw new TxError('Timestamp é obrigatório');
    const ts = Date.parse(p.timestamp);
    if (Number.isNaN(ts)) throw new TxError('Timestamp inválido');
    const now = Date.now();
    if (ts > now + MAX_FUTURE_TIMESTAMP_MS) throw new TxError('Timestamp muito no futuro');
    if (ts < now - MAX_PAST_TIMESTAMP_MS) throw new TxError('Timestamp muito antigo');

    const type = p.type === undefined || p.type === null ? 'transfer' : p.type;
    if (typeof type !== 'string' || !USER_TX_TYPES.has(type)) {
        throw new TxError('Tipo de transação inválido ou não permitido');
    }

    return {
        from, to,
        amountRaw: amount.raw, amountUnits: amount.units,
        feeRaw: fee.raw, feeUnits: fee.units,
        nonce: p.nonce, timestamp: p.timestamp, type
    };
}

// ============================================
// FERRAMENTA DE TESTE — criar e assinar
// ⚠️ Chave privada NUNCA deve chegar ao servidor. Desativada em produção.
// ============================================
async function createSignedTransaction({
    fromAddress, toAddress, amount, fee = 0, nonce, type = 'transfer', privateKey
}) {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SERVER_SIGNING !== 'true') {
        throw new TxError('Assinatura no servidor desativada em produção', 403, 'SIGNING_DISABLED');
    }
    if (typeof privateKey !== 'string' || !privateKey) throw new TxError('Chave privada é obrigatória');

    const tx = {
        fromAddress: assertAddress(fromAddress, 'Endereço de origem'),
        toAddress: assertAddress(toAddress, 'Endereço de destino'),
        amount: fromUnits(parseUnits(amount, 'Valor', false).units),
        fee: fromUnits(parseUnits(fee, 'Taxa', false).units),
        nonce,
        timestamp: new Date().toISOString(),
        type
    };
    validateUserPayload(tx);

    const secp256k1 = require('@noble/secp256k1');
    const keyHex = privateKey.replace(/^0x/, '');
    const digest = sha256(utf8ToBytes(buildSignableMessage(tx)));

    // v1 do noble-secp256k1 é assíncrona; await funciona nas duas versões
    const sig = await secp256k1.sign(digest, keyHex);
    const signature = typeof sig === 'string'
        ? sig
        : (sig && typeof sig.toCompactHex === 'function' ? sig.toCompactHex() : bytesToHex(sig));
    const publicKey = bytesToHex(secp256k1.getPublicKey(keyHex, true));

    return { ...tx, hash: calculateTxHash(tx, signature), signature, publicKey };
}

// ============================================
// SERVER-SIDE — SUBMETER TX ASSINADA
// ============================================
async function submitSignedTransaction(input) {
    if (!input || typeof input !== 'object') throw new TxError('Payload inválido');
    const { signature, publicKey } = input;

    if (typeof signature !== 'string' || typeof publicKey !== 'string' || !signature || !publicKey) {
        throw new TxError('Assinatura e chave pública são obrigatórias');
    }
    if (signature.length > 512 || publicKey.length > 256) {
        throw new TxError('Assinatura ou chave pública inválida');
    }

    const v = validateUserPayload(input);

    if (!wallet.isValidPublicKey(publicKey)) throw new TxError('Public key inválida');

    // publicKey ↔ address
    const derived = wallet.normalizeAddress(wallet.deriveAddressFromPublicKey(publicKey));
    if (derived !== v.from) throw new TxError('Public key não corresponde ao endereço de origem');

    // Assinatura sobre os valores canônicos
    const signable = {
        fromAddress: v.from, toAddress: v.to,
        amount: v.amountRaw, fee: v.feeRaw,
        nonce: v.nonce, timestamp: v.timestamp, type: v.type
    };
    let signatureOk = false;
    try {
        signatureOk = wallet.verifySignature(buildSignableMessage(signable), signature, publicKey) === true;
    } catch (_) { signatureOk = false; }
    if (!signatureOk) throw new TxError('Assinatura inválida', 401, 'BAD_SIGNATURE');

    // A partir daqui, uma submissão por vez para o mesmo remetente
    return withAddressLock(v.from, async () => {
        const sender = await WalletModel.findOne({ address: v.from });
        if (!sender) throw new TxError('Carteira de origem não encontrada', 404);
        if (sender.status !== 'active') throw new TxError('Carteira de origem inativa', 403);

        if (sender.nonce !== v.nonce) {
            throw new TxError(`Nonce inválido: esperado ${sender.nonce}, recebido ${v.nonce}`, 409, 'BAD_NONCE');
        }

        const balanceUnits = decimalToUnits(sender.balance);
        const totalCost = v.amountUnits + v.feeUnits;
        if (balanceUnits < totalCost) {
            throw new TxError(
                `Saldo insuficiente: ${fromUnits(balanceUnits)} < ${fromUnits(totalCost)}`,
                400, 'INSUFFICIENT_FUNDS'
            );
        }

        // Anti-replay
        if (await TransactionModel.exists({ signature })) {
            throw new TxError('Transação já submetida (replay detectado)', 409, 'REPLAY');
        }
        if (await TransactionModel.exists({ from: v.from, nonce: v.nonce })) {
            throw new TxError('Nonce já usado (replay detectado)', 409, 'REPLAY');
        }

        const hash = calculateTxHash({
            fromAddress: v.from, toAddress: v.to,
            amount: v.amountRaw, fee: v.feeRaw,
            nonce: v.nonce, type: v.type, timestamp: v.timestamp
        }, signature);

        let transaction;
        try {
            transaction = await TransactionModel.create({
                hash,
                from: v.from,
                to: v.to,
                amount: toDecimal128(v.amountUnits),
                fee: toDecimal128(v.feeUnits),
                nonce: v.nonce,
                signature,
                publicKey,
                type: v.type,
                status: 'pending',
                timestamp: new Date(v.timestamp)
            });
        } catch (err) {
            if (err && err.code === 11000) {
                throw new TxError('Transação já submetida (replay detectado)', 409, 'REPLAY');
            }
            throw err;
        }

        try {
            await blockchain.addTransaction({
                hash,
                fromAddress: v.from,
                toAddress: v.to,
                amount: Number(v.amountRaw),
                fee: Number(v.feeRaw),
                amountStr: v.amountRaw, // valores exatos, para quem precisar
                feeStr: v.feeRaw,
                nonce: v.nonce,
                signature,
                publicKey,
                type: v.type,
                timestamp: v.timestamp,
                status: 'pending'
            });
        } catch (err) {
            await TransactionModel.deleteOne({ hash });
            throw err;
        }

        console.log(`✅ TX submetida: ${hash.substring(0, 12)}...`);

        return {
            success: true,
            hash,
            status: 'pending',
            message: `Transação de ${v.amountRaw} BRD submetida. Será confirmada no próximo bloco.`,
            transaction: transaction.toPublic()
        };
    });
}

// ============================================
// CONSULTAS
// ============================================
async function getTransactionByHash(hash) {
    const h = normalizeHash(hash);
    const tx = await TransactionModel.findOne({ hash: h });
    if (!tx) throw new TxError('Transação não encontrada', 404, 'NOT_FOUND');
    return tx.toPublic();
}

async function getWalletTransactions(address, limit = 50, offset = 0) {
    const normalized = assertAddress(address, 'Endereço');

    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const off = Math.min(Math.max(parseInt(offset, 10) || 0, 0), 100000);

    const query = { $or: [{ from: normalized }, { to: normalized }] };

    const [transactions, total] = await Promise.all([
        TransactionModel.find(query).sort({ timestamp: -1 }).skip(off).limit(lim).lean(),
        TransactionModel.countDocuments(query)
    ]);

    return {
        address: normalized,
        total,
        transactions: transactions.map((tx) => ({
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            amount: tx.amount ? tx.amount.toString() : '0',
            fee: tx.fee ? tx.fee.toString() : '0',
            type: tx.type,
            status: tx.status,
            nonce: tx.nonce,
            blockIndex: tx.blockIndex,
            blockHash: tx.blockHash,
            confirmations: tx.confirmations,
            timestamp: tx.timestamp,
            confirmed: tx.status === 'confirmed'
        })),
        limit: lim,
        offset: off,
        hasMore: off + lim < total
    };
}

let statsCache = { data: null, at: 0 };
const STATS_TTL_MS = 15000;

async function getTransactionStats() {
    const now = Date.now();
    if (statsCache.data && now - statsCache.at < STATS_TTL_MS) return statsCache.data;

    const [total, pending, confirmed, failed, volumeAgg] = await Promise.all([
        TransactionModel.countDocuments({}),
        TransactionModel.countDocuments({ status: 'pending' }),
        TransactionModel.countDocuments({ status: 'confirmed' }),
        TransactionModel.countDocuments({ status: 'failed' }),
        TransactionModel.aggregate([
            { $match: { status: 'confirmed' } },
            {
                $group: {
                    _id: null,
                    totalVolume: { $sum: { $toDouble: '$amount' } },
                    totalFees: { $sum: { $toDouble: '$fee' } }
                }
            }
        ])
    ]);

    const agg = volumeAgg[0] || { totalVolume: 0, totalFees: 0 };
    const data = {
        totalTransactions: total,
        confirmed,
        pending,
        failed,
        totalVolume: agg.totalVolume,
        totalFees: agg.totalFees
    };
    statsCache = { data, at: now };
    return data;
}

// ============================================
// MINERADOR (uso interno)
// ============================================
async function confirmTransaction(hash, blockIndex, blockHash) {
    const h = normalizeHash(hash);
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) throw new TxError('blockIndex inválido');
    if (typeof blockHash !== 'string' || !/^[a-f0-9]{64}$/i.test(blockHash)) throw new TxError('blockHash inválido');

    return TransactionModel.findOneAndUpdate(
        { hash: h, status: 'pending' },
        { $set: { status: 'confirmed', blockIndex, blockHash, confirmations: 1 } },
        { new: true }
    );
}

async function failTransaction(hash, reason) {
    const h = normalizeHash(hash);
    return TransactionModel.findOneAndUpdate(
        { hash: h, status: 'pending' },
        { $set: { status: 'failed', 'metadata.reason': String(reason || 'unknown').slice(0, 200) } },
        { new: true }
    );
}

// ============================================
// CRÉDITOS INTERNOS — base comum (airdrop e compra)
// ============================================

// Reivindica a tx interna de forma idempotente (assinatura determinística + índice único).
async function claimInternalTx({ type, from, to, amountUnits, signature, metadata }) {
    // Reprocessa uma tx que falhou antes (atômico)
    const reclaimed = await TransactionModel.findOneAndUpdate(
        { signature, status: 'failed' },
        { $set: { status: 'pending' } },
        { new: true }
    );
    if (reclaimed) return { claimed: true, hash: reclaimed.hash };

    const existing = await TransactionModel.findOne({ signature }).select('hash status').lean();
    if (existing) return { claimed: false, existing };

    const timestamp = new Date().toISOString();
    const hash = calculateTxHash({
        fromAddress: from, toAddress: to,
        amount: fromUnits(amountUnits), fee: '0',
        nonce: 0, type, timestamp
    }, signature);

    try {
        await TransactionModel.create({
            hash,
            from,
            to,
            amount: toDecimal128(amountUnits),
            fee: toDecimal128(0n),
            nonce: 0,
            signature,
            publicKey: 'INTERNAL',
            type,
            status: 'pending',
            timestamp: new Date(timestamp),
            metadata: { ...metadata, internal: true }
        });
    } catch (err) {
        if (err && err.code === 11000) {
            const dup = await TransactionModel.findOne({ signature }).select('hash status').lean();
            return { claimed: false, existing: dup };
        }
        throw err;
    }
    return { claimed: true, hash };
}

// Debita a reserva ANTES; se o crédito falhar, devolve à reserva.
async function moveFromReserve({ reserve, to, amountUnits }) {
    const amountStr = fromUnits(amountUnits);

    const reserveWallet = await WalletModel.debit(reserve, amountStr); // falhou aqui = nada aconteceu

    try {
        const userWallet = await WalletModel.credit(to, amountStr);
        return { reserveWallet, userWallet };
    } catch (err) {
        try {
            await WalletModel.credit(reserve, amountStr);
        } catch (refundErr) {
            console.error(`🚨 REEMBOLSO À RESERVA FALHOU (${amountStr} BRD, destino ${to}):`, refundErr.message);
            err.refundFailed = true;
        }
        throw err;
    }
}

async function finishInternalTx(hash, status, reason) {
    const set = { status };
    if (reason) set['metadata.reason'] = String(reason).slice(0, 200);
    try {
        await TransactionModel.updateOne({ hash }, { $set: set });
    } catch (e) {
        console.error(`🚨 Falha ao atualizar tx interna ${hash}:`, e.message);
    }
}

// ============================================
// AIRDROP (idempotente por campanha + usuário)
// ============================================
async function creditAirdrop({ toAddress, amount, campaign, userId, idempotencyKey }) {
    if (typeof campaign !== 'string' || !campaign.trim() || campaign.length > 64) {
        throw new TxError('campaign é obrigatório (máx. 64 caracteres)');
    }

    const to = assertAddress(toAddress, 'Endereço de destino');
    const reserve = getReserveAddress();
    if (to === reserve) throw new TxError('Destino não pode ser a reserva');

    const { units: amountUnits } = parseUnits(amount, 'Valor do airdrop', false);
    if (amountUnits < 1n || amountUnits > MAX_UNITS) throw new TxError('Valor do airdrop inválido');

    const toWallet = await WalletModel.findOne({ address: to });
    if (!toWallet) throw new TxError('Carteira de destino não existe', 404);
    if (toWallet.status !== 'active') throw new TxError('Carteira de destino inativa', 403);

    const key = String(idempotencyKey || `${campaign}_${userId || to}`).slice(0, 200);
    const signature = `INTERNAL_AIRDROP_${key}`;

    const claim = await claimInternalTx({
        type: 'airdrop',
        from: reserve,
        to,
        amountUnits,
        signature,
        metadata: { campaign, userId: userId ? String(userId) : undefined }
    });

    if (!claim.claimed) {
        const st = claim.existing && claim.existing.status;
        throw new TxError(
            st === 'confirmed' ? 'Airdrop já creditado' : 'Airdrop em processamento ou pendente de revisão',
            409, 'DUPLICATE'
        );
    }

    let moved;
    try {
        moved = await moveFromReserve({ reserve, to, amountUnits });
    } catch (err) {
        await finishInternalTx(claim.hash, err.refundFailed ? 'pending' : 'failed', err.message);
        throw err;
    }

    await finishInternalTx(claim.hash, 'confirmed');
    console.log(`✅ Airdrop creditado: ${fromUnits(amountUnits)} BRD → ${to}`);

    return {
        txHash: claim.hash,
        blockIndex: null,
        amount: Number(fromUnits(amountUnits)),
        newBalance: moved.userWallet.balance.toString()
    };
}

// ============================================
// 🛒 COMPRA DE BRADICOIN (buy)
// ============================================
// Proteções:
//  1. Lock por status do pedido: 'paid' → 'crediting' (atômico)
//  2. Idempotência: assinatura determinística por pedido + índice único
//  3. Ordem correta: debita a reserva primeiro; falha no crédito devolve à reserva
//  4. Valor conferido contra o pedido
//  5. Se os fundos já foram movidos, o pedido NUNCA volta para 'failed'
//     (evita reprocessamento e crédito duplo)
async function creditPurchase({ orderId, toAddress, amount }) {
    if (typeof orderId !== 'string' || !orderId || orderId.length > 128) {
        throw new TxError('orderId é obrigatório');
    }
    const to = assertAddress(toAddress, 'Endereço de destino');
    const reserve = getReserveAddress();
    const { units: amountUnits } = parseUnits(amount, 'amount', false);
    if (amountUnits < 1n || amountUnits > MAX_UNITS) throw new TxError('amount inválido (deve ser > 0)');

    const BuyOrder = require('./models/BuyOrder');

    const order = await BuyOrder.findOneAndUpdate(
        { orderId, status: 'paid' },
        { $set: { status: 'crediting' } },
        { new: true }
    );

    if (!order) {
        const existing = await BuyOrder.findOne({ orderId });
        if (!existing) throw new TxError(`Pedido ${orderId} não encontrado`, 404);
        if (existing.status === 'credited' && existing.creditTxHash) {
            return {
                txHash: existing.creditTxHash,
                orderId: existing.orderId,
                amount: Number(existing.amountBr.toString()),
                alreadyCredited: true
            };
        }
        if (existing.status === 'crediting') {
            throw new TxError(`Pedido ${orderId} já está sendo processado`, 409, 'IN_PROGRESS');
        }
        throw new TxError(`Pedido ${orderId} em estado inválido: ${existing.status}`, 409, 'BAD_STATE');
    }

    let fundsMoved = false;
    try {
        // Valor precisa bater com o pedido
        if (order.amountBr !== undefined && order.amountBr !== null) {
            if (decimalToUnits(order.amountBr) !== amountUnits) {
                throw new TxError('amount diverge do valor do pedido', 409, 'AMOUNT_MISMATCH');
            }
        }

        const claim = await claimInternalTx({
            type: 'buy',
            from: reserve,
            to,
            amountUnits,
            signature: `INTERNAL_BUY_${orderId}`,
            metadata: {
                orderId: order.orderId,
                currency: order.currency,
                amountUsd: order.amountUsd,
                priceAtOrder: order.priceAtOrder,
                source: 'buy_worker'
            }
        });

        // Já existe tx confirmada para este pedido: apenas conclui o pedido
        if (!claim.claimed) {
            if (claim.existing && claim.existing.status === 'confirmed') {
                fundsMoved = true;
                await BuyOrder.findOneAndUpdate(
                    { orderId, status: 'crediting' },
                    { $set: { status: 'credited', creditTxHash: claim.existing.hash, creditedAt: new Date() } }
                );
                return {
                    txHash: claim.existing.hash,
                    orderId: order.orderId,
                    amount: Number(fromUnits(amountUnits)),
                    alreadyCredited: true
                };
            }
            throw new TxError('Transação de compra pendente de revisão manual', 409, 'NEEDS_REVIEW');
        }

        let moved;
        try {
            moved = await moveFromReserve({ reserve, to, amountUnits });
        } catch (err) {
            await finishInternalTx(claim.hash, err.refundFailed ? 'pending' : 'failed', err.message);
            throw err;
        }
        fundsMoved = true;

        await finishInternalTx(claim.hash, 'confirmed');

        await BuyOrder.findOneAndUpdate(
            { orderId, status: 'crediting' },
            { $set: { status: 'credited', creditTxHash: claim.hash, creditedAt: new Date() } }
        );

        console.log(`✅ Compra creditada: ${fromUnits(amountUnits)} BRD → ${to} (tx: ${claim.hash.substring(0, 12)}...)`);

        return {
            txHash: claim.hash,
            orderId: order.orderId,
            amount: Number(fromUnits(amountUnits)),
            newBalance: moved.userWallet.balance.toString(),
            reserveBalance: moved.reserveWallet.balance.toString()
        };
    } catch (err) {
        console.error(`❌ Erro ao creditar compra ${orderId}:`, err.message);

        if (fundsMoved) {
            // Fundos já foram creditados: não marcar como failed. Revisão manual.
            console.error(`🚨 Pedido ${orderId}: fundos movidos mas o fechamento falhou. Conferir manualmente.`);
        } else {
            try {
                await BuyOrder.findOneAndUpdate(
                    { orderId, status: 'crediting' },
                    { $set: { status: 'failed', failureReason: String(err.message).slice(0, 300) } }
                );
            } catch (updateErr) {
                console.error('❌ Erro ao marcar pedido como failed:', updateErr.message);
            }
        }
        throw err;
    }
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
    initialize,
    TxError,
    USER_TX_TYPES,
    buildSignableMessage,
    calculateTxHash,
    createSignedTransaction,
    submitSignedTransaction,
    getTransactionByHash,
    getWalletTransactions,
    getTransactionStats,
    confirmTransaction,
    failTransaction,
    creditAirdrop,
    creditPurchase
};
