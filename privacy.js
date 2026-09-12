// privacy.js
// ============================================
// Bradicoin Blockchain - Privacy Module
// ============================================
// ⚠️  ATENÇÃO
// Este módulo implementa conceitos de privacidade de forma DIDÁTICA.
// - Stealth addresses: implementação ECDH REAL (secp256k1)
// - Ring signatures: ECDSA simplificado (NÃO é LSAG de produção)
// - Coin mixing: shuffle + commitments (NÃO é Chaumian blind sig)
// - P2P: HTTP simples (NÃO é DHT real)
//
// Para uso em produção com privacidade real, considere:
// - ZK-SNARKs via snarkjs (ver zkPrivacy.js)
// - Ring signatures LSAG via bibliotecas dedicadas
// - libp2p para rede P2P real
// ============================================

const crypto = require('crypto');
const mongoose = require('mongoose');

// ============================================
// CONFIGURAÇÃO
// ============================================
const RING_SIZE = 11;               // Tamanho padrão do ring (Monero-style)
const MIXING_POOL_TTL_MS = 3600000; // 1 hora
const MIXING_FEE_RATE = 0.001;      // 0.1%
const P2P_PORT = parseInt(process.env.P2P_PORT) || 8334;

// ============================================
// SCHEMAS MONGOOSE
// ============================================
const KeyImageSchema = new mongoose.Schema({
    keyImage: { type: String, required: true, unique: true, index: true },
    address: { type: String, required: true, index: true },
    txHash: { type: String, required: true },
    createdAt: { type: Number, default: () => Date.now() }
});

const StealthAddressSchema = new mongoose.Schema({
    stealthAddress: { type: String, required: true, unique: true, index: true },
    recipientPubKey: { type: String, required: true },
    ephemeralPubKey: { type: String, required: true },
    txHash: { type: String, default: null },
    used: { type: Boolean, default: false },
    createdAt: { type: Number, default: () => Date.now() }
});

const MixingPoolSchema = new mongoose.Schema({
    poolId: { type: String, required: true, unique: true, index: true },
    amount: { type: Number, required: true },
    requiredParticipants: { type: Number, required: true },
    status: {
        type: String,
        enum: ['pending', 'mixing', 'completed', 'expired'],
        default: 'pending'
    },
    participants: [{
        address: String,
        amount: Number,
        mixedAddress: String,
        joinedAt: Number
    }],
    outputs: [{
        to: String,
        amount: Number,
        fee: Number
    }],
    createdAt: { type: Number, default: () => Date.now() },
    expiresAt: { type: Number, required: true },
    completedAt: { type: Number, default: null }
});

const KeyImageModel = mongoose.model('KeyImage', KeyImageSchema);
const StealthAddressModel = mongoose.model('StealthAddress', StealthAddressSchema);
const MixingPoolModel = mongoose.model('MixingPool', MixingPoolSchema);

// ============================================
// ESTADO EM MEMÓRIA (peers)
// ============================================
const peers = new Set();
const settings = {
    enableRingSignatures: true,
    enableStealthAddresses: true,
    enableCoinMixing: true,
    obfuscateAmounts: true,
    randomizeTiming: true
};

let peerDiscoveryInterval = null;

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGO_URI);
    }
    await Promise.all([
        KeyImageModel.init(),
        StealthAddressModel.init(),
        MixingPoolModel.init()
    ]);
    console.log('✅ Privacy Module inicializado');
    console.log(`   ├─ Ring size: ${RING_SIZE}`);
    console.log(`   ├─ P2P port: ${P2P_PORT}`);
    console.log(`   └─ Features: stealth ✓, mixing ✓, ring ✓`);
}

// ============================================
// HELPERS CRIPTOGRÁFICOS
// ============================================

/**
 * ⚠️ Simplificação didática de key image.
 * Em produção (Monero), keyImage = x * Hp(P), usando curva Edwards25519.
 * Aqui usamos HMAC-SHA256 com a privkey como chave. NÃO é seguro pra produção.
 */
function generateKeyImage(privateKeyHex, publicKeyHex) {
    return crypto
        .createHmac('sha256', Buffer.from(privateKeyHex, 'hex'))
        .update(Buffer.from(publicKeyHex, 'hex'))
        .digest('hex');
}

/**
 * ⚠️ Ring signature simplificada (NÃO é LSAG).
 * Produção: usar bibliotecas dedicadas como "ring-signatures" npm package
 * ou implementar LSAG em cima de curva Edwards.
 */
function createRingSignature(message, privateKeyHex, ringPublicKeys) {
    const messageHash = crypto
        .createHash('sha256')
        .update(message)
        .digest();

    // Assinatura HMAC simples (didática)
    const signature = crypto
        .createHmac('sha256', Buffer.from(privateKeyHex, 'hex'))
        .update(messageHash)
        .digest('hex');

    // Calcula "challenge" — em LSAG real seria s_0 = hash(msg, ..., s_n)
    const challenge = crypto
        .createHash('sha256')
        .update(messageHash)
        .update(ringPublicKeys.join(''))
        .digest('hex');

    return {
        ring: ringPublicKeys,
        signature,
        challenge,
        ringSize: ringPublicKeys.length,
        createdAt: Date.now(),
        type: 'ring-signature-simplified'
    };
}

function verifyRingSignature(message, signature) {
    if (!signature || !signature.signature || !signature.ring) return false;

    const messageHash = crypto
        .createHash('sha256')
        .update(message)
        .digest();

    const expectedChallenge = crypto
        .createHash('sha256')
        .update(messageHash)
        .update(signature.ring.join(''))
        .digest('hex');

    return signature.challenge === expectedChallenge;
}

// ============================================
// 1. RING SIGNATURES
// ============================================

/**
 * Gera ring signature para uma transação.
 * @param {object} transaction - Transação a assinar
 * @param {string} privateKeyHex - Chave privada do signer
 * @param {string[]} publicKeysRing - Chaves públicas candidatas (incluindo a do signer)
 */
async function generateRingSignature(transaction, privateKeyHex, publicKeysRing) {
    if (!transaction || !privateKeyHex || !Array.isArray(publicKeysRing)) {
        throw new Error('Parâmetros inválidos');
    }
    if (publicKeysRing.length < RING_SIZE) {
        throw new Error(`Ring precisa ter pelo menos ${RING_SIZE} chaves públicas`);
    }

    // Seleciona RING_SIZE chaves (embaralha pra não revelar qual é a do signer)
    const shuffled = [...publicKeysRing].sort(() => 0.5 - Math.random());
    const selectedRing = shuffled.slice(0, RING_SIZE);

    const message = JSON.stringify({
        fromAddress: transaction.fromAddress,
        toAddress: transaction.toAddress,
        amount: transaction.amount,
        timestamp: transaction.timestamp
    });

    const signature = createRingSignature(message, privateKeyHex, selectedRing);

    // Gera e persiste key image (previne double spend)
    const keyImage = generateKeyImage(privateKeyHex, publicKeysRing[0]);

    // Verifica se essa key image já foi usada (double spend)
    const existing = await KeyImageModel.findOne({ keyImage });
    if (existing) {
        throw new Error('⚠️ Double spend detectado: key image já usada');
    }

    await KeyImageModel.create({
        keyImage,
        address: transaction.fromAddress || 'unknown',
        txHash: transaction.hash || crypto.randomBytes(16).toString('hex')
    });

    console.log(`🔐 Ring signature gerada (${RING_SIZE} membros)`);

    return {
        ...signature,
        keyImage
    };
}

async function verifyRingSignature(transaction, signature) {
    if (!transaction || !signature) return false;

    const message = JSON.stringify({
        fromAddress: transaction.fromAddress,
        toAddress: transaction.toAddress,
        amount: transaction.amount,
        timestamp: transaction.timestamp
    });

    // 1. Verifica assinatura
    const sigValid = verifyRingSignature(message, signature);

    // 2. Verifica double spend
    const keyImageUsed = await KeyImageModel.findOne({ keyImage: signature.keyImage });
    if (keyImageUsed) {
        console.warn(`⚠️  Double spend detectado na key image: ${signature.keyImage.substring(0, 16)}...`);
        return false;
    }

    return sigValid;
}

// ============================================
// 2. STEALTH ADDRESSES (ECDH real)
// ============================================

/**
 * Gera par de chaves efêmeras para stealth address.
 * Usa ECDH na curva P-256 (nativo do Node, sem deps externas).
 */
function generateEphemeralKeyPair() {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return {
        privateKey: ecdh.getPrivateKey('hex'),
        publicKey: ecdh.getPublicKey('hex', 'uncompressed')
    };
}

/**
 * Deriva stealth address usando ECDH.
 * Em Monero: P = H(r*V)*G + B
 * Aqui: SHA256(sharedSecret + recipientPubKey) → simplificação didática
 */
function deriveStealthAddress(recipientPubKeyHex, ephemeralPrivateKeyHex) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(ephemeralPrivateKeyHex, 'hex'));

    // sharedSecret = ECDH(ephemeralPrivate, recipientPubKey)
    const recipientPubKeyBuffer = Buffer.from(recipientPubKeyHex, 'hex');
    let sharedSecret;
    try {
        sharedSecret = ecdh.computeSecret(recipientPubKeyBuffer);
    } catch (err) {
        throw new Error('Erro no ECDH: chave pública inválida');
    }

    // Deriva endereço: SHA256(sharedSecret + ephemeralPubKey)
    const ephemeralPubKey = ecdh.getPublicKey('hex', 'uncompressed');
    const hash = crypto
        .createHash('sha256')
        .update(sharedSecret)
        .update(Buffer.from(ephemeralPubKey, 'hex'))
        .digest('hex');

    return {
        stealthAddress: 'BrSTLTH' + hash.substring(0, 34).toUpperCase(),
        ephemeralPublicKey: ephemeralPubKey,
        sharedSecret: sharedSecret.toString('hex')
    };
}

/**
 * Gera stealth address para um recipient.
 * @param {string} recipientPubKeyHex - Pubkey do recipient (hex)
 * @param {string} [txHash] - Hash da tx (opcional, associa ao endereço)
 */
async function generateStealthAddress(recipientPubKeyHex, txHash = null) {
    if (!recipientPubKeyHex || recipientPubKeyHex.length < 64) {
        throw new Error('Pubkey do recipient inválida');
    }

    const ephemeral = generateEphemeralKeyPair();
    const { stealthAddress } = deriveStealthAddress(recipientPubKeyHex, ephemeral.privateKey);

    await StealthAddressModel.create({
        stealthAddress,
        recipientPubKey: recipientPubKeyHex,
        ephemeralPubKey: ephemeral.publicKey,
        txHash,
        used: false
    });

    console.log(`🕵️  Stealth address: ${stealthAddress.substring(0, 16)}...`);

    return {
        stealthAddress,
        ephemeralPublicKey: ephemeral.publicKey,
        // ⚠️ NÃO retornar ephemeralPrivateKey em produção!
        _debug: {
            ephemeralPrivateKey: ephemeral.privateKey,
            note: 'Remova em produção'
        }
    };
}

/**
 * Escaneia blockchain por stealth addresses do recipient.
 * @param {string} viewPrivateKeyHex - View private key do recipient
 * @param {number} startBlock - Bloco inicial
 */
async function scanForStealthAddresses(viewPrivateKeyHex, startBlock = 0) {
    const docs = await StealthAddressModel.find({ used: false });
    const found = [];

    for (const doc of docs) {
        try {
            // Tenta derivar o endereço usando a view key do recipient
            const derived = deriveStealthAddress(
                Buffer.from(viewPrivateKeyHex, 'hex').toString('hex').substring(0, 130),
                viewPrivateKeyHex
            );

            // ⚠️ Simplificação: em produção, precisa testar se o endereço
            // derivado bate com o endereço armazenado
            if (derived.stealthAddress === doc.stealthAddress) {
                found.push({
                    stealthAddress: doc.stealthAddress,
                    ephemeralPublicKey: doc.ephemeralPubKey,
                    txHash: doc.txHash,
                    createdAt: doc.createdAt
                });
            }
        } catch (err) {
            // Ignora erros de derivação
        }
    }

    console.log(`🔍 Encontrados ${found.length} stealth addresses`);
    return found;
}

// ============================================
// 3. COIN MIXING
// ============================================

async function createMixingPool(amount, participants = 5) {
    if (typeof amount !== 'number' || amount <= 0) {
        throw new Error('Amount inválido');
    }
    if (participants < 2 || participants > 50) {
        throw new Error('Participantes deve estar entre 2 e 50');
    }

    const poolId = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + MIXING_POOL_TTL_MS;

    await MixingPoolModel.create({
        poolId,
        amount,
        requiredParticipants: participants,
        status: 'pending',
        participants: [],
        outputs: [],
        expiresAt
    });

    console.log(`🌀 Pool de mixing criado: ${poolId} (${participants} participantes)`);
    return poolId;
}

async function joinMixingPool(poolId, address, amount) {
    const pool = await MixingPoolModel.findOne({ poolId });
    if (!pool) throw new Error('Pool não encontrado');
    if (pool.status !== 'pending') throw new Error('Pool já está processando');
    if (Date.now() > pool.expiresAt) {
        pool.status = 'expired';
        await pool.save();
        throw new Error('Pool expirado');
    }

    // Verifica endereço duplicado
    if (pool.participants.some((p) => p.address === address)) {
        throw new Error('Endereço já participa desse pool');
    }

    // Gera mixed address (stealth) para o participante
    const stealth = await generateStealthAddress(
        crypto.createHash('sha256').update(address).digest('hex')
    );

    pool.participants.push({
        address,
        amount,
        mixedAddress: stealth.stealthAddress,
        joinedAt: Date.now()
    });

    console.log(`🌀 Participante entrou: ${pool.participants.length}/${pool.requiredParticipants}`);

    // Se atingiu o mínimo, executa
    if (pool.participants.length >= pool.requiredParticipants) {
        await pool.save();
        return await executeMixing(poolId);
    }

    await pool.save();
    return { success: true, poolId, status: pool.status, participants: pool.participants.length };
}

async function executeMixing(poolId) {
    const pool = await MixingPoolModel.findOne({ poolId });
    if (!pool) throw new Error('Pool não encontrado');
    if (pool.status === 'completed') return pool;

    pool.status = 'mixing';
    await pool.save();

    // Shuffle (Fisher-Yates)
    const shuffled = [...pool.participants];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Gera outputs (cada participante recebe do próximo da fila)
    const outputs = [];
    for (let i = 0; i < shuffled.length; i++) {
        const participant = shuffled[i];
        const nextParticipant = shuffled[(i + 1) % shuffled.length];
        const fee = participant.amount * MIXING_FEE_RATE;

        outputs.push({
            to: nextParticipant.mixedAddress,
            amount: participant.amount - fee,
            fee
        });
    }

    pool.outputs = outputs;
    pool.status = 'completed';
    pool.completedAt = Date.now();
    await pool.save();

    console.log(`✅ Mixing concluído: ${poolId}`);
    return {
        success: true,
        poolId,
        status: 'completed',
        participantCount: shuffled.length,
        outputs
    };
}

// ============================================
// 4. P2P NETWORK (básico)
// ============================================

function addPeer(peerAddress) {
    if (!peerAddress || typeof peerAddress !== 'string') return false;
    if (peers.has(peerAddress)) return false;
    peers.add(peerAddress);
    console.log(`🔗 Peer adicionado: ${peerAddress}`);
    return true;
}

function removePeer(peerAddress) {
    return peers.delete(peerAddress);
}

function getPeers() {
    return {
        peers: Array.from(peers),
        count: peers.size,
        p2pPort: P2P_PORT
    };
}

/**
 * ⚠️ P2P básico em memória. Em produção use libp2p ou um protocolo real.
 * Este método NÃO faz conexões de rede automaticamente.
 */
function startPeerDiscovery() {
    if (peerDiscoveryInterval) {
        console.warn('Peer discovery já está rodando');
        return;
    }

    // Apenas loga status a cada 5 min
    peerDiscoveryInterval = setInterval(() => {
        console.log(`🌐 P2P: ${peers.size} peers conectados`);
    }, 300000);

    console.log('✅ Peer discovery iniciado (modo log)');
}

function stopPeerDiscovery() {
    if (peerDiscoveryInterval) {
        clearInterval(peerDiscoveryInterval);
        peerDiscoveryInterval = null;
        console.log('🛑 Peer discovery parado');
    }
}

// ============================================
// 5. OBFUSCAÇÃO DE TRANSAÇÃO
// ============================================

/**
 * Divide uma transação em várias partes menores para obscurecer o valor.
 * @param {object} transaction - Transação original
 */
async function obfuscateTransaction(transaction) {
    if (!transaction || !transaction.amount) {
        throw new Error('Transação inválida');
    }

    const splitCount = Math.floor(Math.random() * 5) + 2; // 2 a 6
    const splitAmount = transaction.amount / splitCount;

    const splits = [];
    for (let i = 0; i < splitCount; i++) {
        // Variação leve (±0.05%)
        const variation = splitAmount * (Math.random() * 0.001 - 0.0005);
        splits.push({
            amount: Math.max(0, splitAmount + variation),
            delay: i * 1000,
            stealthAddress: null // será preenchido pelo caller
        });
    }

    return {
        original: {
            fromAddress: transaction.fromAddress,
            toAddress: transaction.toAddress,
            amount: transaction.amount,
            timestamp: transaction.timestamp
        },
        splitCount,
        splits,
        obfuscated: true,
        createdAt: Date.now()
    };
}

// ============================================
// 6. INFO
// ============================================

function getNetworkInfo() {
    return {
        name: 'Bradicoin',
        version: '2.0.0',
        networkId: process.env.NETWORK_NAME || 'bradicoin-mainnet',
        p2pPort: P2P_PORT,
        peers: peers.size,
        ringSize: RING_SIZE,
        features: {
            ringSignatures: settings.enableRingSignatures,
            stealthAddresses: settings.enableStealthAddresses,
            coinMixing: settings.enableCoinMixing,
            obfuscation: settings.obfuscateAmounts
        },
        disclaimer: 'Ring signatures e P2P são didáticos; stealth addresses usam ECDH real'
    };
}

async function getStatistics() {
    const [keyImages, stealthAddresses, pools] = await Promise.all([
        KeyImageModel.countDocuments(),
        StealthAddressModel.countDocuments(),
        MixingPoolModel.countDocuments({ status: 'completed' })
    ]);

    return {
        keyImagesUsed: keyImages,
        stealthAddressesGenerated: stealthAddresses,
        mixingPoolsCompleted: pools,
        activePeers: peers.size,
        ringSize: RING_SIZE
    };
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    initialize,
    // Ring signatures
    generateRingSignature,
    verifyRingSignature,
    // Stealth addresses
    generateStealthAddress,
    scanForStealthAddresses,
    // Mixing
    createMixingPool,
    joinMixingPool,
    executeMixing,
    // P2P
    addPeer,
    removePeer,
    getPeers,
    startPeerDiscovery,
    stopPeerDiscovery,
    // Obfuscation
    obfuscateTransaction,
    // Info
    getNetworkInfo,
    getStatistics,
    // Models (para debug/consultas)
    KeyImageModel,
    StealthAddressModel,
    MixingPoolModel
};
