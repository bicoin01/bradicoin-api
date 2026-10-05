// atomic-swap/chains/bitcoinWallet.js
// ============================================
// Bitcoin Wallet HD — Deriva endereços e assina txs
// ============================================
// Suporta:
//   - BIP32 (HD wallet)
//   - BIP84 (native segwit bc1q / tb1q)
//   - BIP39 (mnemonic) — opcional
// ============================================

const bitcoin = require('bitcoinjs-lib');
const ECPair = require('ecpair').default;
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const crypto = require('crypto');

const bip32 = BIP32Factory(ecc);

// ⚠️ Precisamos registrar ecc no bitcoinjs-lib v6+
bitcoin.initEccLib(ecc);

// ============================================
// NETWORKS
// ============================================
const NETWORKS = {
    mainnet: bitcoin.networks.bitcoin,
    testnet: bitcoin.networks.testnet,
    signet: bitcoin.networks.testnet,   // signet usa mesmo prefixo de testnet
    regtest: bitcoin.networks.regtest
};

function getNetwork(name) {
    return NETWORKS[name] || bitcoin.networks.testnet;
}

// ============================================
// WALLET HD
// ============================================
class BitcoinWallet {
    /**
     * @param {Object} opts
     * @param {string} opts.seedHex        - 32 bytes hex (master seed)
     * @param {string} opts.network        - 'mainnet' | 'testnet' | 'signet' | 'regtest'
     * @param {string} [opts.derivationPath] - default: m/84'/1'/0'/0/0 (BIP84 testnet)
     */
    constructor({ seedHex, network = 'testnet', derivationPath }) {
        if (!seedHex || !/^[a-fA-F0-9]{64}$/.test(seedHex)) {
            throw new Error('seedHex deve ser 32 bytes em hex (64 chars)');
        }

        this.networkName = network;
        this.network = getNetwork(network);
        this.seed = Buffer.from(seedHex, 'hex');

        // Default path: BIP84
        // mainnet: m/84'/0'/0'/0/0
        // testnet: m/84'/1'/0'/0/0
        const coinType = network === 'mainnet' ? 0 : 1;
        this.derivationPath = derivationPath || `m/84'/${coinType}'/0'/0/0`;

        this.root = bip32.fromSeed(this.seed, this.network);
        this._cache = new Map();  // cache de chaves derivadas
    }

    /**
     * Deriva uma chave filha a partir de um índice
     * @param {number} index - índice do endereço (0, 1, 2, ...)
     * @returns {{ address, publicKey, privateKey, path, keyPair }}
     */
    deriveKey(index = 0) {
        if (this._cache.has(index)) return this._cache.get(index);

        const coinType = this.networkName === 'mainnet' ? 0 : 1;
        const path = `m/84'/${coinType}'/0'/0/${index}`;
        const child = this.root.derivePath(path);

        const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: this.network });

        // BIP84 → native segwit (bech32)
        const { address } = bitcoin.payments.p2wpkh({
            pubkey: Buffer.from(child.publicKey),
            network: this.network
        });

        const result = {
            index,
            path,
            address,
            publicKey: Buffer.from(child.publicKey).toString('hex'),
            privateKey: Buffer.from(child.privateKey).toString('hex'),
            keyPair
        };

        this._cache.set(index, result);
        return result;
    }

    /**
     * Deriva chave do endereço de swap principal
     */
    getSwapKey() {
        return this.deriveKey(0);
    }

    /**
     * Deriva keyPair a partir de WIF (import key)
     */
    static fromWIF(wif, network = 'testnet') {
        const keyPair = ECPair.fromWIF(wif, getNetwork(network));
        return keyPair;
    }

    /**
     * Retorna endereço P2WPKH (bech32) de uma pubkey
     */
    static p2wpkhAddress(pubkeyBuffer, network = 'testnet') {
        const { address } = bitcoin.payments.p2wpkh({
            pubkey: pubkeyBuffer,
            network: getNetwork(network)
        });
        return address;
    }

    /**
     * Retorna endereço P2WSH (bech32, script) — usado pra HTLC
     */
    static p2wshAddress(script, network = 'testnet') {
        const { address } = bitcoin.payments.p2wsh({
            redeem: { output: script, network: getNetwork(network) },
            network: getNetwork(network)
        });
        return address;
    }
}

module.exports = {
    BitcoinWallet,
    NETWORKS,
    getNetwork
};
