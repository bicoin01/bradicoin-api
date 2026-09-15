// wallet.js
// ============================================
// Bradicoin Blockchain - Wallet (v3.0)
// ============================================
// 🔐 ARQUITETURA NÃO-CUSTODIAL
//
// A chave privada NUNCA passa pelo servidor.
// O cliente (navegador) gera o par de chaves, assina
// transações localmente e envia apenas:
//   - publicKey
//   - address (derivado da publicKey)
//   - signature (das transações)
//
// Este módulo cuida apenas de:
//   - Validar e persistir publicKey + address
//   - Consultar saldo/histórico
//   - Verificar assinaturas
//
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
const ADDRESS_HEX_LENGTH = 38;      // 19 bytes de endereço
const ADDRESS_REGEX = /^Br[a-fA-F0-9]{38}$/;
const PUBLIC_KEY_REGEX = /^[a-fA-F0-9]{66}$/; // secp256k1 comprimida (33 bytes)
const INITIAL_BALANCE = '1000';      // string (Decimal128)

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    await WalletModel.init(); // garante índices
    console.log('✅ Wallet inicializada (não-custodial)');
}

// ============================================
// 🔐 VALIDAÇÃO DE ENDEREÇO
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
// 🔐 DERIVAR ENDEREÇO DE UMA PUBLIC KEY
// ============================================
// Padrão Ethereum-like: endereço = últimos 19 bytes do keccak256(pubKey)
//
// IMPORTANTE: essa função é determinística.
// Se dois clientes gerarem a mesma publicKey, o endereço será igual.
//
function deriveAddressFromPublicKey(publicKeyHex) {
    if (!isValidPublicKey(publicKeyHex)) {
        throw new Error('Public key inválida');
    }

    const pubKeyBytes = hexToBytes(publicKeyHex);
    const hash = keccak_256(pubKeyBytes);
    const addressBytes = hash.slice(-19); // últimos 19 bytes

    return ADDRESS_PREFIX + bytesToHex(addressBytes).toUpperCase();
}

// ============================================
// 🔐 VALIDAR QUE PUBLIC KEY CORRESPONDE AO ENDEREÇO
// ============================================
function publicKeyMatchesAddress(publicKeyHex, address) {
    try {
        const derived = deriveAddressFromPublicKey(publicKeyHex);
        return derived === address;
    } catch (e) {
        return false;
    }
}

// ============================================
// 🔐 VERIFICAR ASSINATURA
// ============================================
// Usado pelo transactions.js para validar que quem enviou
// a transação realmente tem a privateKey correspondente.
//
function verifySignature(message, signatureHex, publicKeyHex) {
    try {
        if (!message || !signatureHex || !publicKeyHex) return false;
        if (!isValidPublicKey(publicKeyHex)) return false;

        const messageBytes =
            typeof message === 'string'
                ? utf8ToBytes(message)
                : message;

        const messageHash = sha256(messageBytes);
        const signatureBytes = hexToBytes(signatureHex);

        return secp256k1.verify(signatureBytes, messageHash, publicKeyHex);
    } catch (e) {
        console.error('Erro ao verificar assinatura:', e.message);
        return false;
    }
}

// ============================================
// 🔐 RECUPERAR PUBLIC KEY DE UMA ASSINATURA
// ============================================
// Útil quando você tem a assinatura e o messageHash,
// mas não sabe quem assinou.
//
function recoverPublicKey(message, signatureHex, recovery) {
    try {
        const messageBytes =
            typeof message === 'string'
                ? utf8ToBytes(message)
                : message;

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
// REGISTRAR CARTEIRA (recebe publicKey do cliente)
// ============================================
// ⚠️ NÃO gera par de chaves aqui.
// O cliente já gerou e mandou apenas { address, publicKey }.
//
async function registerWallet({ address, publicKey, userId, username }) {
    // 1. Validações
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }

    if (!isValidPublicKey(publicKey)) {
        throw new Error('Public key inválida');
    }

    // 2. Verifica que address = derive(publicKey)
    if (!publicKeyMatchesAddress(publicKey, address)) {
        throw new Error('Public key não corresponde ao endereço informado');
    }

    // 3. Verifica se já existe
    const existing = await WalletModel.findOne({ address });
    if (existing) {
        throw new Error('Carteira já registrada');
    }

    if (userId) {
        const userHasWallet = await WalletModel.findOne({ userId });
        if (userHasWallet) {
            throw new Error('Usuário já possui uma carteira');
        }
    }

    // 4. Salva no Mongo
    const wallet = await WalletModel.create({
        address,
        publicKey,
        userId: userId || null,
        balance: '0',
        nonce: 0,
        status: 'active'
    });

    console.log(`👤 Carteira registrada: ${address}`);

    // 5. Transação de criação (com saldo inicial, se configurado)
    if (parseFloat(INITIAL_BALANCE) > 0) {
        try {
            await blockchain.addTransaction({
                fromAddress: null, // sistema
                toAddress: address,
                amount: parseFloat(INITIAL_BALANCE),
                type: 'wallet_creation'
            });
            console.log(`💰 Saldo inicial pendente: ${INITIAL_BALANCE} BRD`);
        } catch (e) {
            console.error('Erro ao adicionar saldo inicial:', e.message);
            // não falha o registro por causa disso
        }
    }

    return wallet.toPublic();
}

// ============================================
// CONSULTAR SALDO
// ============================================
async function getBalance(address) {
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }

    const walletDoc = await WalletModel.findOne({ address });

    if (!walletDoc) {
        return {
            address,
            exists: false,
            balance: '0',
            pending: '0',
            total: '0',
            nonce: 0,
            status: 'not_found'
        };
    }

    // Saldo confirmado (no Wallet)
    const confirmedBalance = parseFloat(walletDoc.balance.toString());

    // Saldo pendente (na mempool do blockchain)
    let pendingBalance = 0;
    if (blockchain.pendingTransactions) {
        for (const tx of blockchain.pendingTransactions) {
            if (tx.toAddress === address) pendingBalance += parseFloat(tx.amount);
            if (tx.fromAddress === address) pendingBalance -= parseFloat(tx.amount);
        }
    }

    return {
        address,
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
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }

    const Transaction = require('./models/Transaction');

    // 1. Histórico confirmado (MongoDB)
    const confirmed = await Transaction.find({
        $or: [{ from: address }, { to: address }],
        status: 'confirmed'
    })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();

    // 2. Pendentes (mempool)
    const pending = (blockchain.pendingTransactions || [])
        .filter(tx => tx.fromAddress === address || tx.toAddress === address)
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

    // 3. Junta e ordena
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
// BUSCAR CARTEIRA
// ============================================
async function getByAddress(address) {
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }
    return WalletModel.findOne({ address });
}

async function getByUserId(userId) {
    if (!userId) throw new Error('userId obrigatório');
    return WalletModel.findOne({ userId });
}

async function getPublicKey(address) {
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }
    const wallet = await WalletModel.findOne({ address }).select('publicKey');
    return wallet ? wallet.publicKey : null;
}

// ============================================
// ATUALIZAR SALDO (chamado pelo minerador)
// ============================================
async function creditBalance(address, amountStr) {
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }
    return WalletModel.credit(address, amountStr);
}

async function debitBalance(address, amountStr) {
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }
    return WalletModel.debit(address, amountStr);
}

// ============================================
// ESTATÍSTICAS DA REDE
// ============================================
async function getNetworkStats() {
    const [totalWallets, activeWallets, totalBalanceAgg] = await Promise.all([
        WalletModel.countDocuments({}),
        WalletModel.countDocuments({ status: 'active' }),
        WalletModel.aggregate([
            { $match: { status: 'active' } },
            {
                $group: {
                    _id: null,
                    total: { $sum: { $toDouble: '$balance' } }
                }
            }
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
