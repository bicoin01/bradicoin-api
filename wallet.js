// wallet.js
// ============================================
// Bradicoin Blockchain - Wallet (v3.1)
// ============================================
// 🔐 ARQUITETURA NÃO-CUSTODIAL
// 🆕 v3.1 — normalização de endereço (case-insensitive)
// ============================================

const crypto = require('crypto');
const secp256k1 = require('@noble/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex, hexToBytes, utf8ToBytes } = require('@noble/hashes/utils');

const WalletModel = require('./models/Wallet');
const blockchain = require('./blockchain');

// ============================================
// CONSTANTES
// ============================================
const ADDRESS_PREFIX = 'Br';
const ADDRESS_HEX_LENGTH = 38;
const ADDRESS_REGEX = /^Br[a-fA-F0-9]{38}$/i;   // ← aceita A-F e a-f
const PUBLIC_KEY_REGEX = /^[a-fA-F0-9]{66}$/;
const INITIAL_BALANCE = '1000';

// ============================================
// 🆕 NORMALIZAÇÃO — sempre minúsculo depois do prefixo
// ============================================
function normalizeAddress(address) {
    if (!address || typeof address !== 'string') return address;
    if (address.length < 3 || !address.startsWith('Br')) return address;
    // 'Br' + resto em minúsculo (aceita 'BR' ou 'Br' na entrada)
    return 'Br' + address.slice(2).toLowerCase();
}

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    await WalletModel.init();
    console.log('✅ Wallet inicializada (não-custodial)');
}

// ============================================
// 🔐 VALIDAÇÃO DE ENDEREÇO (case-insensitive)
// ============================================
function isValidAddress(address) {
    if (!address || typeof address !== 'string') return false;
    return ADDRESS_REGEX.test(address);
}

function isValidPublicKey(publicKey) {
    if (!publicKey || typeof publicKey !== 'string') return false;
    return PUBLIC_KEY_REGEX.test(publicKey);
}

// ============================================
// 🔐 DERIVAR ENDEREÇO (sempre minúsculo)
// ============================================
function deriveAddressFromPublicKey(publicKeyHex) {
    if (!isValidPublicKey(publicKeyHex)) {
        throw new Error('Public key inválida');
    }

    const pubKeyBytes = hexToBytes(publicKeyHex);
    const hash = keccak_256(pubKeyBytes);
    const addressBytes = hash.slice(-19);

    // 🆕 sempre minúsculo
    return ADDRESS_PREFIX + bytesToHex(addressBytes).toLowerCase();
}

// ============================================
// 🔐 VERIFICAÇÃO
// ============================================
function publicKeyMatchesAddress(publicKeyHex, address) {
    try {
        const derived = deriveAddressFromPublicKey(publicKeyHex);
        const normalized = normalizeAddress(address);
        return derived === normalized;
    } catch (e) {
        return false;
    }
}

function verifySignature(message, signatureHex, publicKeyHex) {
    try {
        if (!message || !signatureHex || !publicKeyHex) return false;
        if (!isValidPublicKey(publicKeyHex)) return false;

        const messageBytes =
            typeof message === 'string' ? utf8ToBytes(message) : message;

        const messageHash = sha256(messageBytes);
        const signatureBytes = hexToBytes(signatureHex);

        return secp256k1.verify(signatureBytes, messageHash, publicKeyHex);
    } catch (e) {
        console.error('Erro ao verificar assinatura:', e.message);
        return false;
    }
}

function recoverPublicKey(message, signatureHex, recovery) {
    try {
        const messageBytes =
            typeof message === 'string' ? utf8ToBytes(message) : message;
        const messageHash = sha256(messageBytes);
        const signatureBytes = hexToBytes(signatureHex);

        const pubKey = secp256k1.Signature
            .fromCompact(signatureBytes)
            .addRecoveryBit(recovery)
            .recoverPublicKey(messageHash)
            .toHex();

        return pubKey;
    } catch (e) {
        console.error('Erro ao recuperar public key:', e.message);
        return null;
    }
}

// ============================================
// REGISTRAR CARTEIRA
// ============================================
async function registerWallet({ address, publicKey, userId, username }) {
    const normalizedAddress = normalizeAddress(address);

    if (!isValidAddress(normalizedAddress)) {
        throw new Error('Endereço inválido');
    }
    if (!isValidPublicKey(publicKey)) {
        throw new Error('Public key inválida');
    }
    if (!publicKeyMatchesAddress(publicKey, normalizedAddress)) {
        throw new Error('Public key não corresponde ao endereço informado');
    }

    const existing = await WalletModel.findOne({ address: normalizedAddress });
    if (existing) {
        throw new Error('Carteira já registrada');
    }

    if (userId) {
        const userHasWallet = await WalletModel.findOne({ userId });
        if (userHasWallet) {
            throw new Error('Usuário já possui uma carteira');
        }
    }

    const wallet = await WalletModel.create({
        address: normalizedAddress,
        publicKey,
        userId: userId || null,
        balance: '0',
        nonce: 0,
        status: 'active'
    });

    console.log(`👤 Carteira registrada: ${normalizedAddress}`);

    if (parseFloat(INITIAL_BALANCE) > 0) {
        try {
            await blockchain.addTransaction({
                fromAddress: null,
                toAddress: normalizedAddress,
                amount: parseFloat(INITIAL_BALANCE),
                type: 'wallet_creation'
            });
            console.log(`💰 Saldo inicial pendente: ${INITIAL_BALANCE} BRD`);
        } catch (e) {
            console.error('Erro ao adicionar saldo inicial:', e.message);
        }
    }

    return wallet.toPublic();
}

// ============================================
// CONSULTAR SALDO
// ============================================
async function getBalance(address) {
    const normalized = normalizeAddress(address);
    if (!isValidAddress(normalized)) {
        throw new Error('Endereço inválido');
    }

    const walletDoc = await WalletModel.findOne({ address: normalized });

    if (!walletDoc) {
        return {
            address: normalized,
            exists: false,
            balance: '0',
            pending: '0',
            total: '0',
            nonce: 0,
            status: 'not_found'
        };
    }

    const confirmedBalance = parseFloat(walletDoc.balance.toString());

    let pendingBalance = 0;
    if (blockchain.pendingTransactions) {
        for (const tx of blockchain.pendingTransactions) {
            if (tx.toAddress === normalized) pendingBalance += parseFloat(tx.amount);
            if (tx.fromAddress === normalized) pendingBalance -= parseFloat(tx.amount);
        }
    }

    return {
        address: normalized,
        exists: true,
        balance: confirmedBalance.toFixed(8),
        pending: pendingBalance.toFixed(8),
        total: (confirmedBalance + pendingBalance).toFixed(8),
        nonce: walletDoc.nonce,
        status: walletDoc.status,
        publicKey: walletDoc.publicKey
    };
}

// ============================================
// HISTÓRICO
// ============================================
async function getHistory(address, limit = 50) {
    const normalized = normalizeAddress(address);
    if (!isValidAddress(normalized)) {
        throw new Error('Endereço inválido');
    }

    const Transaction = require('./models/Transaction');

    const confirmed = await Transaction.find({
        $or: [{ from: normalized }, { to: normalized }],
        status: 'confirmed'
    })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();

    const pending = (blockchain.pendingTransactions || [])
        .filter(tx => tx.fromAddress === normalized || tx.toAddress === normalized)
        .map(tx => ({
            from: tx.fromAddress,
            to: tx.toAddress,
            amount: tx.amount?.toString() || '0',
            fee: tx.fee?.toString() || '0',
            type: tx.type || 'transfer',
            status: 'pending',
            timestamp: tx.timestamp,
            hash: tx.hash || null
        }));

    const all = [
        ...confirmed.map(tx => ({
            from: tx.from,
            to: tx.to,
            amount: tx.amount?.toString() || '0',
            fee: tx.fee?.toString() || '0',
            type: tx.type,
            status: tx.status,
            timestamp: tx.timestamp,
            hash: tx.hash,
            blockIndex: tx.blockIndex
        })),
        ...pending
    ];

    all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return all.slice(0, limit);
}

// ============================================
// BUSCAR
// ============================================
async function getByAddress(address) {
    const normalized = normalizeAddress(address);
    if (!isValidAddress(normalized)) {
        throw new Error('Endereço inválido');
    }
    return WalletModel.findOne({ address: normalized });
}

async function getByUserId(userId) {
    if (!userId) throw new Error('userId obrigatório');
    return WalletModel.findOne({ userId });
}

async function getPublicKey(address) {
    const normalized = normalizeAddress(address);
    if (!isValidAddress(normalized)) {
        throw new Error('Endereço inválido');
    }
    const wallet = await WalletModel.findOne({ address: normalized }).select('publicKey');
    return wallet ? wallet.publicKey : null;
}

// ============================================
// SALDO
// ============================================
async function creditBalance(address, amountStr) {
    const normalized = normalizeAddress(address);
    if (!isValidAddress(normalized)) {
        throw new Error('Endereço inválido');
    }
    return WalletModel.credit(normalized, amountStr);
}

async function debitBalance(address, amountStr) {
    const normalized = normalizeAddress(address);
    if (!isValidAddress(normalized)) {
        throw new Error('Endereço inválido');
    }
    return WalletModel.debit(normalized, amountStr);
}

// ============================================
// STATS
// ============================================
async function getNetworkStats() {
    const [totalWallets, activeWallets, totalBalanceAgg] = await Promise.all([
        WalletModel.countDocuments({}),
        WalletModel.countDocuments({ status: 'active' }),
        WalletModel.aggregate([
            { $match: { status: 'active' } },
            { $group: { _id: null, total: { $sum: { $toDouble: '$balance' } } } }
        ])
    ]);

    return {
        totalWallets,
        activeWallets,
        totalBalance: totalBalanceAgg[0]?.total || 0
    };
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
    initialize,

    // 🆕
    normalizeAddress,

    // Validações
    isValidAddress,
    isValidPublicKey,
    publicKeyMatchesAddress,

    // Criptografia
    deriveAddressFromPublicKey,
    verifySignature,
    recoverPublicKey,

    // Operações
    registerWallet,
    getBalance,
    getHistory,
    getByAddress,
    getByUserId,
    getPublicKey,
    creditBalance,
    debitBalance,
    getNetworkStats
};
