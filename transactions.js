// transactions.js
// ============================================
// Bradicoin Blockchain - Transactions (v3.1)
// ============================================
// 🔐 NÃO-CUSTODIAL
// 🆕 v3.1 — normalização de endereço + hash unificado
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');

const TransactionModel = require('./models/Transaction');
const WalletModel = require('./models/Wallet');
const wallet = require('./wallet');
const blockchain = require('./blockchain');

// ============================================
// CONSTANTES
// ============================================
const MAX_AMOUNT = 100_000_000_000_000;
const MAX_FEE = 1000;
const MAX_FUTURE_TIMESTAMP_MS = 5 * 60 * 1000;
const MAX_PAST_TIMESTAMP_MS = 10 * 60 * 1000;
const MIN_AMOUNT = 0.00000001;

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    console.log('✅ Transactions inicializadas');
}

// ============================================
// 🆕 HASH UNIFICADO — usado por transactions.js E blockchain.js
// ============================================
// Este é O ÚNICO lugar que calcula hash de tx. Todo o resto chama isto.
//
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
// STRING PARA ASSINATURA
// ============================================
function buildSignableMessage(tx) {
    return [
        tx.fromAddress,
        tx.toAddress,
        tx.amount.toString(),
        (tx.fee || '0').toString(),
        tx.nonce.toString(),
        tx.timestamp,
        tx.type || 'transfer'
    ].join('|');
}

// ============================================
// VALIDAÇÕES
// ============================================
function validateTransactionPayload(payload) {
    const { fromAddress, toAddress, amount, fee, nonce, timestamp, type } = payload;

    if (!fromAddress || !toAddress) {
        throw new Error('fromAddress e toAddress são obrigatórios');
    }
    if (!wallet.isValidAddress(fromAddress)) {
        throw new Error('Endereço de origem inválido');
    }
    if (!wallet.isValidAddress(toAddress)) {
        throw new Error('Endereço de destino inválido');
    }
    if (wallet.normalizeAddress(fromAddress) === wallet.normalizeAddress(toAddress)) {
        throw new Error('Não é possível enviar para si mesmo');
    }

    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum < MIN_AMOUNT) {
        throw new Error(`Valor deve ser >= ${MIN_AMOUNT}`);
    }
    if (amountNum > MAX_AMOUNT) {
        throw new Error(`Valor máximo por transação: ${MAX_AMOUNT} BRD`);
    }

    const feeNum = parseFloat(fee || '0');
    if (!Number.isFinite(feeNum) || feeNum < 0 || feeNum > MAX_FEE) {
        throw new Error(`Taxa deve estar entre 0 e ${MAX_FEE} BRD`);
    }

    if (!Number.isInteger(nonce) || nonce < 0) {
        throw new Error('Nonce inválido');
    }

    if (!timestamp) throw new Error('Timestamp é obrigatório');
    const ts = new Date(timestamp).getTime();
    if (isNaN(ts)) throw new Error('Timestamp inválido');

    const now = Date.now();
    if (ts > now + MAX_FUTURE_TIMESTAMP_MS) throw new Error('Timestamp muito no futuro');
    if (ts < now - MAX_PAST_TIMESTAMP_MS) throw new Error('Timestamp muito antigo');

    const validTypes = ['transfer', 'stake', 'unstake', 'reward', 'mint', 'burn', 'airdrop', 'wallet_creation', 'tip', 'nft_mint', 'nft_transfer'];
    if (type && !validTypes.includes(type)) {
        throw new Error('Tipo de transação inválido');
    }
}

// ============================================
// CLIENT-SIDE — CRIAR E ASSINAR
// ============================================
function createSignedTransaction({
    fromAddress,
    toAddress,
    amount,
    fee = 0,
    nonce,
    type = 'transfer',
    privateKey
}) {
    if (!privateKey) throw new Error('Chave privada é obrigatória');

    // 🆕 normaliza antes de assinar (o cliente também usa minúsculas)
    const fromAddr = wallet.normalizeAddress(fromAddress);
    const toAddr = wallet.normalizeAddress(toAddress);

    const timestamp = new Date().toISOString();

    const tx = {
        fromAddress: fromAddr,
        toAddress: toAddr,
        amount: amount.toString(),
        fee: fee.toString(),
        nonce,
        timestamp,
        type
    };

    validateTransactionPayload(tx);

    const message = buildSignableMessage(tx);
    const secp256k1 = require('@noble/secp256k1');
    const messageBytes = utf8ToBytes(message);
    const messageHash = sha256(messageBytes);

    const privateKeyBytes = privateKey.startsWith('0x')
        ? privateKey.slice(2)
        : privateKey;

    const signature = secp256k1.sign(messageHash, privateKeyBytes);
    const publicKey = secp256k1.getPublicKey(privateKeyBytes, true);

    return {
        ...tx,
        hash: calculateTxHash(tx, signature),
        signature: signature,
        publicKey: bytesToHex(publicKey)
    };
}

// ============================================
// SERVER-SIDE — SUBMETER TX ASSINADA
// ============================================
async function submitSignedTransaction({
    fromAddress,
    toAddress,
    amount,
    fee = 0,
    nonce,
    timestamp,
    type = 'transfer',
    signature,
    publicKey
}) {
    // 🆕 0. NORMALIZA antes de qualquer coisa
    const fromAddr = wallet.normalizeAddress(fromAddress);
    const toAddr = wallet.normalizeAddress(toAddress);

    const payload = {
        fromAddress: fromAddr,
        toAddress: toAddr,
        amount,
        fee,
        nonce,
        timestamp,
        type
    };
    validateTransactionPayload(payload);

    if (!signature || !publicKey) {
        throw new Error('Assinatura e chave pública são obrigatórias');
    }
    if (!wallet.isValidPublicKey(publicKey)) {
        throw new Error('Public key inválida');
    }

    // 2. publicKey ↔ address
    const derivedAddress = wallet.deriveAddressFromPublicKey(publicKey);
    if (derivedAddress !== fromAddr) {
        throw new Error('Public key não corresponde ao endereço de origem');
    }

    // 3. Assinatura
    const message = buildSignableMessage(payload);
    if (!wallet.verifySignature(message, signature, publicKey)) {
        throw new Error('Assinatura inválida');
    }

    // 4. Carteira origem
    const senderWallet = await WalletModel.findOne({ address: fromAddr });
    if (!senderWallet) throw new Error('Carteira de origem não encontrada');
    if (senderWallet.status !== 'active') throw new Error('Carteira de origem inativa');

    // 5. Nonce
    if (senderWallet.nonce !== nonce) {
        throw new Error(`Nonce inválido: esperado ${senderWallet.nonce}, recebido ${nonce}`);
    }

    // 6. Saldo
    const amountNum = parseFloat(amount);
    const feeNum = parseFloat(fee || '0');
    const totalCost = amountNum + feeNum;
    const balanceNum = parseFloat(senderWallet.balance.toString());
    if (balanceNum < totalCost) {
        throw new Error(`Saldo insuficiente: ${balanceNum} < ${totalCost}`);
    }

    // 7. Anti-replay assinatura
    if (await TransactionModel.findOne({ signature })) {
        throw new Error('Transação já submetida (replay detectado)');
    }

    // 8. Anti-replay nonce
    if (await TransactionModel.findOne({ from: fromAddr, nonce })) {
        throw new Error('Nonce já usado (replay detectado)');
    }

    // 9. Hash canônico
    const hash = calculateTxHash(payload, signature);

    // 10. Grava pending
    const transaction = await TransactionModel.create({
        hash,
        from: fromAddr,
        to: toAddr,
        amount: Decimal128.fromString(amountNum.toString()),
        fee: Decimal128.fromString(feeNum.toString()),
        nonce,
        signature,
        publicKey,
        type,
        status: 'pending',
        timestamp: new Date(timestamp)
    });

    // 11. Mempool
    try {
        await blockchain.addTransaction({
            hash,
            fromAddress: fromAddr,
            toAddress: toAddr,
            amount: amountNum,
            fee: feeNum,
            nonce,
            signature,
            publicKey,
            type,
            timestamp,
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
        message: `Transação de ${amount} BRD submetida. Será confirmada no próximo bloco.`,
        transaction: transaction.toPublic()
    };
}

// ============================================
// CONSULTAS
// ============================================
async function getTransactionByHash(hash) {
    if (!hash || typeof hash !== 'string') throw new Error('Hash é obrigatório');
    const tx = await TransactionModel.findOne({ hash });
    if (!tx) throw new Error('Transação não encontrada');
    return tx.toPublic();
}

async function getWalletTransactions(address, limit = 50, offset = 0) {
    const normalized = wallet.normalizeAddress(address);
    if (!wallet.isValidAddress(normalized)) throw new Error('Endereço inválido');

    limit = Math.min(Math.max(1, limit), 100);
    offset = Math.max(0, offset);

    const query = { $or: [{ from: normalized }, { to: normalized }] };

    const [transactions, total] = await Promise.all([
        TransactionModel.find(query).sort({ timestamp: -1 }).skip(offset).limit(limit).lean(),
        TransactionModel.countDocuments(query)
    ]);

    return {
        address: normalized,
        total,
        transactions: transactions.map(tx => ({
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            amount: tx.amount?.toString() || '0',
            fee: tx.fee?.toString() || '0',
            type: tx.type,
            status: tx.status,
            nonce: tx.nonce,
            blockIndex: tx.blockIndex,
            blockHash: tx.blockHash,
            confirmations: tx.confirmations,
            timestamp: tx.timestamp,
            confirmed: tx.status === 'confirmed'
        })),
        limit,
        offset,
        hasMore: offset + limit < total
    };
}

async function getTransactionStats() {
    const [total, pending, confirmed, failed, volumeAgg] = await Promise.all([
        TransactionModel.countDocuments({}),
        TransactionModel.countDocuments({ status: 'pending' }),
        TransactionModel.countDocuments({ status: 'confirmed' }),
        TransactionModel.countDocuments({ status: 'failed' }),
        TransactionModel.aggregate([
            { $match: { status: 'confirmed' } },
            { $group: { _id: null, totalVolume: { $sum: { $toDouble: '$amount' } }, totalFees: { $sum: { $toDouble: '$fee' } } } }
        ])
    ]);

    const agg = volumeAgg[0] || { totalVolume: 0, totalFees: 0 };

    return {
        totalTransactions: total,
        confirmed,
        pending,
        failed,
        totalVolume: agg.totalVolume,
        totalFees: agg.totalFees
    };
}

// ============================================
// MINERADOR
// ============================================
async function confirmTransaction(hash, blockIndex, blockHash) {
    return TransactionModel.findOneAndUpdate(
        { hash, status: 'pending' },
        { $set: { status: 'confirmed', blockIndex, blockHash, confirmations: 1 } },
        { new: true }
    );
}

async function failTransaction(hash, reason) {
    return TransactionModel.findOneAndUpdate(
        { hash, status: 'pending' },
        { $set: { status: 'failed', 'metadata.reason': reason } },
        { new: true }
    );
}

// ============================================
// AIRDROP
// ============================================
async function creditAirdrop({ toAddress, amount, campaign, userId }) {
    const toAddr = wallet.normalizeAddress(toAddress);

    if (!wallet.isValidAddress(toAddr)) throw new Error('Endereço de destino inválido');

    const fromAddress = wallet.normalizeAddress(process.env.RESERVE_ADDRESS);
    if (!fromAddress) throw new Error('RESERVE_ADDRESS não configurado no .env');

    const toWallet = await WalletModel.findOne({ address: toAddr });
    if (!toWallet) throw new Error('Carteira de destino não existe');
    if (toWallet.status !== 'active') throw new Error('Carteira de destino inativa');

    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) throw new Error('Valor do airdrop inválido');

    const timestamp = new Date().toISOString();
    const txPayload = {
        fromAddress,
        toAddress: toAddr,
        amount: amountNum,
        fee: 0,
        nonce: 0,
        timestamp,
        type: 'airdrop'
    };

    const internalSignature = `INTERNAL_AIRDROP_${campaign}_${Date.now()}`;
    const hash = calculateTxHash(txPayload, internalSignature);

    if (await TransactionModel.findOne({ hash })) {
        throw new Error('Transação de airdrop já registrada');
    }

    const tx = await TransactionModel.create({
        hash,
        from: fromAddress,
        to: toAddr,
        amount: Decimal128.fromString(amountNum.toString()),
        fee: Decimal128.fromString('0'),
        nonce: 0,
        signature: internalSignature,
        publicKey: 'INTERNAL',
        type: 'airdrop',
        status: 'confirmed',
        timestamp: new Date(timestamp),
        metadata: { campaign, userId: userId?.toString(), internal: true }
    });

    const newBalance = Number(toWallet.balance || 0) + amountNum;
    toWallet.balance = Decimal128.fromString(newBalance.toString());
    await toWallet.save();

    await WalletModel.updateOne({ address: fromAddress }, { $inc: { nonce: 1 } });

    console.log(`✅ Airdrop creditado: ${amountNum} BRD → ${toAddr}`);

    return {
        txHash: hash,
        blockIndex: null,
        amount: amountNum,
        newBalance: newBalance.toString()
    };
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
    initialize,
    buildSignableMessage,
    calculateTxHash,
    createSignedTransaction,
    submitSignedTransaction,
    getTransactionByHash,
    getWalletTransactions,
    getTransactionStats,
    confirmTransaction,
    failTransaction,
    creditAirdrop
};
