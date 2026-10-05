// atomic-swap/negotiation/orderMessage.js
// ============================================
// OrderMessage — Formato de mensagens P2P
// ============================================
// Define os tipos de mensagem trocadas entre peers:
//   - ORDER_ANNOUNCE  → maker publica ordem
//   - ORDER_CANCEL    → maker cancela ordem
//   - ORDER_REQUEST   → taker busca ordens de um par
//   - ORDER_RESPONSE  → resposta com lista de ordens
//   - TRADE_PROPOSE   → taker quer aceitar ordem
//   - TRADE_ACCEPT    → maker aceita
//   - TRADE_REJECT    → maker recusa
// ============================================

const crypto = require('crypto');
const { sha256 } = require('@noble/hashes/sha2');
const { bytesToHex, utf8ToBytes, hexToBytes } = require('@noble/hashes/utils');

const MESSAGE_TYPES = {
    ORDER_ANNOUNCE: 'order:announce',
    ORDER_CANCEL: 'order:cancel',
    ORDER_REQUEST: 'order:request',
    ORDER_RESPONSE: 'order:response',
    TRADE_PROPOSE: 'trade:propose',
    TRADE_ACCEPT: 'trade:accept',
    TRADE_REJECT: 'trade:reject',
    PEER_PING: 'peer:ping',
    PEER_PONG: 'peer:pong'
};

const PROTOCOL_VERSION = '1.0';

// ============================================
// CRIAR MENSAGEM
// ============================================
function createMessage(type, payload, opts = {}) {
    if (!type || typeof type !== 'string') {
        throw new Error('type obrigatório');
    }

    const message = {
        version: PROTOCOL_VERSION,
        type,
        payload,
        timestamp: Date.now(),
        nonce: crypto.randomBytes(8).toString('hex'),
        sender: opts.sender || null,   // peerId ou endereço
        ttl: opts.ttl || 5             // hops máximos
    };

    // Assina se tiver chave privada
    if (opts.privateKey) {
        message.signature = signMessage(message, opts.privateKey);
        message.publicKey = opts.publicKey;
    }

    message.id = computeMessageId(message);
    return message;
}

// ============================================
// HASH DA MENSAGEM (ID único)
// ============================================
function computeMessageId(message) {
    const payload = JSON.stringify({
        version: message.version,
        type: message.type,
        payload: message.payload,
        timestamp: message.timestamp,
        nonce: message.nonce,
        sender: message.sender
    });
    return bytesToHex(sha256(utf8ToBytes(payload)));
}

// ============================================
// ASSINATURA
// ============================================
function signMessage(message, privateKeyHex) {
    const secp256k1 = require('@noble/secp256k1');
    const signable = buildSignableMessage(message);
    const hash = sha256(utf8ToBytes(signable));
    const sig = secp256k1.sign(hash, privateKeyHex);
    return sig.toCompactHex ? sig.toCompactHex() : sig.toString('hex');
}

function verifyMessageSignature(message) {
    if (!message.signature || !message.publicKey) return false;

    try {
        const secp256k1 = require('@noble/secp256k1');
        const signable = buildSignableMessage(message);
        const hash = sha256(utf8ToBytes(signable));
        const sigBytes = hexToBytes(message.signature);
        return secp256k1.verify(sigBytes, hash, message.publicKey);
    } catch (_) {
        return false;
    }
}

function buildSignableMessage(message) {
    return [
        message.version,
        message.type,
        JSON.stringify(message.payload),
        message.timestamp.toString(),
        message.nonce,
        message.sender || ''
    ].join('|');
}

// ============================================
// VALIDAÇÃO
// ============================================
function validateMessage(message) {
    if (!message || typeof message !== 'object') {
        return { ok: false, reason: 'mensagem inválida' };
    }
    if (message.version !== PROTOCOL_VERSION) {
        return { ok: false, reason: `versão incompatível: ${message.version}` };
    }
    if (!Object.values(MESSAGE_TYPES).includes(message.type)) {
        return { ok: false, reason: `tipo desconhecido: ${message.type}` };
    }
    if (!message.payload || typeof message.payload !== 'object') {
        return { ok: false, reason: 'payload inválido' };
    }
    if (!Number.isFinite(message.timestamp)) {
        return { ok: false, reason: 'timestamp inválido' };
    }
    // TTL muito antigo (mais de 5 min)
    if (Date.now() - message.timestamp > 5 * 60 * 1000) {
        return { ok: false, reason: 'mensagem muito antiga' };
    }
    // TTL esgotado
    if (message.ttl <= 0) {
        return { ok: false, reason: 'TTL esgotado' };
    }

    // Se tem assinatura, valida
    if (message.signature) {
        if (!verifyMessageSignature(message)) {
            return { ok: false, reason: 'assinatura inválida' };
        }
    }

    return { ok: true };
}

// ============================================
// HELPERS
// ============================================
function decrementTtl(message) {
    return { ...message, ttl: Math.max(0, message.ttl - 1) };
}

function serializeMessage(message) {
    return JSON.stringify(message);
}

function deserializeMessage(raw) {
    try {
        if (typeof raw === 'string') return JSON.parse(raw);
        if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf8'));
        return raw;
    } catch (_) {
        return null;
    }
}

// ============================================
// BUILDERS
// ============================================
function buildOrderAnnounce(order, opts = {}) {
    return createMessage(MESSAGE_TYPES.ORDER_ANNOUNCE, {
        swapId: order.swapId,
        maker: order.maker,
        taker: order.taker,
        fromChain: order.fromChain,
        toChain: order.toChain,
        fromToken: order.fromToken,
        toToken: order.toToken,
        rate: order.rate,
        hashlock: order.hashlock,
        timelockMaker: order.timelockMaker,
        timelockTaker: order.timelockTaker,
        expiresAt: order.expiresAt
    }, opts);
}

function buildOrderCancel(swapId, makerAddress, opts = {}) {
    return createMessage(MESSAGE_TYPES.ORDER_CANCEL, {
        swapId,
        makerAddress,
        cancelledAt: Date.now()
    }, opts);
}

function buildOrderRequest({ fromChain, toChain, fromToken, toToken, maxResults = 20 }, opts = {}) {
    return createMessage(MESSAGE_TYPES.ORDER_REQUEST, {
        fromChain,
        toChain,
        fromToken,
        toToken,
        maxResults
    }, opts);
}

function buildOrderResponse(orders, opts = {}) {
    return createMessage(MESSAGE_TYPES.ORDER_RESPONSE, {
        orders,
        count: orders.length
    }, opts);
}

function buildTradePropose({ swapId, takerAddress, takerPeerId }, opts = {}) {
    return createMessage(MESSAGE_TYPES.TRADE_PROPOSE, {
        swapId,
        takerAddress,
        takerPeerId,
        proposedAt: Date.now()
    }, opts);
}

function buildTradeAccept({ swapId, makerAddress }, opts = {}) {
    return createMessage(MESSAGE_TYPES.TRADE_ACCEPT, {
        swapId,
        makerAddress,
        acceptedAt: Date.now()
    }, opts);
}

function buildTradeReject({ swapId, reason }, opts = {}) {
    return createMessage(MESSAGE_TYPES.TRADE_REJECT, {
        swapId,
        reason,
        rejectedAt: Date.now()
    }, opts);
}

module.exports = {
    MESSAGE_TYPES,
    PROTOCOL_VERSION,
    createMessage,
    computeMessageId,
    signMessage,
    verifyMessageSignature,
    validateMessage,
    decrementTtl,
    serializeMessage,
    deserializeMessage,
    buildOrderAnnounce,
    buildOrderCancel,
    buildOrderRequest,
    buildOrderResponse,
    buildTradePropose,
    buildTradeAccept,
    buildTradeReject
};
