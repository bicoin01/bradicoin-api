// wallet.js
// ============================================
// Bradicoin Blockchain - Wallet (v3.2)
// ============================================
// 🔐 ARQUITETURA NÃO-CUSTODIAL
// v3.1 — normalização de endereço (case-insensitive)
// v3.2 — aritmética de saldo em BigInt (sem erro de ponto flutuante),
//        validação real de chave pública, require lazy do blockchain
//        (evita dependência circular), proteção contra race/NoSQL injection,
//        airdrop inicial só para usuário identificado
// ============================================
// Requer @noble/secp256k1 v1.x (API: verify / Point / Signature.fromCompact)
// ============================================

const secp256k1 = require('@noble/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex, hexToBytes, utf8ToBytes } = require('@noble/hashes/utils');

const WalletModel = require('./models/Wallet');
const Transaction = require('./models/Transaction');

// blockchain é carregado sob demanda: se blockchain.js também requer wallet.js,
// um require no topo devolveria um objeto vazio (dependência circular).
function getBlockchain() {
    return require('./blockchain');
}

// ============================================
// CONSTANTES
// ============================================
const ADDRESS_PREFIX = 'Br';
const ADDRESS_HEX_LENGTH = 38;
const ADDRESS_REGEX = new RegExp(`^${ADDRESS_PREFIX}[a-f0-9]{${ADDRESS_HEX_LENGTH}}$`, 'i');
const PUBLIC_KEY_REGEX = /^0[23][a-fA-F0-9]{64}$/;      // chave comprimida (33 bytes)
const SIGNATURE_REGEX = /^[a-fA-F0-9]{128}$/;           // assinatura compacta (64 bytes)
const AMOUNT_REGEX = /^\d{1,18}(\.\d{1,8})?$/;          // até 8 casas decimais

const DECIMALS = 8;
const UNIT = 10n ** BigInt(DECIMALS);

const INITIAL_BALANCE = process.env.WALLET_INITIAL_BALANCE || '1000';
const REQUIRE_REGISTER_SIGNATURE = process.env.REQUIRE_REGISTER_SIGNATURE === 'true';

const MAX_HISTORY_LIMIT = 200;

// ============================================
// HELPERS DE VALOR (BigInt, 8 casas)
// ============================================
function toUnits(value) {
    let str;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Valor inválido');
        str = value.toFixed(DECIMALS);
    } else {
        str = String(value ?? '0').trim();
    }

    let match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str);
    if (!match) {
        // Fallback para notação científica (ex.: Decimal128 "1E+3")
        const n = Number(str);
        if (!Number.isFinite(n)) throw new Error('Valor inválido');
        match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(n.toFixed(DECIMALS));
        if (!match) throw new Error('Valor inválido');
    }

    const frac = (match[3] || '').padEnd(DECIMALS, '0').slice(0, DECIMALS);
    const units = BigInt(match[2]) * UNIT + BigInt(frac);
    return match[1] === '-' ? -units : units;
}

function safeToUnits(value) {
    try {
        return toUnits(value);
    } catch (e) {
        return 0n;
    }
}

function formatUnits(units) {
    const negative = units < 0n;
    const abs = negative ? -units : units;
    const int = abs / UNIT;
    const frac = (abs % UNIT).toString().padStart(DECIMALS, '0');
    return `${negative ? '-' : ''}${int}.${frac}`;
}

// Valida valor positivo vindo de fora (string ou número) e devolve string canônica
function assertPositiveAmount(amount) {
    const str = typeof amount === 'number' && Number.isFinite(amount)
        ? amount.toFixed(DECIMALS)
        : amount;

    if (typeof str !== 'string' || !AMOUNT_REGEX.test(str.trim())) {
        throw new Error('Valor inválido');
    }
    if (toUnits(str) <= 0n) {
        throw new Error('Valor deve ser maior que zero');
    }
    return str.trim();
}

// ============================================
// NORMALIZAÇÃO — prefixo "Br" + resto em minúsculo
// ============================================
function normalizeAddress(address) {
    if (typeof address !== 'string') return address;
    const trimmed = address.trim();
    if (trimmed.length < ADDRESS_PREFIX.length) return trimmed;
    if (trimmed.slice(0, ADDRESS_PREFIX.length).toLowerCase() !== ADDRESS_PREFIX.toLowerCase()) {
        return trimmed;
    }
    return ADDRESS_PREFIX + trimmed.slice(ADDRESS_PREFIX.length).toLowerCase();
}

// Normaliza + valida; lança erro se inválido
function requireAddress(address) {
    const normalized = normalizeAddress(address);
    if (!isValidAddress(normalized)) {
        throw new Error('Endereço inválido');
    }
    return normalized;
}

// userId só pode ser string/número/ObjectId (evita injeção NoSQL como { "$ne": null })
function sanitizeUserId(userId) {
    if (userId === undefined || userId === null || userId === '') return null;
    if (typeof userId === 'string' || typeof userId === 'number') return String(userId);
    if (typeof userId === 'object' && typeof userId.toHexString === 'function') {
        return userId.toHexString();
    }
    throw new Error('userId inválido');
}

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    await WalletModel.init();
    console.log('✅ Wallet inicializada (não-custodial)');
}

// ============================================
// 🔐 VALIDAÇÃO
// ============================================
function isValidAddress(address) {
    if (!address || typeof address !== 'string') return false;
    return ADDRESS_REGEX.test(address);
}

// Formato + ponto realmente existente na curva secp256k1
function isValidPublicKey(publicKey) {
    if (!publicKey || typeof publicKey !== 'string') return false;
    if (!PUBLIC_KEY_REGEX.test(publicKey)) return false;
    try {
        secp256k1.Point.fromHex(publicKey);
        return true;
    } catch (e) {
        return false;
    }
}

// ============================================
// 🔐 DERIVAR ENDEREÇO (sempre minúsculo)
// ============================================
function deriveAddressFromPublicKey(publicKeyHex) {
    if (!isValidPublicKey(publicKeyHex)) {
        throw new Error('Public key inválida');
    }

    const pubKeyBytes = hexToBytes(publicKeyHex.toLowerCase());
    const hash = keccak_256(pubKeyBytes);
    const addressBytes = hash.slice(-ADDRESS_HEX_LENGTH / 2);

    return ADDRESS_PREFIX + bytesToHex(addressBytes).toLowerCase();
}

function publicKeyMatchesAddress(publicKeyHex, address) {
    try {
        return deriveAddressFromPublicKey(publicKeyHex) === normalizeAddress(address);
    } catch (e) {
        return false;
    }
}

// ============================================
// 🔐 ASSINATURAS
// ============================================
function messageToHash(message) {
    if (typeof message === 'string') return sha256(utf8ToBytes(message));
    if (message instanceof Uint8Array) return sha256(message);
    throw new Error('Mensagem inválida');
}

function verifySignature(message, signatureHex, publicKeyHex) {
    try {
        if (!message || typeof signatureHex !== 'string') return false;
        if (!SIGNATURE_REGEX.test(signatureHex)) return false;
        if (!isValidPublicKey(publicKeyHex)) return false;

        const messageHash = messageToHash(message);
        const signatureBytes = hexToBytes(signatureHex.toLowerCase());

        return secp256k1.verify(signatureBytes, messageHash, publicKeyHex.toLowerCase());
    } catch (e) {
        // Sem console.error: assinaturas inválidas são esperadas e poderiam
        // ser usadas para encher o log
        return false;
    }
}

function recoverPublicKey(message, signatureHex, recovery) {
    try {
        if (typeof signatureHex !== 'string' || !SIGNATURE_REGEX.test(signatureHex)) return null;
        if (!Number.isInteger(recovery) || recovery < 0 || recovery > 3) return null;

        const messageHash = messageToHash(message);
        const signatureBytes = hexToBytes(signatureHex.toLowerCase());

        // toHex(true) => chave COMPRIMIDA (66 hex), compatível com isValidPublicKey.
        // Sem o "true", o noble v1 devolve a chave não comprimida (130 hex).
        return secp256k1.Signature
            .fromCompact(signatureBytes)
            .addRecoveryBit(recovery)
            .recoverPublicKey(messageHash)
            .toHex(true);
    } catch (e) {
        return null;
    }
}

// ============================================
// REGISTRAR CARTEIRA
// ============================================
// signature (opcional, ou obrigatória com REQUIRE_REGISTER_SIGNATURE=true):
// assinatura de `bradicoin:register:<address>` com a chave privada da carteira,
// provando que quem registra é o dono da chave.
async function registerWallet({ address, publicKey, userId, signature }) {
    const normalizedAddress = requireAddress(address);
    const safeUserId = sanitizeUserId(userId);

    if (!isValidPublicKey(publicKey)) {
        throw new Error('Public key inválida');
    }
    if (!publicKeyMatchesAddress(publicKey, normalizedAddress)) {
        throw new Error('Public key não corresponde ao endereço informado');
    }

    if (signature || REQUIRE_REGISTER_SIGNATURE) {
        const proofMessage = `bradicoin:register:${normalizedAddress}`;
        if (!verifySignature(proofMessage, signature, publicKey)) {
            throw new Error('Assinatura de propriedade inválida');
        }
    }

    // Checagens amigáveis (a garantia real é o índice único no banco, tratado abaixo)
    if (await WalletModel.findOne({ address: normalizedAddress }).select('_id').lean()) {
        throw new Error('Carteira já registrada');
    }
    if (safeUserId && await WalletModel.findOne({ userId: safeUserId }).select('_id').lean()) {
        throw new Error('Usuário já possui uma carteira');
    }

    let wallet;
    try {
        wallet = await WalletModel.create({
            address: normalizedAddress,
            publicKey: publicKey.toLowerCase(),
            userId: safeUserId,
            balance: '0',
            nonce: 0,
            status: 'active'
        });
    } catch (err) {
        if (err && err.code === 11000) {
            throw new Error(
                err.keyPattern && err.keyPattern.userId
                    ? 'Usuário já possui uma carteira'
                    : 'Carteira já registrada'
            );
        }
        throw err;
    }

    console.log(`👤 Carteira registrada: ${normalizedAddress}`);

    // Saldo inicial: só para carteira ligada a um usuário (1 por usuário).
    // Sem isso, qualquer pessoa geraria chaves à vontade e ganharia BRD grátis.
    if (safeUserId && toUnits(INITIAL_BALANCE) > 0n) {
        try {
            await getBlockchain().addTransaction({
                fromAddress: null,
                toAddress: normalizedAddress,
                amount: Number(INITIAL_BALANCE),
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
    const normalized = requireAddress(address);

    const walletDoc = await WalletModel.findOne({ address: normalized }).lean();

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

    const confirmed = safeToUnits(walletDoc.balance);

    let pending = 0n;
    const pendingTxs = getBlockchain().pendingTransactions;
    if (Array.isArray(pendingTxs)) {
        for (const tx of pendingTxs) {
            if (normalizeAddress(tx.toAddress) === normalized) {
                pending += safeToUnits(tx.amount);
            }
            if (normalizeAddress(tx.fromAddress) === normalized) {
                // saída = valor + taxa
                pending -= safeToUnits(tx.amount) + safeToUnits(tx.fee);
            }
        }
    }

    return {
        address: normalized,
        exists: true,
        balance: formatUnits(confirmed),
        pending: formatUnits(pending),
        total: formatUnits(confirmed + pending),
        nonce: walletDoc.nonce,
        status: walletDoc.status,
        publicKey: walletDoc.publicKey
    };
}

// ============================================
// HISTÓRICO
// ============================================
async function getHistory(address, limit = 50) {
    const normalized = requireAddress(address);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), MAX_HISTORY_LIMIT);

    const confirmed = await Transaction.find({
        $or: [{ from: normalized }, { to: normalized }],
        status: 'confirmed'
    })
        .sort({ timestamp: -1 })
        .limit(safeLimit)
        .lean();

    const pendingTxs = getBlockchain().pendingTransactions || [];
    const pending = pendingTxs
        .filter((tx) =>
            normalizeAddress(tx.fromAddress) === normalized ||
            normalizeAddress(tx.toAddress) === normalized)
        .map((tx) => ({
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
        ...confirmed.map((tx) => ({
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

    const time = (t) => {
        const n = new Date(t).getTime();
        return Number.isFinite(n) ? n : 0;
    };

    all.sort((a, b) => time(b.timestamp) - time(a.timestamp));
    return all.slice(0, safeLimit);
}

// ============================================
// BUSCAR
// ============================================
async function getByAddress(address) {
    const normalized = requireAddress(address);
    return WalletModel.findOne({ address: normalized });
}

async function getByUserId(userId) {
    const safeUserId = sanitizeUserId(userId);
    if (!safeUserId) throw new Error('userId obrigatório');
    return WalletModel.findOne({ userId: safeUserId });
}

async function getPublicKey(address) {
    const normalized = requireAddress(address);
    const wallet = await WalletModel.findOne({ address: normalized })
        .select('publicKey')
        .lean();
    return wallet ? wallet.publicKey : null;
}

// ============================================
// SALDO (uso interno — NUNCA exponha estas funções direto em rota HTTP)
// ============================================
async function creditBalance(address, amountStr) {
    const normalized = requireAddress(address);
    const amount = assertPositiveAmount(amountStr);
    return WalletModel.credit(normalized, amount);
}

async function debitBalance(address, amountStr) {
    const normalized = requireAddress(address);
    const amount = assertPositiveAmount(amountStr);
    return WalletModel.debit(normalized, amount);
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
            // Decimal128 evita erro de ponto flutuante na soma
            { $group: { _id: null, total: { $sum: { $toDecimal: '$balance' } } } }
        ])
    ]);

    const total = totalBalanceAgg[0]?.total;

    return {
        totalWallets,
        activeWallets,
        totalBalance: total !== undefined && total !== null ? total.toString() : '0'
    };
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
    initialize,

    // Helpers
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
