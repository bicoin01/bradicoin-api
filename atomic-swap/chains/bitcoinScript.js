// atomic-swap/chains/bitcoinScript.js
// ============================================
// Bitcoin HTLC Script Builder
// ============================================
// Constrói o script P2WSH do HTLC:
//
//   OP_IF
//     OP_SHA256 <hashlock> OP_EQUALVERIFY
//     <receiverPubKey> OP_CHECKSIG
//   OP_ELSE
//     <timelock> OP_CHECKLOCKTIMEVERIFY OP_DROP
//     <senderPubKey> OP_CHECKSIG
//   OP_ENDIF
//
// Fluxo:
//   - Receiver gasta com preimage + assinatura
//   - Sender gasta após timelock
// ============================================

const bitcoin = require('bitcoinjs-lib');
const { getNetwork } = require('./bitcoinWallet');

// ============================================
// BUILD HTLC SCRIPT
// ============================================
/**
 * @param {Object} opts
 * @param {string} opts.hashlock         - sha256 hex (32 bytes)
 * @param {string} opts.receiverPubKey   - pubkey hex comprimida (33 bytes)
 * @param {string} opts.senderPubKey     - pubkey hex comprimida (33 bytes)
 * @param {number} opts.timelock         - unix timestamp em segundos
 * @returns {Buffer} script
 */
function buildHtlcScript({ hashlock, receiverPubKey, senderPubKey, timelock }) {
    if (!hashlock || !/^[a-fA-F0-9]{64}$/.test(hashlock)) {
        throw new Error('hashlock inválido');
    }
    if (!receiverPubKey || !/^[a-fA-F0-9]{66}$/.test(receiverPubKey)) {
        throw new Error('receiverPubKey inválida');
    }
    if (!senderPubKey || !/^[a-fA-F0-9]{66}$/.test(senderPubKey)) {
        throw new Error('senderPubKey inválida');
    }
    if (!Number.isInteger(timelock) || timelock <= 0) {
        throw new Error('timelock inválido');
    }

    const hashlockBuf = Buffer.from(hashlock, 'hex');
    const receiverPubKeyBuf = Buffer.from(receiverPubKey, 'hex');
    const senderPubKeyBuf = Buffer.from(senderPubKey, 'hex');

    const script = bitcoin.script.compile([
        bitcoin.opcodes.OP_IF,
            bitcoin.opcodes.OP_SHA256,
            hashlockBuf,
            bitcoin.opcodes.OP_EQUALVERIFY,
            receiverPubKeyBuf,
            bitcoin.opcodes.OP_CHECKSIG,
        bitcoin.opcodes.OP_ELSE,
            bitcoin.script.number.encode(timelock),
            bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
            bitcoin.opcodes.OP_DROP,
            senderPubKeyBuf,
            bitcoin.opcodes.OP_CHECKSIG,
        bitcoin.opcodes.OP_ENDIF
    ]);

    return script;
}

// ============================================
// BUILD P2WSH ADDRESS
// ============================================
function buildP2WSH(hashlock, receiverPubKey, senderPubKey, timelock, network = 'testnet') {
    const script = buildHtlcScript({ hashlock, receiverPubKey, senderPubKey, timelock });
    const net = getNetwork(network);

    const p2wsh = bitcoin.payments.p2wsh({
        redeem: { output: script, network: net },
        network: net
    });

    return {
        script,
        address: p2wsh.address,
        output: p2wsh.output,
        hash: p2wsh.hash,
        witness: p2wsh.redeem.output
    };
}

// ============================================
// SPEND — CLAIM (com preimage)
// ============================================
/**
 * Constrói witness para gastar HTLC via claim (receiver)
 *
 * @param {Object} opts
 * @param {string} opts.preimage         - hex
 * @param {Buffer} opts.script           - HTLC script
 * @param {Object} opts.keyPair          - ECPair do receiver
 * @returns {Buffer[]} witness stack
 */
function buildClaimWitness({ preimage, script, keyPair }) {
    const preimageBuf = Buffer.from(preimage, 'hex');

    // ⚠️ Estrutura da witness:
    //   [ signature, preimage, OP_TRUE/1, script ]
    // No bitcoinjs-lib, a assinatura é gerada no PSBT depois.
    // Aqui só montamos o "stack" parcial.

    return {
        preimageBuf,
        script,
        keyPair,
        // A assinatura é preenchida pelo PSBT no momento do signing
        witness: null
    };
}

// ============================================
// SPEND — REFUND (após timelock)
// ============================================
function buildRefundWitness({ script, keyPair }) {
    return {
        script,
        keyPair,
        // Estrutura: [ signature, OP_FALSE/0, script ]
        witness: null
    };
}

// ============================================
// HELPERS DE SCRIPT
// ============================================
function scriptToHex(script) {
    return script.toString('hex');
}

function hexToScript(hex) {
    return Buffer.from(hex, 'hex');
}

// ============================================
// ASM — pra debug
// ============================================
function scriptToAsm(script) {
    return bitcoin.script.toASM(script);
}

module.exports = {
    buildHtlcScript,
    buildP2WSH,
    buildClaimWitness,
    buildRefundWitness,
    scriptToHex,
    hexToScript,
    scriptToAsm
};
