// atomic-swap/chains/bitcoinAdapter.js
// ============================================
// Bitcoin Adapter REAL — HTLC na testnet/mainnet
// ============================================
// Suporta: BTC, LTC, BCH, DOGE, DASH, ZEC (Bitcoin-like)
// ============================================

const BaseAdapter = require('./baseAdapter');
const bitcoin = require('bitcoinjs-lib');
const ECPair = require('ecpair').default;
const ecc = require('tiny-secp256k1');
const { Psbt } = require('bitcoinjs-lib');

const { BitcoinWallet, getNetwork } = require('./bitcoinWallet');
const bitcoinScript = require('./bitcoinScript');
const BitcoinClient = require('./bitcoinClient');

bitcoin.initEccLib(ecc);

// ============================================
// CONFIG POR CHAIN
// ============================================
const CHAIN_CONFIGS = {
    bitcoin: {
        name: 'Bitcoin', symbol: 'BTC',
        api: {
            mainnet: 'https://mempool.space/api',
            testnet: 'https://mempool.space/testnet/api',
            signet: 'https://mempool.space/signet/api'
        },
        confirmations: 6,
        blockTime: 600,
        addressPrefix: { mainnet: 'bc1', testnet: 'tb1', signet: 'tb1' },
        envKey: 'BITCOIN'
    },
    litecoin: {
        name: 'Litecoin', symbol: 'LTC',
        api: {
            mainnet: 'https://litecoinspace.org/api',
            testnet: 'https://litecoinspace.org/testnet/api'
        },
        confirmations: 6,
        blockTime: 150,
        addressPrefix: { mainnet: 'ltc1', testnet: 'tltc1' },
        envKey: 'LITECOIN'
    },
    bitcoinCash: {
        name: 'Bitcoin Cash', symbol: 'BCH',
        api: { mainnet: 'https://bch-chain.api.btc.com' },
        confirmations: 6,
        blockTime: 600,
        addressPrefix: { mainnet: 'bitcoincash:' },
        envKey: 'BITCOINCASH'
    },
    dogecoin: {
        name: 'Dogecoin', symbol: 'DOGE',
        api: { mainnet: 'https://dogechain.info/api/v1' },
        confirmations: 6,
        blockTime: 60,
        addressPrefix: { mainnet: 'D' },
        envKey: 'DOGECOIN'
    },
    dash: {
        name: 'Dash', symbol: 'DASH',
        api: { mainnet: 'https://api.blockcypher.com/v1/dash/main' },
        confirmations: 6,
        blockTime: 150,
        addressPrefix: { mainnet: 'X' },
        envKey: 'DASH'
    },
    zcash: {
        name: 'Zcash', symbol: 'ZEC',
        api: { mainnet: 'https://api.blockchair.com/zcash' },
        confirmations: 6,
        blockTime: 75,
        addressPrefix: { mainnet: 't1' },
        envKey: 'ZCASH'
    }
};

// ============================================
// ADAPTER
// ============================================
class BitcoinLikeAdapter extends BaseAdapter {
    constructor(chainKey) {
        const cfg = CHAIN_CONFIGS[chainKey];
        if (!cfg) throw new Error(`Chain ${chainKey} não suportada`);

        const network = process.env[`${cfg.envKey}_NETWORK`] || 'testnet';

        super({
            name: cfg.name,
            symbol: cfg.symbol,
            confirmations: parseInt(process.env[`${cfg.envKey}_MIN_CONFIRMATIONS`]) || cfg.confirmations,
            blockTime: cfg.blockTime,
            enabled: true
        });

        this.chainKey = chainKey;
        this.cfg = cfg;
        this.networkName = network;
        this.network = getNetwork(network);

        // API URL
        const apiUrl = process.env[`${cfg.envKey}_API_URL`]
            || cfg.api[network]
            || cfg.api.mainnet;
        this.client = new BitcoinClient({ apiUrl, network });

        // Wallet HD
        const seed = process.env[`${cfg.envKey}_MASTER_SEED`];
        if (seed && /^[a-fA-F0-9]{64}$/.test(seed)) {
            this.wallet = new BitcoinWallet({
                seedHex: seed,
                network,
                derivationPath: process.env[`${cfg.envKey}_HD_PATH`]
            });
        } else {
            this.wallet = null;
            console.warn(`⚠️  ${this.name}: MASTER_SEED não configurada — operações de assinatura vão falhar`);
        }

        // Cache de HTLCs em memória (⚠️ em prod usar Mongo)
        this.htlcCache = new Map();
    }

    // ============================================
    // HELPERS
    // ============================================
    _getFeeRate() {
        return parseInt(process.env[`${this.cfg.envKey}_DEFAULT_FEE_RATE`]) || 2;
    }

    _requireWallet() {
        if (!this.wallet) {
            throw new Error(`${this.name}: MASTER_SEED não configurada`);
        }
        return this.wallet;
    }

    // ============================================
    // LOCK HTLC — Cria e transmite tx P2WSH
    // ============================================
    async lockHtlc({ sender, receiver, amount, hashlock, timelock, swapId }) {
        const wallet = this._requireWallet();

        // 1. Deriva chave do sender (nosso lado)
        const senderKey = wallet.getSwapKey();
        const senderAddress = senderKey.address;

        // 2. Receiver: derivamos deterministicamente a partir da pubkey se dada,
        //    caso contrário usamos um índice fixo (⚠️ em prod: trocar pubkey real)
        let receiverPubKey;
        if (/^[a-fA-F0-9]{66}$/.test(receiver)) {
            receiverPubKey = receiver;
        } else {
            // Receiver é um endereço — usa key derivada do receiver
            // ⚠️ Idealmente o taker manda sua PUBKEY antes
            const receiverKey = wallet.deriveKey(1);
            receiverPubKey = receiverKey.publicKey;
        }

        const senderPubKey = senderKey.publicKey;

        // 3. Constrói P2WSH
        const p2wsh = bitcoinScript.buildP2WSH(
            hashlock,
            receiverPubKey,
            senderPubKey,
            timelock,
            this.networkName
        );

        // 4. Valor em satoshis
        const valueSat = Math.floor(parseFloat(amount) * 1e8);

        // 5. Busca UTXOs do sender
        const utxos = await this.client.getUtxos(senderAddress);
        if (!utxos.length) {
            throw new Error(`Sem UTXOs em ${senderAddress} — fundeie via faucet`);
        }

        // 6. Fee
        const feeRate = this._getFeeRate();
        const estimatedSize = 200;  // P2WSH HTLC ~200 vbytes
        const fee = feeRate * estimatedSize;

        // 7. Seleciona UTXOs suficientes
        const selected = [];
        let total = 0;
        for (const u of utxos) {
            selected.push(u);
            total += u.value;
            if (total >= valueSat + fee) break;
        }
        if (total < valueSat + fee) {
            throw new Error(`Saldo insuficiente: ${total} sat (precisa ${valueSat + fee})`);
        }

        // 8. Constrói PSBT
        const psbt = new Psbt({ network: this.network });

        for (const u of selected) {
            psbt.addInput({
                hash: u.txid,
                index: u.vout,
                witnessUtxo: {
                    script: bitcoin.payments.p2wpkh({
                        pubkey: Buffer.from(senderKey.publicKey, 'hex'),
                        network: this.network
                    }).output,
                    value: u.value
                }
            });
        }

        // Output HTLC
        psbt.addOutput({
            address: p2wsh.address,
            value: valueSat
        });

        // Troco
        const change = total - valueSat - fee;
        if (change > 546) {
            psbt.addOutput({
                address: senderAddress,
                value: change
            });
        }

        // 9. Assina
        for (let i = 0; i < selected.length; i++) {
            psbt.signInput(i, senderKey.keyPair);
        }

        psbt.finalizeAllInputs();

        // 10. Extrai e transmite
        const tx = psbt.extractTransaction();
        const txHex = tx.toHex();
        const txid = tx.getId();

        console.log(`📡 ${this.name} broadcast: ${txid} (${valueSat} sat → ${p2wsh.address})`);
        const broadcastedTxid = await this.client.broadcastTx(txHex);

        // 11. Guarda no cache
        const htlcId = `btc_htlc_${txid}`;
        this.htlcCache.set(htlcId, {
            htlcId,
            chain: this.chainKey,
            address: p2wsh.address,
            script: p2wsh.script.toString('hex'),
            hashlock,
            receiverPubKey,
            senderPubKey,
            timelock,
            valueSat,
            txid: broadcastedTxid,
            status: 'locked',
            createdAt: new Date()
        });

        return {
            htlcId,
            txHash: broadcastedTxid,
            address: p2wsh.address,
            hashlock,
            timelock,
            valueSat
        };
    }

    // ============================================
    // CLAIM HTLC — Gasta com preimage
    // ============================================
    async claimHtlc({ htlcId, preimage, claimer }) {
        const wallet = this._requireWallet();
        const htlc = this.htlcCache.get(htlcId);
        if (!htlc) throw new Error(`HTLC ${htlcId} não encontrado no cache`);
        if (htlc.status !== 'locked') throw new Error(`HTLC não está locked (${htlc.status})`);

        // Busca o UTXO do HTLC
        const utxos = await this.client.getUtxos(htlc.address);
        if (!utxos.length) throw new Error('HTLC já foi gasto ou não tem UTXOs');

        const utxo = utxos[0];

        // Constrói script de redeem
        const script = Buffer.from(htlc.script, 'hex');

        // PSBT do claim
        const psbt = new Psbt({ network: this.network });

        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
                script: bitcoin.payments.p2wsh({
                    redeem: { output: script, network: this.network }
                }).output,
                value: utxo.value
            },
            witnessScript: script
        });

        // Output pro receiver
        const receiverKey = wallet.deriveKey(1);  // mesma chave usada no lock
        const feeRate = this._getFeeRate();
        const fee = feeRate * 200;

        psbt.addOutput({
            address: receiverKey.address,
            value: utxo.value - fee
        });

        // ⚠️ Assinatura com preimage customizado
        // bitcoinjs-lib não expõe diretamente, precisamos usar `signInput` + partialSig
        // ou construir manualmente o witness.

        // Simplificação: usamos um método customizado
        // (em prod: usar `bitcoin.script.signature.encode` + manual witness)

        try {
            // Para PoC: usamos a chave do receiver com preimage manual
            psbt.signInput(0, receiverKey.keyPair);

            // ⚠️ Aqui é onde precisaríamos injetar o preimage no witness.
            // O bitcoinjs-lib não suporta diretamente, então usamos um workaround:
            // criamos o witness manualmente.

            // Workaround: substitui o finalizado do input 0
            psbt.finalizeInput(0, (inputIndex, input) => {
                const signature = input.partialSig[0].signature;
                // Witness: [sig, preimage, OP_TRUE (1), script]
                return {
                    finalScriptWitness: witnessStackToScriptWitness([
                        signature,
                        Buffer.from(preimage, 'hex'),
                        Buffer.from([0x01]),  // OP_TRUE
                        script
                    ])
                };
            });

            const tx = psbt.extractTransaction();
            const txHex = tx.toHex();
            const txid = await this.client.broadcastTx(txHex);

            htlc.status = 'claimed';
            htlc.claimTxid = txid;
            htlc.preimage = preimage;

            console.log(`✅ ${this.name} HTLC claimed: ${txid}`);
            return { txHash: txid, preimage };

        } catch (e) {
            console.error(`❌ Claim falhou: ${e.message}`);
            throw new Error(`Claim falhou: ${e.message}`);
        }
    }

    // ============================================
    // REFUND HTLC — Após timelock
    // ============================================
    async refundHtlc({ htlcId, refunder }) {
        const wallet = this._requireWallet();
        const htlc = this.htlcCache.get(htlcId);
        if (!htlc) throw new Error(`HTLC ${htlcId} não encontrado`);

        const now = Math.floor(Date.now() / 1000);
        if (now < htlc.timelock) {
            throw new Error(`Timelock ainda ativo (expira em ${htlc.timelock - now}s)`);
        }

        const utxos = await this.client.getUtxos(htlc.address);
        if (!utxos.length) throw new Error('HTLC já foi gasto');

        const utxo = utxos[0];
        const script = Buffer.from(htlc.script, 'hex');

        const psbt = new Psbt({ network: this.network });

        // ⚠️ Para refund, o locktime da tx precisa ser >= timelock
        psbt.setLocktime(htlc.timelock);

        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            sequence: 0xfffffffe,  // habilita CLTV
            witnessUtxo: {
                script: bitcoin.payments.p2wsh({
                    redeem: { output: script, network: this.network }
                }).output,
                value: utxo.value
            },
            witnessScript: script
        });

        // Output pro sender
        const senderKey = wallet.getSwapKey();
        const feeRate = this._getFeeRate();
        const fee = feeRate * 200;

        psbt.addOutput({
            address: senderKey.address,
            value: utxo.value - fee
        });

        psbt.signInput(0, senderKey.keyPair);

        psbt.finalizeInput(0, (inputIndex, input) => {
            const signature = input.partialSig[0].signature;
            // Witness refund: [sig, OP_FALSE (0), script]
            return {
                finalScriptWitness: witnessStackToScriptWitness([
                    signature,
                    Buffer.from([0x00]),  // OP_FALSE
                    script
                ])
            };
        });

        const tx = psbt.extractTransaction();
        const txid = await this.client.broadcastTx(tx.toHex());

        htlc.status = 'refunded';
        htlc.refundTxid = txid;

        console.log(`↩️  ${this.name} HTLC refunded: ${txid}`);
        return { txHash: txid };
    }

    // ============================================
    // STATUS
    // ============================================
    async getHtlcStatus(htlcId) {
        const htlc = this.htlcCache.get(htlcId);
        if (!htlc) throw new Error('HTLC não encontrado');
        return htlc;
    }

    // ============================================
    // BALANCE
    // ============================================
    async getBalance(address) {
        const info = await this.client.getAddressInfo(address);
        return {
            address,
            balance: info.balance / 1e8,
            balanceSat: info.balance,
            symbol: this.symbol
        };
    }

    // ============================================
    // CONFIRMAÇÕES
    // ============================================
    async waitForConfirmations(txid, required = this.confirmations) {
        return this.client.waitForConfirmations(txid, required);
    }

    // ============================================
    // VALIDAÇÃO DE ENDEREÇO
    // ============================================
    isValidAddress(address) {
        if (!address || typeof address !== 'string') return false;
        const prefix = this.cfg.addressPrefix[this.networkName];
        if (prefix && address.startsWith(prefix)) return true;
        // Fallback: valida via bitcoinjs
        try {
            bitcoin.address.toOutputScript(address, this.network);
            return true;
        } catch (_) {
            return false;
        }
    }
}

// ============================================
// HELPER: witness stack → finalScriptWitness
// ============================================
function witnessStackToScriptWitness(witness) {
    let buffer = Buffer.allocUnsafe(0);

    function writeVarInt(i) {
        const currentLen = buffer.length;
        if (i < 0xfd) {
            buffer = Buffer.concat([buffer, Buffer.from([i])]);
        } else if (i <= 0xffff) {
            buffer = Buffer.concat([buffer, Buffer.from([0xfd]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(i); return b; })()]);
        } else if (i <= 0xffffffff) {
            buffer = Buffer.concat([buffer, Buffer.from([0xfe]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(i); return b; })()]);
        } else {
            const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(i));
            buffer = Buffer.concat([buffer, Buffer.from([0xff]), b]);
        }
        return buffer.length - currentLen;
    }

    writeVarInt(witness.length);
    for (const w of witness) {
        writeVarInt(w.length);
        buffer = Buffer.concat([buffer, w]);
    }
    return buffer;
}

module.exports = BitcoinLikeAdapter;
module.exports.CHAIN_CONFIGS = CHAIN_CONFIGS;
