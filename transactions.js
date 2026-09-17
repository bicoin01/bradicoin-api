// transactions.js
// ============================================
// Bradicoin Blockchain - Transactions (v3.0)
// ============================================
// 🔐 ARQUITETURA NÃO-CUSTODIAL
//
// O cliente assina transações localmente e envia:
//   - fromAddress, toAddress, amount, fee, nonce, timestamp
//   - signature, publicKey
//
// O servidor:
//   1. Verifica a assinatura
//   2. Verifica que publicKey corresponde ao fromAddress
//   3. Verifica nonce (anti-replay)
//   4. Verifica saldo
//   5. Grava em Transaction (pending)
//   6. Adiciona à mempool do blockchain
//
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
const MAX_AMOUNT = 1_000_000_000;              // 1 bilhão por TX
const MAX_FEE = 1000;                          // 1000 BRD de taxa máxima
const MAX_FUTURE_TIMESTAMP_MS = 5 * 60 * 1000; // 5 min no futuro
const MAX_PAST_TIMESTAMP_MS = 10 * 60 * 1000;  // 10 min no passado
const MIN_AMOUNT = 0.00000001;                 // 1 satoshi

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    console.log('✅ Transactions inicializadas');
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

    if (fromAddress === toAddress) {
        throw new Error('Não é possível enviar para si mesmo');
    }

    // Amount
    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum < MIN_AMOUNT) {
        throw new Error(`Valor deve ser >= ${MIN_AMOUNT}`);
    }
    if (amountNum > MAX_AMOUNT) {
        throw new Error(`Valor máximo por transação: ${MAX_AMOUNT} BRD`);
    }

    // Fee
    const feeNum = parseFloat(fee || '0');
    if (!Number.isFinite(feeNum) || feeNum < 0 || feeNum > MAX_FEE) {
        throw new Error(`Taxa deve estar entre 0 e ${MAX_FEE} BRD`);
    }

    // Nonce
    if (!Number.isInteger(nonce) || nonce < 0) {
        throw new Error('Nonce inválido');
    }

    // Timestamp
    if (!timestamp) {
        throw new Error('Timestamp é obrigatório');
    }
    const ts = new Date(timestamp).getTime();
    if (isNaN(ts)) {
        throw new Error('Timestamp inválido');
    }
    const now = Date.now();
    if (ts > now + MAX_FUTURE_TIMESTAMP_MS) {
        throw new Error('Timestamp muito no futuro');
    }
    if (ts < now - MAX_PAST_TIMESTAMP_MS) {
        throw new Error('Timestamp muito antigo');
    }

    // Type
    const validTypes = ['transfer', 'stake', 'unstake', 'reward', 'mint', 'burn', 'airdrop', 'wallet_creation', 'tip', 'nft_mint', 'nft_transfer'];
    if (type && !validTypes.includes(type)) {
        throw new Error('Tipo de transação inválido');
    }
}

// ============================================
// STRING CANÔNICA PARA ASSINATURA
// ============================================
// ⚠️ IMPORTANTE: essa string DEVE ser idêntica no client e no server.
//
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
// CALCULAR HASH DA TRANSAÇÃO
// ============================================
function calculateTxHash(tx, signature) {
    const payload = JSON.stringify({
        fromAddress: tx.fromAddress,
        toAddress: tx.toAddress,
        amount: tx.amount.toString(),
        fee: (tx.fee || '0').toString(),
        nonce: tx.nonce,
        timestamp: tx.timestamp,
        type: tx.type || 'transfer',
        signature: signature || null
    });

    return bytesToHex(sha256(utf8ToBytes(payload)));
}

// ============================================
// 🖥️ CLIENT-SIDE — CRIAR E ASSINAR
// ============================================
// Esta função fica aqui para o SDK reusar.
// No frontend, ela roda no navegador com a privateKey do usuário.
//
function createSignedTransaction({
    fromAddress,
    toAddress,
    amount,
    fee = 0,
    nonce,
    type = 'transfer',
    privateKey
}) {
    if (!privateKey) {
        throw new Error('Chave privada é obrigatória');
    }

    const timestamp = new Date().toISOString();

    const tx = {
        fromAddress,
        toAddress,
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
// 🖥️ SERVER-SIDE — SUBMETER TX JÁ ASSINADA
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
    // 1. Validações de formato
    const payload = {
        fromAddress,
        toAddress,
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

    // 2. Verifica que publicKey corresponde ao fromAddress
    const derivedAddress = wallet.deriveAddressFromPublicKey(publicKey);
    if (derivedAddress !== fromAddress) {
        throw new Error('Public key não corresponde ao endereço de origem');
    }

    // 3. Verifica assinatura
    const message = buildSignableMessage(payload);
    const isValidSig = wallet.verifySignature(message, signature, publicKey);

    if (!isValidSig) {
        throw new Error('Assinatura inválida');
    }

    // 4. Verifica carteira de origem
    const senderWallet = await WalletModel.findOne({ address: fromAddress });

    if (!senderWallet) {
        throw new Error('Carteira de origem não encontrada');
    }

    if (senderWallet.status !== 'active') {
        throw new Error('Carteira de origem inativa');
    }

    // 5. Verifica nonce (anti-replay)
    if (senderWallet.nonce !== nonce) {
        throw new Error(
            `Nonce inválido: esperado ${senderWallet.nonce}, recebido ${nonce}`
        );
    }

    // 6. Verifica saldo
    const amountNum = parseFloat(amount);
    const feeNum = parseFloat(fee || '0');
    const totalCost = amountNum + feeNum;

    const balanceNum = parseFloat(senderWallet.balance.toString());
    if (balanceNum < totalCost) {
        throw new Error(`Saldo insuficiente: ${balanceNum} < ${totalCost}`);
    }

    // 7. Anti-replay por assinatura
    const existingSig = await TransactionModel.findOne({ signature });
    if (existingSig) {
        throw new Error('Transação já submetida (replay detectado)');
    }

    // 8. Anti-replay por nonce
    const existingNonce = await TransactionModel.findOne({
        from: fromAddress,
        nonce
    });
    if (existingNonce) {
        throw new Error('Nonce já usado (replay detectado)');
    }

    // 9. Calcula hash
    const hash = calculateTxHash(payload, signature);

    // 10. Grava no banco (pending)
    const transaction = await TransactionModel.create({
        hash,
        from: fromAddress,
        to: toAddress,
        amount: Decimal128.fromString(amountNum.toString()),
        fee: Decimal128.fromString(feeNum.toString()),
        nonce,
        signature,
        publicKey,
        type,
        status: 'pending',
        timestamp: new Date(timestamp)
    });

    // 11. Adiciona ao blockchain
    try {
        await blockchain.addTransaction({
            hash,
            fromAddress,
            toAddress,
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
        // Rollback: apaga a TX do Mongo se o blockchain recusar
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
// BUSCAR TRANSAÇÃO POR HASH
// ============================================
async function getTransactionByHash(hash) {
    if (!hash || typeof hash !== 'string') {
        throw new Error('Hash é obrigatório');
    }

    const tx = await TransactionModel.findOne({ hash });

    if (!tx) {
        throw new Error('Transação não encontrada');
    }

    return tx.toPublic();
}

// ============================================
// BUSCAR TRANSAÇÕES DE UMA CARTEIRA
// ============================================
async function getWalletTransactions(address, limit = 50, offset = 0) {
    if (!wallet.isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }

    limit = Math.min(Math.max(1, limit), 100);
    offset = Math.max(0, offset);

    const query = { $or: [{ from: address }, { to: address }] };

    const [transactions, total] = await Promise.all([
        TransactionModel.find(query)
            .sort({ timestamp: -1 })
            .skip(offset)
            .limit(limit)
            .lean(),
        TransactionModel.countDocuments(query)
    ]);

    return {
        address,
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

// ============================================
// ESTATÍSTICAS
// ============================================
async function getTransactionStats() {
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
// CONFIRMAR TRANSAÇÃO (chamado pelo minerador)
// ============================================
async function confirmTransaction(hash, blockIndex, blockHash) {
    const result = await TransactionModel.findOneAndUpdate(
        { hash, status: 'pending' },
        {
            $set: {
                status: 'confirmed',
                blockIndex,
                blockHash,
                confirmations: 1
            }
        },
        { new: true }
    );
    return result;
}

// ============================================
// MARCAR COMO FALHA (rollback)
// ============================================
async function failTransaction(hash, reason) {
    const result = await TransactionModel.findOneAndUpdate(
        { hash, status: 'pending' },
        {
            $set: {
                status: 'failed',
                'metadata.reason': reason
            }
        },
        { new: true }
    );
    return result;
}

// ============================================
// creditAirdrop — crédito interno de airdrop
// ============================================
async function creditAirdrop({ toAddress, amount, campaign, userId }) {
    const WalletModel = require('./models/Wallet');
    const BlockchainTx = require('./models/Transaction');

    const toWallet = await WalletModel.findOne({ address: toAddress.toLowerCase() });
    if (!toWallet) throw new Error('Carteira de destino não existe');

    const nonce = toWallet.nonce || 0;

    const tx = await BlockchainTx.create({
        fromAddress: process.env.RESERVE_ADDRESS,
        toAddress: toAddress.toLowerCase(),
        amount: amount.toString(),
        fee: '0',
        nonce,
        timestamp: Date.now(),
        type: 'airdrop',
        status: 'confirmed',
        signature: 'INTERNAL_AIRDROP',
        publicKey: 'INTERNAL_AIRDROP',
        metadata: { campaign, userId }
    });

    toWallet.balance = (Number(toWallet.balance || 0) + Number(amount)).toString();
    toWallet.nonce = nonce + 1;
    await toWallet.save();

    return {
        txHash: tx.hash || tx._id.toString(),
        blockIndex: null,
        amount,
        newBalance: toWallet.balance
    };
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
    initialize,

    // Helpers (usar no client-side)
    buildSignableMessage,
    calculateTxHash,
    createSignedTransaction,

    // Server-side
    submitSignedTransaction,

    // Consultas
    getTransactionByHash,
    getWalletTransactions,
    getTransactionStats,

    // Minerador
    confirmTransaction,
    failTransaction,

    // Airdrop
    creditAirdrop
};
