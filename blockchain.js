// blockchain.js
// ============================================
// Bradicoin Blockchain - Core (v5.0 - PoW seguro)
// ============================================
// 🔗 CONSENSO: PoW puro com retarget
// ✅ Saldo materializado no MongoDB
// ✅ Aritmética em BigInt (8 casas) — sem erro de ponto flutuante
// ✅ Verificação de assinatura obrigatória
//
// 🔧 v5.0 (sobre a v4.1):
//   [1]  addTransaction compatível com transactions.js v4.0: tx já gravada no
//        Mongo com o mesmo hash entra na mempool (antes dava "replay detectado"
//        ou ficava fora da mempool e nunca era minerada)
//   [2]  Assinatura/hash usam valores canônicos (amountStr/feeStr), sem float
//   [3]  Transações de sistema só pelos tipos permitidos (reward, wallet_creation,
//        airdrop, buy, mint); unstake só saindo do pool; stake sem assinatura só
//        para o pool. Assinatura única por tx de sistema (evita colisão no
//        índice único de signature)
//   [4]  Mineração só inclui txs validadas (simulação de saldo); lote aplicado
//        de forma atômica (desfaz tudo se algo falhar); ordem canônica por hash
//   [5]  Bloco de peer: valida forma, PoW, dificuldade ESPERADA (antes confiava
//        na dificuldade declarada pelo bloco), timestamp, assinaturas das txs,
//        hash das txs, replay e txs de sistema (bloqueadas por padrão)
//   [6]  Reorg: valida tudo ANTES de mexer no estado, exige mais trabalho
//        acumulado, limita profundidade, faz rollback se falhar e devolve à
//        mempool as txs revertidas
//   [7]  Mutex global: mineração, bloco de peer, reorg e órfãos nunca se
//        sobrepõem
//   [8]  Pool de órfãos: sem loop infinito, sem duplicatas
//   [9]  Bug do token_create corrigido (Decimal128 vinha do lugar errado)
//   [10] Tetos: tamanho da mempool, txs por remetente, TTL, teto de supply
//        nas emissões de sistema, validação de metadata (anti NoSQL injection)
//   [11] Chainwork calculado sobre TODA a chain (antes só o cache de 100 blocos)
// ============================================

'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { EventEmitter } = require('events');
const Decimal128 = mongoose.Types.Decimal128;

const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');

const BlockModel = require('./models/Block');
const TransactionModel = require('./models/Transaction');
const WalletModel = require('./models/Wallet');

const {
    computeNextDifficulty,
    blockWork,
    RETARGET_INTERVAL
} = require('./consensus/retarget');
const { decideFork } = require('./consensus/forkChoice');

// wallet.js também usa o blockchain: require sob demanda evita dependência circular
function getWallet() {
    return require('./wallet');
}

// ============================================
// CONFIGURAÇÃO
// ============================================
function envInt(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min || n > max) {
        console.warn(`⚠️ ${name} inválido (${raw}), usando ${fallback}`);
        return fallback;
    }
    return n;
}

function envBool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return raw === 'true';
}

// ============================================
// VALORES EXATOS (BigInt, 8 casas)
// ============================================
const SCALE = 8;
const UNIT = 10n ** BigInt(SCALE);
const MAX_AMOUNT_UNITS = 100_000_000_000_000n * UNIT; // 100 trilhões de BRD (igual transactions.js)
const MAX_FEE_UNITS = 1000n * UNIT;
const AMOUNT_RE = /^\d{1,15}(\.\d{1,8})?$/;

function toUnits(value) {
    if (value === null || value === undefined) return 0n;
    let s;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Valor numérico inválido');
        s = value.toFixed(SCALE);
    } else {
        s = String(value).trim();
    }
    if (s.length > 64) throw new Error('Valor numérico inválido');

    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) throw new Error('Valor numérico inválido');
    const [, sign, int, frac = '', exp = '0'] = m;
    const e = Number(exp);
    if (Math.abs(e) > 40) throw new Error('Valor numérico inválido');

    const shift = SCALE - (frac.length - e);
    let n = BigInt(int + frac);
    n = shift >= 0 ? n * 10n ** BigInt(shift) : n / 10n ** BigInt(-shift);
    return sign ? -n : n;
}

function safeUnits(value) {
    try { return toUnits(value); } catch (_) { return 0n; }
}

function fromUnits(units) {
    const neg = units < 0n;
    const u = neg ? -units : units;
    const int = (u / UNIT).toString();
    const frac = (u % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
    return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

function canonAmount(value) {
    return fromUnits(toUnits(value));
}

// Valor vindo de fora (string/número/Decimal128) → { units, str } ou lança erro
function parseAmount(value, label, { allowZero = false, maxUnits = MAX_AMOUNT_UNITS } = {}) {
    let s;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) throw new Error(`${label} inválido`);
        s = value.toFixed(SCALE);
    } else if (typeof value === 'string') {
        s = value.trim();
    } else if (value && value._bsontype === 'Decimal128') {
        s = fromUnits(toUnits(value.toString()));
    } else {
        throw new Error(`${label} inválido`);
    }
    if (!AMOUNT_RE.test(s)) throw new Error(`${label} inválido (máx. 8 casas decimais)`);

    const units = toUnits(s);
    if (units < 0n || (!allowZero && units === 0n)) throw new Error(`${label} deve ser maior que zero`);
    if (units > maxUnits) throw new Error(`${label} acima do limite permitido`);
    return { units, str: fromUnits(units) };
}

// ============================================
// CONSTANTES
// ============================================
const ADDRESS_RE = /^Br[a-f0-9]{38}$/;                 // endereço normalizado (minúsculo)
const MINER_RE = /^Br[a-fA-F0-9]{38}$/;                // minerAddress vindo de peer (hash do bloco usa a string original)
const STAKE_POOL_ADDRESS = 'BrSTAKEPOOL000000000000000000000000000000'; // igual ao staking.js
const TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TOKEN_ID_RE = /^BRAD_[a-f0-9]{32}$/;

// Emissões que só o sistema pode criar (fromAddress = null)
const SYSTEM_MINT_TYPES = new Set(['reward', 'wallet_creation', 'airdrop', 'buy', 'mint']);
// Tipos que nenhum usuário pode assinar
const INTERNAL_ONLY_TYPES = new Set(['reward', 'wallet_creation', 'airdrop', 'buy', 'mint', 'unstake']);

const MAX_FUTURE_TX_MS = 5 * 60 * 1000;
const MAX_PAST_TX_MS = 10 * 60 * 1000;
const MAX_BLOCK_BYTES = 512 * 1024;

function parseMaxSupply() {
    const raw = process.env.MAX_SUPPLY;
    if (!raw) return null;
    try {
        const u = toUnits(raw);
        return u > 0n ? u : null;
    } catch (_) {
        return null;
    }
}

function parseMinFee() {
    try {
        return toUnits(process.env.MIN_FEE || '0.001');
    } catch (_) {
        return toUnits('0.001');
    }
}

function normAddr(a) {
    if (typeof a !== 'string') return a;
    const t = a.trim();
    if (t === STAKE_POOL_ADDRESS) return t;
    if (t.length >= 2 && t.slice(0, 2).toLowerCase() === 'br') {
        return 'Br' + t.slice(2).toLowerCase();
    }
    return t;
}

const CONFIG = {
    difficulty: envInt('BLOCK_DIFFICULTY', 3, 1, 12),
    targetBlockTimeMs: envInt('TARGET_BLOCK_TIME_MS', 30000, 1000, 3_600_000),
    maxTxPerBlock: envInt('MAX_TX_PER_BLOCK', 1000, 1, 10_000),
    minFee: Decimal128.fromString(fromUnits(parseMinFee())),
    minFeeUnits: parseMinFee(),
    enforceMinFee: envBool('ENFORCE_MIN_FEE', true),
    blockReward: Decimal128.fromString(process.env.BLOCK_REWARD || '0'),
    feeCollectorAddress: normAddr(process.env.FEE_COLLECTOR_ADDRESS || ''),
    genesisTimestamp: new Date('2026-01-01T00:00:00Z').toISOString(),
    maxOrphanPool: envInt('MAX_ORPHAN_POOL', 100, 1, 1000),
    maxMempool: envInt('MAX_MEMPOOL', 20_000, 100, 200_000),
    maxPendingPerSender: envInt('MAX_PENDING_PER_SENDER', 25, 1, 1000),
    mempoolTtlMs: envInt('MEMPOOL_TTL_MS', 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
    maxFutureBlockMs: envInt('MAX_FUTURE_BLOCK_MS', 5 * 60 * 1000, 1000, 2 * 60 * 60 * 1000),
    maxReorgDepth: envInt('MAX_REORG_DEPTH', 100, 1, 10_000),
    maxPowAttempts: envInt('MAX_POW_ATTEMPTS', 10_000_000, 1000, 1_000_000_000),
    // Blocos de peers podem conter txs de sistema (reward/mint...)? Padrão: NÃO.
    p2pAcceptSystemTxs: envBool('P2P_ACCEPT_SYSTEM_TXS', false),
    enforceSupplyCap: envBool('ENFORCE_SUPPLY_CAP', true),
    maxSupplyUnits: parseMaxSupply()
};

if (!CONFIG.feeCollectorAddress) {
    throw new Error('❌ FEE_COLLECTOR_ADDRESS não configurado no .env');
}
if (!ADDRESS_RE.test(CONFIG.feeCollectorAddress)) {
    throw new Error('❌ FEE_COLLECTOR_ADDRESS inválido');
}

// ============================================
// HELPERS
// ============================================
function safeToString(value, fallback = '0') {
    if (value === null || value === undefined) return fallback;
    try {
        if (value instanceof Date) return value.toISOString();
        return value.toString();
    } catch (_) {
        return fallback;
    }
}

function isHash64(h) {
    return typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
}

function toMs(ts) {
    const n = ts instanceof Date ? ts.getTime() : Date.parse(String(ts));
    return Number.isFinite(n) ? n : NaN;
}

function clampDifficulty(d) {
    const n = Math.round(Number(d));
    if (!Number.isFinite(n)) return CONFIG.difficulty;
    return Math.min(Math.max(n, 1), 64);
}

// Remove chaves perigosas ("$..." e com ".") e limita profundidade/tamanho
function sanitizeMeta(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 4) return undefined;
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeMeta(v, depth + 1));
    if (typeof value === 'string') return value.slice(0, 200_000);
    if (typeof value !== 'object') return value;
    if (value instanceof Date || value._bsontype) return value;

    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
        if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        out[k] = sanitizeMeta(v, depth + 1);
    }
    return out;
}

function normalizeTx(tx) {
    if (!tx) return null;
    const metadata = sanitizeMeta(tx.metadata) || {};

    let amount = tx.amount;
    let fee = tx.fee;
    try { amount = canonAmount(tx.amount); } catch (_) { /* mantém bruto */ }
    try { fee = canonAmount(tx.fee === undefined || tx.fee === null || tx.fee === '' ? '0' : tx.fee); } catch (_) { /* mantém bruto */ }

    return {
        hash: tx.hash,
        fromAddress: tx.fromAddress !== undefined ? tx.fromAddress : (tx.from !== undefined ? tx.from : null),
        toAddress: tx.toAddress !== undefined ? tx.toAddress : tx.to,
        amount,
        fee,
        nonce: Number.isSafeInteger(tx.nonce) ? tx.nonce : 0,
        type: tx.type || 'transfer',
        signature: tx.signature,
        publicKey: tx.publicKey,
        timestamp: tx.timestamp === undefined || tx.timestamp === null ? tx.timestamp : safeToString(tx.timestamp),
        status: tx.status,
        blockIndex: tx.blockIndex,
        blockHash: tx.blockHash,
        tokenData: sanitizeMeta(tx.tokenData || metadata.tokenData) || null,
        metadata
    };
}

// Hash canônico da tx — igual ao calculateTxHash do transactions.js
function computeTxHash(tx) {
    const feeRaw = tx.feeStr !== undefined
        ? tx.feeStr
        : (tx.fee === undefined || tx.fee === null || tx.fee === '' ? '0' : tx.fee);

    const payload = JSON.stringify({
        from: tx.fromAddress || tx.from || null,
        to: tx.toAddress || tx.to || null,
        amount: canonAmount(tx.amountStr !== undefined ? tx.amountStr : tx.amount),
        fee: canonAmount(feeRaw),
        nonce: tx.nonce || 0,
        type: tx.type || 'transfer',
        timestamp: safeToString(tx.timestamp),
        signature: tx.signature || 'system',
        tokenData: tx.tokenData || (tx.metadata && tx.metadata.tokenData) || undefined
    });
    return bytesToHex(sha256(utf8ToBytes(payload)));
}

// Mensagem assinada pelo usuário (formato inalterado)
function buildSignable(tx) {
    const base = [
        tx.fromAddress,
        tx.toAddress,
        canonAmount(tx.amount),
        canonAmount(tx.fee === undefined || tx.fee === null || tx.fee === '' ? '0' : tx.fee),
        String(tx.nonce || 0),
        safeToString(tx.timestamp),
        tx.type || 'transfer'
    ].join('|');

    const tokenData = tx.tokenData || (tx.metadata && tx.metadata.tokenData);
    if (tokenData) return base + `|token:${JSON.stringify(tokenData)}`;
    return base;
}

function validateTokenData(type, td) {
    if (!td || typeof td !== 'object') throw new Error('tokenData é obrigatório');
    const positive = (v) => /[1-9]/.test(String(v));

    if (type === 'token_create') {
        if (typeof td.name !== 'string' || td.name.trim().length < 1 || td.name.length > 50) {
            throw new Error('Nome do token inválido (1-50 caracteres)');
        }
        if (typeof td.symbol !== 'string' || !/^[A-Za-z0-9]{2,10}$/.test(td.symbol)) {
            throw new Error('Símbolo do token inválido (2-10 letras/números)');
        }
        const supply = typeof td.supply === 'number' && Number.isSafeInteger(td.supply) ? String(td.supply) : td.supply;
        if (typeof supply !== 'string' || !/^\d{1,24}(\.\d{1,18})?$/.test(supply) || !positive(supply)) {
            throw new Error('Supply do token inválido');
        }
        if (td.decimals !== undefined && td.decimals !== null) {
            const d = Number(td.decimals);
            if (!Number.isInteger(d) || d < 0 || d > 18) throw new Error('Decimals do token inválido (0-18)');
        }
        if (td.logo !== undefined && td.logo !== null) {
            if (typeof td.logo !== 'string' || td.logo.length > 200_000 ||
                !/^(data:image\/(png|jpe?g|webp|gif);base64,|https:\/\/)/i.test(td.logo)) {
                throw new Error('Logo do token inválida (use PNG/JPG/WEBP/GIF em base64 ou URL https)');
            }
        }
    } else if (type === 'token_transfer') {
        if (typeof td.tokenId !== 'string' || !TOKEN_ID_RE.test(td.tokenId)) throw new Error('tokenId inválido');
        const amt = typeof td.amount === 'number' && Number.isFinite(td.amount) ? String(td.amount) : td.amount;
        if (typeof amt !== 'string' || !/^\d{1,24}(\.\d{1,18})?$/.test(amt) || !positive(amt)) {
            throw new Error('Quantidade de token inválida');
        }
    }
}

function validateBlockShape(b) {
    if (!b || typeof b !== 'object') throw new Error('Bloco inválido');
    if (!Number.isSafeInteger(b.index) || b.index < 1) throw new Error('Bloco: index inválido');
    if (!isHash64(b.hash) || !isHash64(b.previousHash)) throw new Error('Bloco: hash inválido');
    if (!Number.isSafeInteger(b.nonce) || b.nonce < 0) throw new Error('Bloco: nonce inválido');
    if (!Number.isInteger(b.difficulty) || b.difficulty < 1 || b.difficulty > 64) {
        throw new Error('Bloco: dificuldade inválida');
    }
    if (b.minerAddress !== null && b.minerAddress !== undefined && !MINER_RE.test(String(b.minerAddress))) {
        throw new Error('Bloco: minerAddress inválido');
    }
    if (!Array.isArray(b.transactions) || b.transactions.length > CONFIG.maxTxPerBlock) {
        throw new Error('Bloco: lista de transações inválida');
    }
    const ts = toMs(b.timestamp);
    if (!Number.isFinite(ts)) throw new Error('Bloco: timestamp inválido');
    if (ts > Date.now() + CONFIG.maxFutureBlockMs) throw new Error('Bloco: timestamp muito no futuro');
    if (JSON.stringify(b).length > MAX_BLOCK_BYTES) throw new Error('Bloco: tamanho acima do limite');
}

// ============================================
// CLASSE BLOCK
// ============================================
class Block {
    constructor({ index, timestamp, transactions, previousHash, hash, nonce,
                  minerAddress, minerSignature, difficulty }) {
        this.index = index;
        this.timestamp = timestamp;
        this.transactions = (transactions || []).map(normalizeTx).filter(Boolean);
        this.previousHash = previousHash;
        this.nonce = nonce || 0;
        this.minerAddress = minerAddress || null;
        this.minerSignature = minerSignature || null;
        this.difficulty = difficulty || CONFIG.difficulty;
        this.hash = hash || this.calculateHash();
    }

    calculateHash() {
        const payload = JSON.stringify({
            index: this.index,
            timestamp: safeToString(this.timestamp),
            previousHash: this.previousHash,
            nonce: this.nonce,
            minerAddress: this.minerAddress,
            difficulty: this.difficulty,
            txHashes: this.transactions.map((tx) => tx.hash).filter(Boolean).sort()
        });
        return bytesToHex(sha256(utf8ToBytes(payload)));
    }

    meetsDifficulty(difficulty = this.difficulty) {
        if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 64) return false;
        return typeof this.hash === 'string' && this.hash.startsWith('0'.repeat(difficulty));
    }

    toObject() {
        return {
            index: this.index,
            timestamp: this.timestamp,
            transactions: this.transactions.map((tx) => ({
                hash: tx.hash,
                fromAddress: tx.fromAddress,
                toAddress: tx.toAddress,
                amount: tx.amount,
                fee: tx.fee,
                nonce: tx.nonce,
                type: tx.type,
                signature: tx.signature,
                publicKey: tx.publicKey,
                timestamp: tx.timestamp,      // necessário para peers verificarem hash/assinatura
                tokenData: tx.tokenData || null,
                metadata: tx.metadata || {}
            })),
            previousHash: this.previousHash,
            hash: this.hash,
            nonce: this.nonce,
            difficulty: this.difficulty,
            minerAddress: this.minerAddress,
            minerSignature: this.minerSignature
        };
    }
}

// ============================================
// CLASSE BLOCKCHAIN
// ============================================
class Blockchain extends EventEmitter {
    constructor() {
        super();
        this.chain = [];
        this.pendingTransactions = [];
        this.initialized = false;
        this.mining = false;
        this.maxChainCache = 100;

        this._chainwork = 0n;
        this._orphanPool = [];
        this._currentDifficulty = CONFIG.difficulty;
        this._processingOrphans = false;

        this._pendingHashes = new Set();
        this._lockChain = Promise.resolve();
        this._supplyCache = { units: null, at: 0 };
        this._validCache = { key: null, value: true, at: 0 };
    }

    // ============================================
    // MUTEX — uma operação de cadeia por vez
    // ============================================
    async _withLock(fn) {
        const prev = this._lockChain;
        let release;
        this._lockChain = new Promise((resolve) => { release = resolve; });
        await prev;
        try {
            return await fn();
        } finally {
            release();
        }
    }

    // ============================================
    // MEMPOOL (array + Set de hashes, sempre em sincronia)
    // ============================================
    _mempoolSet(list) {
        this.pendingTransactions = list;
        this._pendingHashes = new Set(list.map((t) => t.hash));
    }

    _mempoolPush(tx) {
        if (tx.hash && this._pendingHashes.has(tx.hash)) return false;
        this.pendingTransactions.push(tx);
        this._pendingHashes.add(tx.hash);
        return true;
    }

    _mempoolRemove(hashes) {
        const set = hashes instanceof Set ? hashes : new Set(hashes);
        if (set.size === 0) return;
        this.pendingTransactions = this.pendingTransactions.filter((t) => !set.has(t.hash));
        for (const h of set) this._pendingHashes.delete(h);
    }

    _pendingOutflow(address) {
        let sum = 0n;
        for (const t of this.pendingTransactions) {
            if (t.fromAddress === address) sum += safeUnits(t.amount) + safeUnits(t.fee);
        }
        return sum;
    }

    _pendingCountFrom(address) {
        let n = 0;
        for (const t of this.pendingTransactions) if (t.fromAddress === address) n++;
        return n;
    }

    // ============================================
    // CONSULTAS P2P
    // ============================================
    getChainwork() {
        return this._chainwork.toString();
    }

    getCurrentDifficulty() {
        return this._currentDifficulty;
    }

    async getBlockByIndexOrNull(index) {
        if (!Number.isSafeInteger(index) || index < 0) return null;
        const cached = this.chain.find((b) => b.index === index);
        if (cached) return cached.toObject();
        return BlockModel.findOne({ index }).lean();
    }

    async getBlockByHashOrNull(hash) {
        if (!isHash64(hash)) return null;
        const cached = this.chain.find((b) => b.hash === hash);
        if (cached) return cached.toObject();
        return BlockModel.findOne({ hash }).lean();
    }

    // ============================================
    // INICIALIZAÇÃO
    // ============================================
    async initialize() {
        if (this.initialized) return;

        try {
            const existingGenesis = await BlockModel.findOne({ index: 0 }).lean();

            if (!existingGenesis) {
                try {
                    const genesis = await this.createGenesisBlock();
                    this.chain = [genesis];
                    console.log('🌱 Genesis block criado');
                } catch (err) {
                    if (err.code === 11000) {
                        console.log('ℹ️ Genesis já criado por outro worker');
                        const gen = await BlockModel.findOne({ index: 0 }).lean();
                        this.chain = gen ? [new Block(gen)] : [];
                    } else {
                        throw err;
                    }
                }
            } else {
                const latestBlocks = await BlockModel.find()
                    .sort({ index: -1 })
                    .limit(this.maxChainCache)
                    .lean();

                this.chain = latestBlocks.reverse().map((b) => new Block(b));
                console.log(`📦 ${this.chain.length} blocos carregados (últimos)`);
            }

            await this._ensureSystemWallets();
            await this._loadMempool();
            await this._recomputeChainwork();

            const tip = this.getLatestBlock();
            this._currentDifficulty = (tip && tip.difficulty) || CONFIG.difficulty;

            console.log(`⚖️  chainwork=${this._chainwork.toString()} difficulty=${this._currentDifficulty}`);

            this.initialized = true;
        } catch (error) {
            console.error('❌ Erro ao inicializar blockchain:', error);
            throw error;
        }
    }

    // Carteira do pool de staking (endereço de sistema, ninguém registra)
    async _ensureSystemWallets() {
        try {
            const exists = await WalletModel.exists({ address: STAKE_POOL_ADDRESS });
            if (!exists) {
                await WalletModel.updateOne(
                    { address: STAKE_POOL_ADDRESS },
                    {
                        $setOnInsert: {
                            address: STAKE_POOL_ADDRESS,
                            publicKey: 'SYSTEM',
                            balance: Decimal128.fromString('0'),
                            nonce: 0,
                            status: 'active'
                        }
                    },
                    { upsert: true }
                );
                console.log('🏦 Carteira do pool de staking criada');
            }
        } catch (e) {
            console.error('⚠️ Não foi possível garantir a carteira do pool de staking:', e.message);
        }

        try {
            const fc = await WalletModel.exists({ address: CONFIG.feeCollectorAddress });
            if (!fc) {
                console.error(`🚨 Carteira do FEE_COLLECTOR_ADDRESS (${CONFIG.feeCollectorAddress}) não existe — transações com taxa vão falhar até ela ser registrada`);
            }
        } catch (_) { /* ignora */ }
    }

    async _loadMempool() {
        const pending = await TransactionModel.find({
            status: 'pending',
            'metadata.internal': { $ne: true }   // créditos internos (airdrop/compra) não vão para a mempool
        })
            .sort({ timestamp: 1 })
            .limit(CONFIG.maxMempool)
            .lean();

        // Se o processo caiu depois de gravar o bloco e antes de atualizar o status
        const inCache = new Map();
        for (const b of this.chain) {
            for (const tx of b.transactions) if (tx.hash) inCache.set(tx.hash, b);
        }

        const live = [];
        let fixed = 0;
        for (const doc of pending) {
            const n = normalizeTx(doc);
            const blk = inCache.get(n.hash);
            if (blk) {
                await TransactionModel.updateOne(
                    { hash: n.hash },
                    { $set: { status: 'confirmed', blockIndex: blk.index, blockHash: blk.hash, confirmations: 1 } }
                ).catch(() => {});
                fixed++;
            } else {
                live.push({ ...n, status: 'pending' });
            }
        }

        this._mempoolSet(live);
        console.log(`⏳ ${live.length} transações pendentes carregadas${fixed ? ` (${fixed} já estavam em blocos e foram corrigidas)` : ''}`);
    }

    async _recomputeChainwork() {
        const groups = await BlockModel.aggregate([
            { $group: { _id: '$difficulty', count: { $sum: 1 } } }
        ]);
        let total = 0n;
        for (const g of groups) {
            total += blockWork(clampDifficulty(g._id || CONFIG.difficulty)) * BigInt(g.count);
        }
        this._chainwork = total;
    }

    // ============================================
    // GÊNESE
    // ============================================
    async createGenesisBlock() {
        const genesis = new Block({
            index: 0,
            timestamp: CONFIG.genesisTimestamp,
            transactions: [],
            previousHash: '0'.repeat(64),
            nonce: 0,
            difficulty: CONFIG.difficulty,
            minerAddress: null,
            minerSignature: null
        });

        while (!genesis.meetsDifficulty(genesis.difficulty)) {
            genesis.nonce++;
            genesis.hash = genesis.calculateHash();
        }

        await BlockModel.create(genesis.toObject());
        return genesis;
    }

    // ============================================
    // HASH E ASSINATURA (métodos mantidos por compatibilidade)
    // ============================================
    calculateTxHash(tx) {
        return computeTxHash(tx);
    }

    buildSignableMessage(tx) {
        return buildSignable(tx);
    }

    // ============================================
    // TETO DE SUPPLY (emissões de sistema)
    // ============================================
    async _currentSupplyUnits() {
        const now = Date.now();
        if (this._supplyCache.units !== null && now - this._supplyCache.at < 10_000) {
            return this._supplyCache.units;
        }
        const [agg] = await WalletModel.aggregate([
            { $group: { _id: null, total: { $sum: { $toDecimal: '$balance' } } } }
        ]);
        const units = agg && agg.total !== undefined && agg.total !== null
            ? toUnits(agg.total.toString())
            : 0n;
        this._supplyCache = { units, at: now };
        return units;
    }

    async _assertSupplyCap(newUnits) {
        if (!CONFIG.enforceSupplyCap || CONFIG.maxSupplyUnits === null) return;

        let current;
        try {
            current = await this._currentSupplyUnits();
        } catch (e) {
            // Falha ao medir: não trava a rede, mas deixa rastro
            console.error('⚠️ Não foi possível medir o supply para checar o teto:', e.message);
            return;
        }

        let pendingMint = 0n;
        for (const t of this.pendingTransactions) {
            if (!t.fromAddress) pendingMint += safeUnits(t.amount);
        }

        if (current + pendingMint + newUnits > CONFIG.maxSupplyUnits) {
            throw new Error('Emissão recusada: ultrapassaria o supply máximo');
        }
    }

    // ============================================
    // ADICIONAR TRANSAÇÃO À MEMPOOL
    // ============================================
    async addTransaction(input) {
        if (!input || typeof input !== 'object') throw new Error('Transação inválida');
        const wallet = getWallet();

        // ---------- tipo e endereços
        const type = input.type === undefined || input.type === null ? 'transfer' : input.type;
        if (typeof type !== 'string' || !TYPE_RE.test(type)) throw new Error('Tipo de transação inválido');

        const rawFrom = input.fromAddress !== undefined ? input.fromAddress : input.from;
        const rawTo = input.toAddress !== undefined ? input.toAddress : input.to;
        const from = rawFrom === undefined || rawFrom === null || rawFrom === '' ? null : normAddr(rawFrom);
        const to = normAddr(rawTo);

        if (!to || typeof to !== 'string') throw new Error('Destinatário obrigatório');
        if (from !== null && from !== STAKE_POOL_ADDRESS && !ADDRESS_RE.test(from)) {
            throw new Error('Endereço de origem inválido');
        }
        if (to !== STAKE_POOL_ADDRESS && !ADDRESS_RE.test(to)) throw new Error('Endereço de destino inválido');
        if (from !== null && from === to) throw new Error('Origem e destino não podem ser iguais');

        const hasSignature = typeof input.signature === 'string' && input.signature.length > 0;
        const fromPool = from === STAKE_POOL_ADDRESS;
        const toPool = to === STAKE_POOL_ADDRESS;

        // ---------- modo da transação
        let mode; // 'system' | 'pool' | 'internal-stake' | 'signed'
        if (from === null) {
            if (!SYSTEM_MINT_TYPES.has(type)) throw new Error(`Tipo "${type}" não permitido como transação de sistema`);
            if (toPool) throw new Error('Destino inválido para transação de sistema');
            mode = 'system';
        } else if (fromPool) {
            if (type !== 'unstake' || toPool) throw new Error('Saída do pool só é permitida para unstake');
            mode = 'pool';
        } else if (toPool) {
            if (type !== 'stake') throw new Error('Envio ao pool só é permitido para stake');
            mode = hasSignature ? 'signed' : 'internal-stake';
        } else {
            if (INTERNAL_ONLY_TYPES.has(type)) throw new Error(`Tipo "${type}" é reservado ao sistema`);
            if (!hasSignature) throw new Error('Assinatura obrigatória');
            mode = 'signed';
        }

        // ---------- valores
        const isTokenTx = type === 'token_create' || type === 'token_transfer';
        if (isTokenTx && mode !== 'signed') throw new Error('Transação de token exige assinatura');

        const amount = parseAmount(
            input.amountStr !== undefined ? input.amountStr : input.amount,
            'Valor',
            { allowZero: isTokenTx }
        );
        const feeRaw = input.feeStr !== undefined
            ? input.feeStr
            : (input.fee === undefined || input.fee === null || input.fee === '' ? '0' : input.fee);
        const fee = parseAmount(feeRaw, 'Taxa', { allowZero: true, maxUnits: MAX_FEE_UNITS });

        if (mode !== 'signed' && fee.units !== 0n) throw new Error('Transações internas não podem ter taxa');

        const nonce = input.nonce === undefined || input.nonce === null ? 0 : input.nonce;
        if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Nonce inválido');

        // ---------- tokenData
        let tokenData = null;
        if (isTokenTx) {
            tokenData = sanitizeMeta(input.tokenData || (input.metadata && input.metadata.tokenData));
            validateTokenData(type, tokenData);
        }

        // ---------- timestamp
        let timestamp;
        const rawTs = input.timestamp;
        if (rawTs === undefined || rawTs === null || rawTs === '') {
            if (mode === 'signed') throw new Error('Timestamp é obrigatório');
            timestamp = new Date().toISOString();
        } else {
            timestamp = rawTs instanceof Date ? rawTs.toISOString() : rawTs;
            if (typeof timestamp !== 'string') throw new Error('Timestamp inválido');
            const ms = Date.parse(timestamp);
            if (!Number.isFinite(ms)) throw new Error('Timestamp inválido');
            if (ms > Date.now() + MAX_FUTURE_TX_MS) throw new Error('Timestamp muito no futuro');
            if (mode === 'signed') {
                if (new Date(ms).toISOString() !== timestamp) {
                    throw new Error('Timestamp deve estar no formato ISO (toISOString)');
                }
                if (ms < Date.now() - MAX_PAST_TX_MS) throw new Error('Timestamp muito antigo');
            }
        }

        // ---------- assinatura (ou identificador único de sistema)
        let signature;
        let publicKey;
        if (mode === 'signed') {
            signature = input.signature;
            publicKey = input.publicKey;
            if (typeof publicKey !== 'string' || signature.length > 512 || publicKey.length > 256) {
                throw new Error('Assinatura e chave pública são obrigatórias');
            }

            const message = buildSignable({
                fromAddress: from, toAddress: to,
                amount: amount.str, fee: fee.str,
                nonce, timestamp, type, tokenData
            });
            let ok = false;
            try { ok = wallet.verifySignature(message, signature, publicKey) === true; } catch (_) { ok = false; }
            if (!ok) throw new Error('Assinatura inválida');

            let derived;
            try {
                derived = wallet.normalizeAddress(wallet.deriveAddressFromPublicKey(publicKey));
            } catch (_) {
                throw new Error('Public key inválida');
            }
            if (derived !== from) throw new Error('Public key não corresponde ao endereço de origem');

            const reserve = process.env.RESERVE_ADDRESS ? normAddr(process.env.RESERVE_ADDRESS) : null;
            if (CONFIG.enforceMinFee && from !== reserve && fee.units < CONFIG.minFeeUnits) {
                throw new Error(`Taxa mínima: ${fromUnits(CONFIG.minFeeUnits)} BRD`);
            }
        } else {
            let key = null;
            if (typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9:_.-]{1,128}$/.test(input.idempotencyKey)) {
                key = input.idempotencyKey;
            } else if (type === 'wallet_creation') {
                key = to;                      // no máximo um saldo inicial por carteira
            }
            signature = `SYSTEM_${type}_${key || crypto.randomUUID()}`;
            publicKey = 'SYSTEM';
        }

        // ---------- hash canônico
        const txHash = computeTxHash({
            fromAddress: from, toAddress: to,
            amount: amount.str, fee: fee.str,
            nonce, type, timestamp, signature, tokenData
        });
        if (input.hash !== undefined && input.hash !== null && input.hash !== txHash) {
            throw new Error('Hash da transação diverge do hash canônico');
        }

        if (this._pendingHashes.has(txHash)) {
            return { hash: txHash, status: 'pending', message: 'Transação já estava na fila' };
        }

        // ---------- duplicidade / replay
        const existing = await TransactionModel.findOne({
            $or: [{ hash: txHash }, { signature }]
        }).lean();

        let recovering = false;
        if (existing) {
            if (existing.hash !== txHash) {
                if (mode === 'signed') throw new Error('Transação já submetida (replay detectado)');
                return { hash: existing.hash, status: existing.status, message: 'Transação já existia' };
            }
            if (existing.status !== 'pending') {
                return { hash: existing.hash, status: existing.status, message: 'Transação já existia' };
            }
            recovering = true;   // gravada pelo transactions.js, falta entrar na mempool
        }

        if (mode === 'signed') {
            const nonceUsed = await TransactionModel.exists({
                from,
                nonce,
                hash: { $ne: txHash },
                status: { $ne: 'failed' },
                'metadata.internal': { $ne: true }
            });
            if (nonceUsed) throw new Error('Nonce já usado (replay detectado)');
        }

        // ---------- carteiras e saldo
        const toDoc = await WalletModel.findOne({ address: to }).select('status').lean();
        if (!toDoc) throw new Error('Carteira de destino não encontrada');

        if (from !== null) {
            const senderDoc = await WalletModel.findOne({ address: from }).select('balance nonce status').lean();
            if (!senderDoc) throw new Error('Carteira de origem não encontrada ou inativa');
            if (!fromPool && senderDoc.status !== 'active') throw new Error('Carteira de origem não encontrada ou inativa');

            if (mode === 'signed' && senderDoc.nonce !== nonce) {
                throw new Error(`Nonce inválido: esperado ${senderDoc.nonce}, recebido ${nonce}`);
            }

            const balance = safeUnits(senderDoc.balance);
            const available = balance - this._pendingOutflow(from);
            const need = amount.units + fee.units;
            if (available < need) {
                throw new Error(`Saldo insuficiente: ${fromUnits(available)} < ${fromUnits(need)}`);
            }

            if (this._pendingCountFrom(from) >= CONFIG.maxPendingPerSender) {
                throw new Error('Muitas transações pendentes deste endereço');
            }
        } else {
            await this._assertSupplyCap(amount.units);
        }

        if (!recovering && this.pendingTransactions.length >= CONFIG.maxMempool) {
            throw new Error('Mempool cheia, tente novamente em instantes');
        }

        // ---------- persiste e coloca na mempool
        const safeMetadata = { ...(sanitizeMeta(input.metadata) || {}) };
        delete safeMetadata.internal;   // só o sistema marca créditos internos
        delete safeMetadata.system;
        delete safeMetadata.tokenData;
        if (mode !== 'signed') safeMetadata.system = true;
        if (tokenData) safeMetadata.tokenData = tokenData;

        if (!recovering) {
            try {
                await TransactionModel.create({
                    hash: txHash,
                    from,
                    to,
                    amount: Decimal128.fromString(amount.str),
                    fee: Decimal128.fromString(fee.str),
                    nonce,
                    type,
                    signature,
                    publicKey,
                    status: 'pending',
                    timestamp: new Date(timestamp),
                    metadata: safeMetadata
                });
            } catch (err) {
                if (err && err.code === 11000) throw new Error('Transação já submetida (replay detectado)');
                throw err;
            }
        }

        const entry = normalizeTx({
            hash: txHash, fromAddress: from, toAddress: to,
            amount: amount.str, fee: fee.str,
            nonce, type, signature, publicKey, timestamp,
            status: 'pending', tokenData, metadata: safeMetadata
        });
        this._mempoolPush(entry);
        this.emit('tx:new', entry);

        return { hash: txHash, status: 'pending', message: 'Transação adicionada à fila' };
    }

    // ============================================
    // DIFICULDADE ESPERADA (retarget)
    // ============================================
    async _getRange(start, end) {
        return BlockModel.find({ index: { $gte: start, $lte: end } })
            .sort({ index: 1 })
            .lean();
    }

    async _expectedDifficulty(index, parentDifficulty, loadRange) {
        if (index <= 0) return CONFIG.difficulty;
        if (index % RETARGET_INTERVAL !== 0) return parentDifficulty;

        const start = index - RETARGET_INTERVAL;
        if (start < 0) return parentDifficulty;

        const blocks = await loadRange(start, index - 1);
        if (!Array.isArray(blocks) || blocks.length < RETARGET_INTERVAL) return parentDifficulty;

        return clampDifficulty(computeNextDifficulty(index, blocks, parentDifficulty));
    }

    _checkBlockTimestamp(block, parent) {
        const ts = toMs(block.timestamp);
        const pts = toMs(parent.timestamp);
        if (!Number.isFinite(ts)) throw new Error(`Bloco ${block.index}: timestamp inválido`);
        if (Number.isFinite(pts) && ts <= pts) {
            throw new Error(`Bloco ${block.index}: timestamp anterior ao do bloco pai`);
        }
        if (ts > Date.now() + CONFIG.maxFutureBlockMs) {
            throw new Error(`Bloco ${block.index}: timestamp muito no futuro`);
        }
    }

    // ============================================
    // SELEÇÃO DE TXS PARA O BLOCO (simula saldos)
    // ============================================
    async _failTxs(txs, reason) {
        const hashes = txs.map((t) => t.hash).filter(Boolean);
        if (hashes.length === 0) return;
        this._mempoolRemove(hashes);
        try {
            await TransactionModel.updateMany(
                { hash: { $in: hashes }, status: 'pending' },
                { $set: { status: 'failed', 'metadata.reason': String(reason).slice(0, 200) } }
            );
        } catch (e) {
            console.error('❌ Erro ao marcar txs como failed:', e.message);
        }
    }

    async _selectTxsForBlock() {
        const now = Date.now();
        const expired = [];
        const live = [];
        for (const tx of this.pendingTransactions) {
            const ts = toMs(tx.timestamp);
            if (Number.isFinite(ts) && now - ts > CONFIG.mempoolTtlMs) expired.push(tx);
            else live.push(tx);
        }
        if (expired.length) await this._failTxs(expired, 'Expirada na mempool');
        if (live.length === 0) return [];

        // Prioridade: maior taxa primeiro, depois a mais antiga
        const prioritized = live
            .map((tx, i) => ({ tx, fee: safeUnits(tx.fee), i }))
            .sort((a, b) => (a.fee === b.fee ? a.i - b.i : (a.fee > b.fee ? -1 : 1)))
            .slice(0, CONFIG.maxTxPerBlock)
            .map((x) => x.tx);

        // Ordem canônica do bloco: por hash (o hash do bloco só compromete o conjunto)
        const ordered = [...prioritized].sort((a, b) => (a.hash < b.hash ? -1 : (a.hash > b.hash ? 1 : 0)));

        const addrs = new Set([CONFIG.feeCollectorAddress]);
        for (const t of ordered) {
            if (t.fromAddress) addrs.add(t.fromAddress);
            if (t.toAddress) addrs.add(t.toAddress);
        }
        const docs = await WalletModel.find({ address: { $in: [...addrs] } })
            .select('address balance status')
            .lean();
        const state = new Map(docs.map((d) => [d.address, { units: safeUnits(d.balance), status: d.status }]));

        const included = [];
        const invalid = [];

        for (const tx of ordered) {
            try {
                const amount = toUnits(tx.amount);
                const fee = toUnits(tx.fee);

                const dest = state.get(tx.toAddress);
                if (!dest) { invalid.push([tx, 'Carteira de destino não encontrada']); continue; }

                if (tx.fromAddress) {
                    const src = state.get(tx.fromAddress);
                    if (!src) { invalid.push([tx, 'Carteira de origem não encontrada']); continue; }
                    if (src.status && src.status !== 'active') { invalid.push([tx, 'Carteira de origem inativa']); continue; }

                    const need = amount + fee;
                    if (src.units < need) continue;   // adiada: pode ser financiada por outra tx
                    src.units -= need;
                }

                dest.units += amount;
                if (fee > 0n) {
                    const fc = state.get(CONFIG.feeCollectorAddress);
                    if (fc) fc.units += fee;
                }
                included.push(tx);
            } catch (e) {
                invalid.push([tx, e.message]);
            }
        }

        for (const [tx, reason] of invalid) await this._failTxs([tx], reason);
        return included;
    }

    // ============================================
    // APLICAR / REVERTER TRANSAÇÕES (com desfazer passo a passo)
    // ============================================
    async _applyOne(tx) {
        const amountUnits = toUnits(tx.amount);
        const feeUnits = toUnits(tx.fee);
        const amountStr = fromUnits(amountUnits);
        const feeStr = fromUnits(feeUnits);
        const from = tx.fromAddress;
        const to = tx.toAddress;
        const undo = [];

        try {
            if (tx.type === 'token_create') {
                await this._applyTokenCreate(tx);
                undo.push(() => this._revertTokenCreate(tx));
            } else if (tx.type === 'token_transfer') {
                await this._applyTokenTransfer(tx);
                undo.push(() => this._revertTokenTransfer(tx));
            }

            if (!from) {
                if (amountUnits > 0n) {
                    await WalletModel.credit(to, amountStr);
                    undo.push(() => WalletModel.revertCredit(to, amountStr));
                    console.log(`💰 Sistema creditou ${amountStr} em ${String(to).substring(0, 12)}...`);
                }
                return;
            }

            if (from === to) throw new Error('Origem e destino iguais');

            const total = amountUnits + feeUnits;
            if (total > 0n) {
                const totalStr = fromUnits(total);
                await WalletModel.debit(from, totalStr);
                undo.push(() => WalletModel.revertDebit(from, totalStr));
            }
            if (amountUnits > 0n) {
                await WalletModel.credit(to, amountStr);
                undo.push(() => WalletModel.revertCredit(to, amountStr));
            }
            if (feeUnits > 0n) {
                await WalletModel.credit(CONFIG.feeCollectorAddress, feeStr);
                undo.push(() => WalletModel.revertCredit(CONFIG.feeCollectorAddress, feeStr));
            }
        } catch (err) {
            for (const fn of undo.reverse()) {
                try {
                    await fn();
                } catch (e) {
                    console.error(`🚨 Falha ao desfazer passo da TX ${tx.hash}:`, e.message);
                    this.emit('consistency:error', { hash: tx.hash, message: e.message });
                }
            }
            throw err;
        }
    }

    // Aplica o lote inteiro ou nada: se uma tx falhar, desfaz as anteriores
    async _applyBatch(txs) {
        const done = [];
        for (const tx of txs) {
            try {
                await this._applyOne(tx);
                done.push(tx);
            } catch (err) {
                await this._revertTransactions(done);
                err.failedTx = tx;
                throw err;
            }
        }
    }

    async _revertOne(rawTx) {
        const tx = normalizeTx(rawTx);
        const amountUnits = toUnits(tx.amount);
        const feeUnits = toUnits(tx.fee);
        const amountStr = fromUnits(amountUnits);
        const from = tx.fromAddress;
        const to = tx.toAddress;
        const errors = [];

        const step = async (fn) => {
            try { await fn(); } catch (e) { errors.push(e.message); }
        };

        if (!from) {
            if (amountUnits > 0n) await step(() => WalletModel.revertCredit(to, amountStr));
        } else {
            if (feeUnits > 0n) await step(() => WalletModel.revertCredit(CONFIG.feeCollectorAddress, fromUnits(feeUnits)));
            if (amountUnits > 0n) await step(() => WalletModel.revertCredit(to, amountStr));
            const total = amountUnits + feeUnits;
            if (total > 0n) await step(() => WalletModel.revertDebit(from, fromUnits(total)));
        }

        if (tx.type === 'token_create') await step(() => this._revertTokenCreate(tx));
        else if (tx.type === 'token_transfer') await step(() => this._revertTokenTransfer(tx));

        if (errors.length) throw new Error(errors.join(' | '));
    }

    // Reverte em ordem inversa; devolve quantas falharam
    async _revertTransactions(transactions) {
        let failures = 0;
        for (const raw of [...transactions].reverse()) {
            try {
                await this._revertOne(raw);
            } catch (error) {
                failures++;
                console.error(`🚨 Erro ao reverter TX ${raw && raw.hash}:`, error.message);
            }
        }
        if (failures) this.emit('consistency:error', { failures });
        return failures;
    }

    // ============================================
    // PERSISTÊNCIA DE STATUS (upsert: grava também txs que vieram de peers)
    // ============================================
    async _markConfirmed(block) {
        const ops = [];
        for (const tx of block.transactions) {
            if (!tx.hash) continue;
            let amount;
            let fee;
            try {
                amount = Decimal128.fromString(canonAmount(tx.amount));
                fee = Decimal128.fromString(canonAmount(tx.fee));
            } catch (_) { continue; }

            const ts = toMs(tx.timestamp);
            ops.push({
                updateOne: {
                    filter: { hash: tx.hash },
                    update: {
                        $set: {
                            status: 'confirmed',
                            blockIndex: block.index,
                            blockHash: block.hash,
                            confirmations: 1
                        },
                        $setOnInsert: {
                            from: tx.fromAddress || null,
                            to: tx.toAddress,
                            amount,
                            fee,
                            nonce: tx.nonce || 0,
                            type: tx.type,
                            signature: tx.signature || `SYSTEM_${tx.type}_${tx.hash}`,
                            publicKey: tx.publicKey || 'SYSTEM',
                            timestamp: Number.isFinite(ts) ? new Date(ts) : new Date(),
                            metadata: tx.metadata || {}
                        }
                    },
                    upsert: true
                }
            });
        }
        if (ops.length === 0) return;

        try {
            await TransactionModel.bulkWrite(ops, { ordered: false });
        } catch (e) {
            const errs = e && e.writeErrors ? e.writeErrors : [];
            const onlyDup = errs.length > 0 && errs.every((w) => ((w.err && w.err.code) || w.code) === 11000);
            if (e.code !== 11000 && !onlyDup) {
                console.error('❌ Erro ao atualizar status das txs do bloco:', e.message);
            }
        }
    }

    // ============================================
    // MINERAR BLOCO
    // ============================================
    async minePendingTransactions(minerAddress) {
        if (this.mining) throw new Error('Mineração já em andamento');
        this.mining = true;
        try {
            return await this._withLock(() => this._mineLocked(minerAddress));
        } finally {
            this.mining = false;
        }
    }

    async _solvePow(block, difficulty) {
        const prefix = '0'.repeat(difficulty);
        let tries = 0;
        for (;;) {
            block.hash = block.calculateHash();
            if (block.hash.startsWith(prefix)) return;
            block.nonce++;
            if (++tries > CONFIG.maxPowAttempts) {
                console.error(`🚨 PoW falhou após ${CONFIG.maxPowAttempts} tentativas. Dificuldade: ${difficulty}`);
                throw new Error('Não foi possível minerar');
            }
            // devolve o controle ao event loop (não trava a API durante o PoW)
            if (tries % 2000 === 0) await new Promise((resolve) => setImmediate(resolve));
        }
    }

    async _mineLocked(minerAddress) {
        if (this.pendingTransactions.length === 0) return null;

        let miner = null;
        if (minerAddress) {
            miner = normAddr(minerAddress);
            if (!ADDRESS_RE.test(miner)) throw new Error('❌ minerAddress inválido');
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            const txsToMine = await this._selectTxsForBlock();
            if (txsToMine.length === 0) return null;

            const previousBlock = this.getLatestBlock();
            if (!previousBlock) throw new Error('Nenhum bloco anterior');

            const newIndex = previousBlock.index + 1;
            const nextDifficulty = await this._expectedDifficulty(
                newIndex,
                previousBlock.difficulty,
                (s, e) => this._getRange(s, e)
            );

            const ts = Math.max(Date.now(), (toMs(previousBlock.timestamp) || 0) + 1);
            const newBlock = new Block({
                index: newIndex,
                timestamp: new Date(ts).toISOString(),
                transactions: txsToMine,
                previousHash: previousBlock.hash,
                nonce: 0,
                difficulty: nextDifficulty,
                minerAddress: miner,
                minerSignature: null
            });

            await this._solvePow(newBlock, nextDifficulty);

            // Estado mudou durante o PoW? (defesa extra; o mutex já impede)
            if (this.getLatestBlock().hash !== previousBlock.hash) return null;

            try {
                await this._applyBatch(newBlock.transactions);
            } catch (err) {
                if (err.failedTx) {
                    console.error(`❌ TX ${err.failedTx.hash} falhou ao aplicar: ${err.message}`);
                    await this._failTxs([err.failedTx], err.message);
                    continue;   // tenta de novo sem a tx problemática
                }
                throw err;
            }

            try {
                await BlockModel.create(newBlock.toObject());
            } catch (err) {
                await this._revertTransactions(newBlock.transactions);
                throw err;
            }

            await this._markConfirmed(newBlock);
            this._commitToCache(newBlock);
            this._mempoolRemove(new Set(newBlock.transactions.map((t) => t.hash).filter(Boolean)));

            console.log(`⛏️  Bloco ${newBlock.index} minerado: ${newBlock.hash.substring(0, 16)}... (${newBlock.transactions.length} TXs, diff=${nextDifficulty})`);

            this.emit('block:new', newBlock.toObject());

            await this._processOrphans().catch((e) =>
                console.error('processOrphans (miner):', e.message)
            );

            return newBlock.toObject();
        }

        return null;
    }

    _commitToCache(block) {
        this.chain.push(block);
        if (this.chain.length > this.maxChainCache) this.chain.shift();
        this._chainwork += blockWork(block.difficulty);
        this._currentDifficulty = block.difficulty;
        this._supplyCache.at = 0;
    }

    // ============================================
    // VALIDAÇÃO DAS TXS DE UM BLOCO VINDO DE PEER
    // ============================================
    async _validatePeerTxs(block, allowedConfirmed = new Set()) {
        const wallet = getWallet();
        const seen = new Set();
        let prev = '';

        for (const tx of block.transactions) {
            if (!isHash64(tx.hash)) throw new Error(`Bloco ${block.index}: hash de transação inválido`);
            if (seen.has(tx.hash)) throw new Error(`Bloco ${block.index}: transação duplicada`);
            if (prev && tx.hash < prev) throw new Error(`Bloco ${block.index}: transações fora da ordem canônica`);
            prev = tx.hash;
            seen.add(tx.hash);

            const type = tx.type;
            if (typeof type !== 'string' || !TYPE_RE.test(type)) throw new Error(`Bloco ${block.index}: tipo de transação inválido`);

            const from = tx.fromAddress ? normAddr(tx.fromAddress) : null;
            const to = normAddr(tx.toAddress);
            if (from !== null && from !== STAKE_POOL_ADDRESS && !ADDRESS_RE.test(from)) throw new Error(`Bloco ${block.index}: origem inválida`);
            if (to !== STAKE_POOL_ADDRESS && !ADDRESS_RE.test(to)) throw new Error(`Bloco ${block.index}: destino inválido`);
            if (from !== null && from === to) throw new Error(`Bloco ${block.index}: origem e destino iguais`);

            const isTokenTx = type === 'token_create' || type === 'token_transfer';
            const amount = parseAmount(tx.amount, 'Valor', { allowZero: isTokenTx });
            const fee = parseAmount(tx.fee, 'Taxa', { allowZero: true, maxUnits: MAX_FEE_UNITS });

            if (typeof tx.timestamp !== 'string' || !Number.isFinite(Date.parse(tx.timestamp))) {
                throw new Error(`Bloco ${block.index}: timestamp de transação inválido`);
            }

            const canonical = computeTxHash({
                fromAddress: from, toAddress: to,
                amount: amount.str, fee: fee.str,
                nonce: tx.nonce, type, timestamp: tx.timestamp,
                signature: tx.signature, tokenData: tx.tokenData
            });
            if (canonical !== tx.hash) throw new Error(`Bloco ${block.index}: hash da transação não confere`);

            const isSystem = from === null;
            const poolTx = from === STAKE_POOL_ADDRESS || to === STAKE_POOL_ADDRESS;

            if (isSystem || (poolTx && tx.publicKey === 'SYSTEM')) {
                // Transações de sistema não podem ser verificadas por quem não as gerou
                if (!CONFIG.p2pAcceptSystemTxs) {
                    throw new Error(`Bloco ${block.index}: transações de sistema não são aceitas via P2P`);
                }
                if (isSystem && !SYSTEM_MINT_TYPES.has(type)) throw new Error(`Bloco ${block.index}: tipo de sistema inválido`);
                continue;
            }

            if (INTERNAL_ONLY_TYPES.has(type)) throw new Error(`Bloco ${block.index}: tipo reservado ao sistema`);
            if (isTokenTx) validateTokenData(type, tx.tokenData);

            if (typeof tx.signature !== 'string' || typeof tx.publicKey !== 'string' ||
                tx.signature.length > 512 || tx.publicKey.length > 256) {
                throw new Error(`Bloco ${block.index}: assinatura ausente`);
            }
            const message = buildSignable({
                fromAddress: from, toAddress: to,
                amount: amount.str, fee: fee.str,
                nonce: tx.nonce, timestamp: tx.timestamp, type, tokenData: tx.tokenData
            });
            let ok = false;
            try { ok = wallet.verifySignature(message, tx.signature, tx.publicKey) === true; } catch (_) { ok = false; }
            if (!ok) throw new Error(`Bloco ${block.index}: assinatura inválida em ${tx.hash.substring(0, 12)}...`);

            let derived;
            try { derived = wallet.normalizeAddress(wallet.deriveAddressFromPublicKey(tx.publicKey)); } catch (_) { derived = null; }
            if (derived !== from) throw new Error(`Bloco ${block.index}: chave pública não corresponde à origem`);
        }

        if (seen.size > 0) {
            const dup = await TransactionModel.find({ hash: { $in: [...seen] }, status: 'confirmed' })
                .select('hash')
                .lean();
            for (const d of dup) {
                if (!allowedConfirmed.has(d.hash)) {
                    throw new Error(`Bloco ${block.index}: transação ${d.hash.substring(0, 12)}... já confirmada (replay)`);
                }
            }
        }
    }

    // ============================================
    // ACEITAR BLOCO VINDO DE PEER
    // ============================================
    async acceptBlockFromPeer(blockData) {
        validateBlockShape(blockData);
        return this._withLock(() => this._acceptLocked(blockData, false));
    }

    async _acceptLocked(blockData, fromOrphanPool) {
        validateBlockShape(blockData);
        const block = new Block(blockData);

        if (block.calculateHash() !== block.hash) {
            throw new Error(`Bloco ${block.index}: hash inválido`);
        }
        if (!block.meetsDifficulty(block.difficulty)) {
            throw new Error(`Bloco ${block.index}: PoW inválido (diff=${block.difficulty})`);
        }

        const decision = await decideFork(
            this.chain,
            block.toObject(),
            this._orphanPool,
            (hash) => this.getBlockByHashOrNull(hash)
        );

        if (decision.action === 'reject') {
            throw new Error(`Bloco ${block.index}: ${decision.reason}`);
        }

        if (decision.action === 'orphan') {
            if (!fromOrphanPool) {
                if (!this._orphanPool.some((o) => o.hash === block.hash)) {
                    if (this._orphanPool.length >= CONFIG.maxOrphanPool) this._orphanPool.shift();
                    this._orphanPool.push(decision.block);
                    console.log(`🟡 Órfão guardado: #${block.index} (pool=${this._orphanPool.length})`);
                }
            }
            return { orphan: true, index: block.index };
        }

        if (decision.action === 'append') {
            return await this._appendBlock(decision.block);
        }

        if (decision.action === 'reorg') {
            return await this._reorg(decision.newChain);
        }

        throw new Error(`Ação desconhecida: ${decision.action}`);
    }

    // ============================================
    // ANEXA BLOCO (peer)
    // ============================================
    async _appendBlock(blockData) {
        const block = new Block(blockData);
        const tip = this.getLatestBlock();

        if (!tip || block.previousHash !== tip.hash || block.index !== tip.index + 1) {
            throw new Error(`Bloco ${block.index}: não encaixa no topo da cadeia`);
        }

        this._checkBlockTimestamp(block, tip);

        const expected = await this._expectedDifficulty(
            block.index,
            tip.difficulty,
            (s, e) => this._getRange(s, e)
        );
        if (block.difficulty !== expected) {
            throw new Error(`Bloco ${block.index}: dificuldade ${block.difficulty} diferente da esperada (${expected})`);
        }

        await this._validatePeerTxs(block);

        await this._applyBatch(block.transactions);

        try {
            await BlockModel.create(block.toObject());
        } catch (e) {
            await this._revertTransactions(block.transactions);
            if (e.code === 11000) throw new Error(`Bloco ${block.index}: já existe`);
            throw e;
        }

        await this._markConfirmed(block);
        this._commitToCache(block);
        this._mempoolRemove(new Set(block.transactions.map((t) => t.hash).filter(Boolean)));

        this.emit('block:new', block.toObject());
        console.log(`📥 Bloco ${block.index} aceito da rede (diff=${block.difficulty})`);

        await this._processOrphans().catch((e) =>
            console.error('processOrphans (append):', e.message)
        );

        return block.toObject();
    }

    // ============================================
    // REORG
    // ============================================
    async _reorg(newChain) {
        if (!Array.isArray(newChain) || newChain.length === 0) {
            throw new Error('Reorg rejeitado: cadeia vazia');
        }
        console.log(`🔀 REORG: avaliando cadeia candidata (${newChain.length} blocos)`);

        // Fork point: último bloco da nova cadeia que já está no cache
        const cachedByHash = new Map(this.chain.map((b) => [b.hash, b]));
        let forkBlock = null;
        for (const blk of newChain) {
            const c = cachedByHash.get(blk.hash);
            if (c) forkBlock = c; else break;
        }
        if (!forkBlock) throw new Error('Reorg rejeitado: fork point não encontrado no cache');
        const forkPoint = forkBlock.index;

        const newBlocks = newChain.filter((b) => b.index > forkPoint);
        if (newBlocks.length === 0) throw new Error('Reorg rejeitado: sem blocos novos');

        const revertedBlocks = this.chain.filter((b) => b.index > forkPoint);
        if (revertedBlocks.length > CONFIG.maxReorgDepth) {
            throw new Error(`Reorg rejeitado: profundidade ${revertedBlocks.length} acima do limite (${CONFIG.maxReorgDepth})`);
        }

        const revertedHashes = new Set();
        for (const b of revertedBlocks) {
            for (const t of b.transactions) if (t.hash) revertedHashes.add(t.hash);
        }

        // Faixa de blocos para o retarget: ancestrais comuns (Mongo) + blocos novos
        const loadRange = async (s, e) => {
            const common = s <= forkPoint ? await this._getRange(s, Math.min(e, forkPoint)) : [];
            const fromNew = newBlocks.filter((b) => b.index >= s && b.index <= e);
            return [...common, ...fromNew].sort((a, b) => a.index - b.index);
        };

        // 1) Valida TUDO sem tocar no estado
        let parent = forkBlock;
        let newWork = 0n;
        for (const raw of newBlocks) {
            validateBlockShape(raw);
            const b = new Block(raw);

            if (b.index !== parent.index + 1 || b.previousHash !== parent.hash) {
                throw new Error(`Reorg rejeitado: bloco ${b.index} não é contíguo`);
            }
            if (b.calculateHash() !== b.hash) throw new Error(`Reorg rejeitado: bloco ${b.index} hash inválido`);
            if (!b.meetsDifficulty(b.difficulty)) throw new Error(`Reorg rejeitado: bloco ${b.index} sem PoW válido`);

            this._checkBlockTimestamp(b, parent);

            const expected = await this._expectedDifficulty(b.index, parent.difficulty, loadRange);
            if (b.difficulty !== expected) {
                throw new Error(`Reorg rejeitado: bloco ${b.index} com dificuldade ${b.difficulty} (esperada ${expected})`);
            }

            await this._validatePeerTxs(b, revertedHashes);

            newWork += blockWork(b.difficulty);
            parent = b;
        }

        let oldWork = 0n;
        for (const b of revertedBlocks) oldWork += blockWork(b.difficulty);
        if (newWork <= oldWork) {
            throw new Error('Reorg rejeitado: a nova cadeia não tem mais trabalho acumulado');
        }

        console.log(`🔀 REORG: revertendo ${revertedBlocks.length} bloco(s) a partir de #${forkPoint + 1}`);

        // 2) Reverte a cadeia antiga
        for (const blk of [...revertedBlocks].reverse()) {
            await this._revertTransactions(blk.transactions);
            console.log(`↩️  Revertido bloco #${blk.index} (${blk.transactions.length} TXs)`);
        }
        if (revertedBlocks.length > 0) {
            await BlockModel.deleteMany({ index: { $in: revertedBlocks.map((b) => b.index) } });
        }

        // 3) Aplica a nova cadeia (com rollback se falhar)
        const applied = [];
        try {
            for (const raw of newBlocks) {
                const b = new Block(raw);
                await this._applyBatch(b.transactions);
                try {
                    await BlockModel.create(b.toObject());
                } catch (e) {
                    await this._revertTransactions(b.transactions);
                    throw e;
                }
                await this._markConfirmed(b);
                applied.push(b);
            }
        } catch (err) {
            console.error('❌ Reorg falhou, restaurando cadeia anterior:', err.message);
            await this._rollbackReorg(applied, revertedBlocks);
            throw err;
        }

        // 4) Mempool: devolve o que ficou sem bloco e remove o que entrou
        const newHashes = new Set();
        for (const b of applied) for (const t of b.transactions) if (t.hash) newHashes.add(t.hash);

        const requeue = [];
        for (const old of revertedBlocks) {
            for (const t of old.transactions) {
                if (t.hash && !newHashes.has(t.hash)) requeue.push({ ...t, status: 'pending' });
            }
        }
        if (requeue.length > 0) {
            try {
                await TransactionModel.updateMany(
                    { hash: { $in: requeue.map((t) => t.hash) } },
                    { $set: { status: 'pending', confirmations: 0 }, $unset: { blockIndex: '', blockHash: '' } }
                );
            } catch (e) {
                console.error('❌ Erro ao devolver txs revertidas à mempool:', e.message);
            }
            for (const t of requeue) this._mempoolPush(t);
        }
        this._mempoolRemove(newHashes);

        // 5) Cache, chainwork, dificuldade, órfãos
        this.chain = [...this.chain.filter((b) => b.index <= forkPoint), ...applied];
        if (this.chain.length > this.maxChainCache) this.chain = this.chain.slice(-this.maxChainCache);

        await this._recomputeChainwork();
        this._currentDifficulty = this.getLatestBlock().difficulty;
        this._supplyCache.at = 0;

        const usedHashes = new Set(applied.map((b) => b.hash));
        this._orphanPool = this._orphanPool.filter((o) => !usedHashes.has(o.hash));

        console.log(`✅ Reorg concluída. Altura: ${this.getLatestBlock().index}, chainwork=${this._chainwork}`);

        this.emit('block:new', this.getLatestBlock().toObject());

        await this._processOrphans().catch((e) =>
            console.error('processOrphans (reorg):', e.message)
        );

        return this.getLatestBlock().toObject();
    }

    async _rollbackReorg(applied, revertedBlocks) {
        try {
            for (const b of [...applied].reverse()) {
                await this._revertTransactions(b.transactions);
                await BlockModel.deleteOne({ index: b.index, hash: b.hash }).catch(() => {});
            }

            const appliedHashes = applied.flatMap((b) => b.transactions.map((t) => t.hash)).filter(Boolean);
            if (appliedHashes.length > 0) {
                await TransactionModel.updateMany(
                    { hash: { $in: appliedHashes } },
                    { $set: { status: 'pending', confirmations: 0 }, $unset: { blockIndex: '', blockHash: '' } }
                ).catch(() => {});
            }

            for (const old of revertedBlocks) {
                await this._applyBatch(old.transactions);
                await BlockModel.create(old.toObject());
                await this._markConfirmed(old);
            }
            console.log('↩️  Cadeia anterior restaurada após falha no reorg');
        } catch (e) {
            console.error('🚨 CRÍTICO: rollback do reorg falhou — conferir saldos e blocos manualmente:', e.message);
            this.emit('consistency:error', { message: `rollback do reorg falhou: ${e.message}` });
        }
    }

    // ============================================
    // ÓRFÃOS
    // ============================================
    async _processOrphans() {
        if (this._processingOrphans) return;
        if (this._orphanPool.length === 0) return;

        this._processingOrphans = true;
        try {
            let changed = true;
            let rounds = 0;
            const MAX_ROUNDS = 10;

            while (changed && rounds < MAX_ROUNDS && this._orphanPool.length > 0) {
                changed = false;
                rounds++;

                const snapshot = [...this._orphanPool];   // nunca itera o array que está sendo alterado
                const done = new Set();

                for (const orphan of snapshot) {
                    try {
                        const result = await this._acceptLocked(orphan, true);
                        if (result && !result.orphan) {
                            changed = true;
                            done.add(orphan.hash);
                            console.log(`♻️  Órfão #${orphan.index} reaproveitado`);
                        }
                    } catch (_) {
                        done.add(orphan.hash);   // inválido ou já conhecido: descarta
                    }
                }

                this._orphanPool = this._orphanPool.filter((o) => !done.has(o.hash));
            }
        } finally {
            this._processingOrphans = false;
        }
    }

    // ============================================
    // CONSULTAS
    // ============================================
    getLatestBlock() {
        if (this.chain.length === 0) return null;
        return this.chain[this.chain.length - 1];
    }

    async getBlockByIndex(index) {
        if (!Number.isSafeInteger(index) || index < 0) throw new Error('Índice inválido');
        const cached = this.chain.find((b) => b.index === index);
        if (cached) return cached;
        const block = await BlockModel.findOne({ index }).lean();
        if (!block) throw new Error('Bloco não encontrado');
        return block;
    }

    async getBlockByHash(hash) {
        if (!isHash64(hash)) throw new Error('Hash inválido');
        const block = await BlockModel.findOne({ hash }).lean();
        if (!block) throw new Error('Bloco não encontrado');
        return block;
    }

    async getBlocks(limit = 20, offset = 0) {
        const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 200);
        const off = Math.min(Math.max(Number.parseInt(offset, 10) || 0, 0), 1_000_000);
        return BlockModel.find().sort({ index: -1 }).skip(off).limit(lim).lean();
    }

    async getChainInfo() {
        const latest = await BlockModel.findOne().sort({ index: -1 }).lean();

        return {
            totalBlocks: latest ? latest.index + 1 : 0,
            cachedBlocks: this.chain.length,
            difficulty: this._currentDifficulty,
            baseDifficulty: CONFIG.difficulty,
            chainwork: this._chainwork.toString(),
            orphanPoolSize: this._orphanPool.length,
            blockReward: CONFIG.blockReward.toString(),
            pendingTransactions: this.pendingTransactions.length,
            latestBlock: latest ? {
                index: latest.index,
                hash: latest.hash,
                timestamp: latest.timestamp,
                difficulty: latest.difficulty,
                transactionsCount: (latest.transactions || []).length
            } : null,
            isValid: await this.isValid()
        };
    }

    // ============================================
    // VALIDAÇÃO DO CACHE (resultado guardado por 10s por topo de cadeia)
    // ============================================
    async isValid() {
        const tip = this.getLatestBlock();
        const key = tip ? tip.hash : 'empty';
        const now = Date.now();
        if (this._validCache.key === key && now - this._validCache.at < 10_000) {
            return this._validCache.value;
        }

        let valid = true;
        for (let i = 1; i < this.chain.length; i++) {
            const current = this.chain[i];
            const previous = this.chain[i - 1];

            if (current.calculateHash() !== current.hash) {
                console.log(`❌ Bloco ${current.index}: hash inválido`);
                valid = false;
                break;
            }
            if (current.previousHash !== previous.hash) {
                console.log(`❌ Bloco ${current.index}: link quebrado`);
                valid = false;
                break;
            }
            if (!current.meetsDifficulty(current.difficulty || CONFIG.difficulty)) {
                console.log(`❌ Bloco ${current.index}: PoW inválido`);
                valid = false;
                break;
            }
        }

        this._validCache = { key, value: valid, at: now };
        return valid;
    }

    // ============================================
    // 🪙 TOKENS — aplicação de estado
    // ============================================
    async _applyTokenCreate(tx) {
        const TokenModel = require('./models/Token');

        if (!tx.fromAddress) throw new Error('Criador do token ausente');
        validateTokenData('token_create', tx.tokenData);

        const existing = await TokenModel.findOne({ txHash: tx.hash });
        if (existing) {
            if (existing.status !== 'active') {
                existing.status = 'active';
                await existing.save();
            }
            return existing;
        }

        const symbolUpper = String(tx.tokenData.symbol || '').toUpperCase();
        const symbolTaken = await TokenModel.findOne({ symbol: symbolUpper });
        if (symbolTaken) {
            throw new Error(`Símbolo ${symbolUpper} já existe`);
        }

        const tokenId = 'BRAD_' + crypto.randomBytes(16).toString('hex');
        const supply = Decimal128.fromString(String(tx.tokenData.supply));   // (antes usava mongoose.Schema.Types, que não tem fromString)

        const token = await TokenModel.create({
            tokenId,
            name: String(tx.tokenData.name).trim(),
            symbol: symbolUpper,
            totalSupply: supply,
            decimals: Number.parseInt(tx.tokenData.decimals, 10) || 0,
            creator: tx.fromAddress,
            txHash: tx.hash,
            logo: tx.tokenData.logo || null,
            status: 'active',
            balances: [{ address: tx.fromAddress, amount: supply }]
        });

        if (global.io) global.io.emit('token:created', token.toPublic());
        console.log(`🪙 Token criado: ${token.symbol} (${token.tokenId}) por ${tx.fromAddress}`);
        return token;
    }

    async _applyTokenTransfer(tx) {
        const TokenModel = require('./models/Token');

        validateTokenData('token_transfer', tx.tokenData);
        if (!tx.fromAddress || tx.fromAddress === tx.toAddress) throw new Error('Transferência de token inválida');

        const token = await TokenModel.findOne({ tokenId: tx.tokenData.tokenId });
        if (!token) throw new Error(`Token ${tx.tokenData.tokenId} não encontrado`);
        if (token.status !== 'active') throw new Error(`Token ${token.symbol} congelado`);

        const amountNum = Number.parseFloat(tx.tokenData.amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) throw new Error('Quantidade de token inválida');

        const fromBal = token.getBalance(tx.fromAddress);
        if (fromBal < amountNum) {
            throw new Error(`Saldo de ${token.symbol} insuficiente: ${fromBal} < ${amountNum}`);
        }

        token.setBalance(tx.fromAddress, fromBal - amountNum);
        token.setBalance(tx.toAddress, token.getBalance(tx.toAddress) + amountNum);
        await token.save();

        if (global.io) {
            global.io.emit('token:transferred', {
                tokenId: token.tokenId,
                symbol: token.symbol,
                from: tx.fromAddress,
                to: tx.toAddress,
                amount: amountNum,
                txHash: tx.hash
            });
        }
        console.log(`🪙 Token transferido: ${amountNum} ${token.symbol}`);
        return token;
    }

    async _revertTokenCreate(tx) {
        const TokenModel = require('./models/Token');
        const deleted = await TokenModel.deleteOne({ txHash: tx.hash });
        if (deleted.deletedCount > 0) {
            console.log(`↩️  Token revertido: txHash=${String(tx.hash).substring(0, 12)}...`);
            if (global.io) global.io.emit('token:reverted', { txHash: tx.hash });
        }
    }

    async _revertTokenTransfer(tx) {
        const TokenModel = require('./models/Token');
        if (!tx.tokenData || !TOKEN_ID_RE.test(String(tx.tokenData.tokenId))) return;

        const token = await TokenModel.findOne({ tokenId: tx.tokenData.tokenId });
        if (!token) {
            console.warn(`⚠️  Revertendo transferência de token inexistente: ${tx.tokenData.tokenId}`);
            return;
        }

        const amountNum = Number.parseFloat(tx.tokenData.amount);
        const toBal = token.getBalance(tx.toAddress);
        if (toBal < amountNum) {
            throw new Error(`Revert: saldo insuficiente em ${tx.toAddress} para ${amountNum} ${token.symbol}`);
        }

        token.setBalance(tx.toAddress, toBal - amountNum);
        token.setBalance(tx.fromAddress, token.getBalance(tx.fromAddress) + amountNum);
        await token.save();

        if (global.io) {
            global.io.emit('token:reverted', {
                tokenId: token.tokenId,
                symbol: token.symbol,
                from: tx.fromAddress,
                to: tx.toAddress,
                amount: amountNum,
                txHash: tx.hash
            });
        }
        console.log(`↩️  Transferência de token revertida: ${amountNum} ${token.symbol}`);
    }

    // ============================================
    // LIMPEZA
    // ============================================
    // Mantém a API síncrona; marca no Mongo em segundo plano para a mempool
    // não "ressuscitar" no próximo restart
    clearPendingTransactions() {
        const hashes = this.pendingTransactions.map((t) => t.hash).filter(Boolean);
        const count = this.pendingTransactions.length;
        this._mempoolSet([]);

        if (hashes.length > 0) {
            TransactionModel.updateMany(
                { hash: { $in: hashes }, status: 'pending' },
                { $set: { status: 'failed', 'metadata.reason': 'mempool_cleared' } }
            ).catch((e) => console.error('❌ Erro ao limpar pendentes no Mongo:', e.message));
        }
        return { message: 'Mempool limpa', count };
    }

    getPendingTransactions(limit = 100) {
        const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 1000);
        return this.pendingTransactions.slice(0, lim);
    }
}

// ============================================
// EXPORTA INSTÂNCIA ÚNICA
// ============================================
module.exports = new Blockchain();
module.exports.CONFIG = CONFIG;
module.exports.Block = Block;
module.exports.normalizeTx = normalizeTx;
module.exports.computeTxHash = computeTxHash;
module.exports.STAKE_POOL_ADDRESS = STAKE_POOL_ADDRESS;
