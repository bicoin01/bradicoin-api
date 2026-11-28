// explorer.js
// ============================================
// Bradicoin Blockchain - Explorer (somente leitura) v2.0
// ============================================
// 🔧 v2.0 (sobre a v1):
//   [1] Lê do MongoDB (chain inteira), não do cache de 100 blocos do blockchain.js:
//       altura, contagens, endereços e supply agora são reais
//   [2] Bugs que quebravam: getRichList chamava blockchain.getBalance (não existe),
//       isValid() era usado sem await (sempre "true"), difficulty/miningReward
//       apontavam para propriedades inexistentes
//   [3] Entradas validadas (hash 64 hex, endereço, índice, limit/offset) com
//       AppError 400/404 — antes era Error genérico (500) e aceitava objetos
//       (injeção NoSQL)
//   [4] Privacidade: não expõe username, metadata (userId, orderId, valores em
//       USD), assinatura nem chave pública; logo de token fica de fora
//   [5] calculateTotalSupply continua SÍNCRONO (o server.js chama sem await):
//       devolve o último valor em cache e atualiza em segundo plano
//   [6] Valores somados em BigInt (8 casas) e devolvidos também como string exata
//   [7] Consultas paginadas no banco, com teto de limit/offset e cache com
//       deduplicação (nada de varrer a chain em memória a cada requisição)
//   [8] Busca só consulta o que o formato da entrada indica
// ============================================

'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const blockchain = require('./blockchain');
const wallet = require('./wallet');
const staking = require('./staking');
const WalletModel = require('./models/Wallet');
const BlockModel = require('./models/Block');
const TransactionModel = require('./models/Transaction');
const { AppError } = require('./middleware/error');

// ============================================
// CONSTANTES
// ============================================
const SCALE = 8;
const UNIT = 10n ** BigInt(SCALE);
const MAX_PAGE = 100;
const MAX_OFFSET = 1_000_000;
const MAX_TXS_IN_BLOCK_VIEW = 25;
const SUPPLY_TTL_MS = 10_000;
const RICH_THRESHOLD_UNITS = 10_000n * UNIT;

const STAKE_POOL_ADDRESS = blockchain.STAKE_POOL_ADDRESS || 'BrSTAKEPOOL000000000000000000000000000000';

// ============================================
// VALORES EXATOS
// ============================================
function fromUnits(units) {
    const neg = units < 0n;
    const u = neg ? -units : units;
    const int = (u / UNIT).toString();
    const frac = (u % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
    return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

// Decimal128 / string / número → unidades (aceita notação científica; valor ruim vira 0)
function unitsOf(value) {
    if (value === null || value === undefined) return 0n;
    const s = typeof value === 'number' && Number.isFinite(value)
        ? value.toFixed(SCALE)
        : String(value).trim();
    if (s.length > 64) return 0n;

    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) return 0n;
    const [, sign, int, frac = '', exp = '0'] = m;
    const e = Number(exp);
    if (Math.abs(e) > 40) return 0n;

    const shift = SCALE - (frac.length - e);
    let n = BigInt(int + frac);
    n = shift >= 0 ? n * 10n ** BigInt(shift) : n / 10n ** BigInt(-shift);
    return sign ? -n : n;
}

const decimalString = (value) => fromUnits(unitsOf(value));
const toNumber = (value) => Number(decimalString(value));

// ============================================
// VALIDAÇÃO DE ENTRADA
// ============================================
function intParam(value, def, min, max) {
    const raw = Array.isArray(value) ? value[0] : value;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(n, min), max);
}

function normalizeHash(hash) {
    if (typeof hash !== 'string') throw new AppError('Hash inválido', 400);
    const h = hash.trim().replace(/^0x/i, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(h)) throw new AppError('Hash inválido', 400);
    return h;
}

function normalizeAddr(address) {
    if (typeof address !== 'string' || !address.trim() || address.length > 128) {
        throw new AppError('Endereço inválido', 400);
    }
    const trimmed = address.trim();
    if (trimmed === STAKE_POOL_ADDRESS) return trimmed;   // endereço de sistema (pool de staking)

    const normalized = wallet.normalizeAddress(trimmed);
    if (!wallet.isValidAddress(normalized)) throw new AppError('Endereço inválido', 400);
    return normalized;
}

// Só engole "não encontrado/inválido"; erro de banco continua subindo
async function soft(fn) {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof AppError) return null;
        throw err;
    }
}

// ============================================
// CACHE COM DEDUPLICAÇÃO
// ============================================
const _cache = new Map();
const _inflight = new Map();

async function cached(key, ttlMs, fn) {
    const now = Date.now();
    const hit = _cache.get(key);
    if (hit && hit.expires > now) return hit.value;
    if (_inflight.has(key)) return _inflight.get(key);

    const promise = (async () => {
        try {
            const value = await fn();
            _cache.set(key, { value, expires: Date.now() + ttlMs });
            return value;
        } finally {
            _inflight.delete(key);
        }
    })();

    _inflight.set(key, promise);
    return promise;
}

// ============================================
// ÍNDICES (criados uma vez, sem derrubar o explorer se falhar)
// ============================================
let _indexesPromise = null;

function ensureIndexes() {
    if (process.env.EXPLORER_ENSURE_INDEXES === 'false') return Promise.resolve();
    if (!_indexesPromise) {
        _indexesPromise = (async () => {
            const specs = [
                [{ status: 1, timestamp: -1 }, { name: 'explorer_status_timestamp' }],
                [{ blockIndex: 1 }, { name: 'explorer_blockIndex' }]
            ];
            for (const [spec, opts] of specs) {
                try {
                    await TransactionModel.collection.createIndex(spec, { background: true, ...opts });
                } catch (e) {
                    console.warn(`⚠️ Explorer: índice ${JSON.stringify(spec)} não criado: ${e.message}`);
                }
            }
        })();
    }
    return _indexesPromise;
}

// ============================================
// ALTURA DA CHAIN
// ============================================
async function getChainTip() {
    return cached('tip', 2000, async () => {
        const latest = await BlockModel.findOne()
            .sort({ index: -1 })
            .select('index hash timestamp difficulty')
            .lean();
        return { height: latest ? latest.index + 1 : 0, latest: latest || null };
    });
}

// ============================================
// SUPPLY TOTAL
// Definição: soma dos saldos de todas as carteiras (inclui reserva e pool de staking).
// É a mesma medida usada pelo teto de emissão do blockchain.js.
// ============================================
const supplyState = { units: null, at: 0, loading: null };

async function refreshSupply() {
    if (supplyState.loading) return supplyState.loading;

    supplyState.loading = (async () => {
        try {
            const [agg] = await WalletModel.aggregate([{
                $group: {
                    _id: null,
                    total: { $sum: { $convert: { input: '$balance', to: 'decimal', onError: 0, onNull: 0 } } }
                }
            }]);
            supplyState.units = agg && agg.total !== undefined && agg.total !== null
                ? unitsOf(agg.total.toString())
                : 0n;
            supplyState.at = Date.now();
            return supplyState.units;
        } finally {
            supplyState.loading = null;
        }
    })();

    return supplyState.loading;
}

// Versão assíncrona: sempre devolve valor fresco (string exata)
async function getTotalSupply() {
    if (supplyState.units === null || Date.now() - supplyState.at > SUPPLY_TTL_MS) {
        await refreshSupply();
    }
    return fromUnits(supplyState.units);
}

// Versão SÍNCRONA (o server.js chama sem await): devolve o último valor conhecido
// e dispara a atualização em segundo plano quando o cache vence.
function calculateTotalSupply() {
    if (supplyState.units === null || Date.now() - supplyState.at > SUPPLY_TTL_MS) {
        refreshSupply().catch((e) => console.error('❌ Explorer: erro ao atualizar supply:', e.message));
    }
    return supplyState.units === null ? 0 : Number(fromUnits(supplyState.units));
}

// Novo bloco → supply pode ter mudado
if (typeof blockchain.on === 'function') {
    blockchain.on('block:new', () => { supplyState.at = 0; });
}

// Aquece o cache assim que o Mongo conectar
if (mongoose.connection.readyState === 1) {
    refreshSupply().catch(() => {});
} else {
    mongoose.connection.once('connected', () => { refreshSupply().catch(() => {}); });
}

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    await ensureIndexes();
    await refreshSupply().catch(() => {});
    console.log('✅ Explorer inicializado');
}

// ============================================
// FORMATAÇÃO
// ============================================
function legacyTxId(tx) {
    if (tx.hash) return tx.hash;
    const canonical = `${tx.fromAddress || 'null'}|${tx.toAddress || 'null'}|${tx.amount}|${tx.timestamp}|${tx.type || 'transfer'}`;
    return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 32);
}

// tokenData sem a logo (pode ter centenas de KB em base64)
function publicTokenData(td) {
    if (!td || typeof td !== 'object') return null;
    const out = {};
    for (const key of ['tokenId', 'name', 'symbol', 'supply', 'decimals', 'amount']) {
        if (td[key] !== undefined && td[key] !== null) out[key] = String(td[key]).slice(0, 100);
    }
    return Object.keys(out).length ? out : null;
}

// Transação que está dentro de um bloco (sem assinatura, chave pública ou metadata)
function formatBlockTx(tx) {
    return {
        id: legacyTxId(tx),
        hash: tx.hash || null,
        fromAddress: tx.fromAddress || 'COINBASE',
        toAddress: tx.toAddress,
        amount: toNumber(tx.amount),
        amountStr: decimalString(tx.amount),
        fee: toNumber(tx.fee),
        feeStr: decimalString(tx.fee),
        type: tx.type || 'transfer',
        timestamp: tx.timestamp || null,
        tokenData: publicTokenData(tx.tokenData)
    };
}

function formatBlock(block, height) {
    const all = Array.isArray(block.transactions) ? block.transactions : [];

    let totalUnits = 0n;
    for (const tx of all) totalUnits += unitsOf(tx.amount);

    return {
        index: block.index,
        hash: block.hash,
        previousHash: block.previousHash,
        timestamp: block.timestamp,
        transactionsCount: all.length,
        transactions: all.slice(0, MAX_TXS_IN_BLOCK_VIEW).map(formatBlockTx),
        hasMoreTransactions: all.length > MAX_TXS_IN_BLOCK_VIEW,
        totalAmount: Number(fromUnits(totalUnits)),
        totalAmountStr: fromUnits(totalUnits),
        nonce: block.nonce,
        difficulty: block.difficulty,
        minerAddress: block.minerAddress || null,
        confirmations: Math.max(1, height - block.index),
        isGenesis: block.index === 0
    };
}

// Transação gravada no Mongo
function formatDbTx(tx, height, forAddress) {
    const confirmed = tx.status === 'confirmed' && Number.isSafeInteger(tx.blockIndex);
    const out = {
        id: tx.hash,
        hash: tx.hash,
        blockIndex: Number.isSafeInteger(tx.blockIndex) ? tx.blockIndex : null,
        blockHash: tx.blockHash || null,
        confirmations: confirmed ? Math.max(1, height - tx.blockIndex) : 0,
        fromAddress: tx.from || 'COINBASE',
        toAddress: tx.to,
        amount: toNumber(tx.amount),
        amountStr: decimalString(tx.amount),
        fee: toNumber(tx.fee),
        feeStr: decimalString(tx.fee),
        type: tx.type || 'transfer',
        nonce: tx.nonce ?? 0,
        status: tx.status,
        timestamp: tx.timestamp || null
    };
    if (forAddress) out.direction = tx.from === forAddress ? 'SENT' : 'RECEIVED';
    return out;
}

const TX_FIELDS = 'hash from to amount fee nonce type status blockIndex blockHash timestamp';

// Saldo sem expor chave pública, nonce ou userId
async function balanceOf(address) {
    try {
        if (address !== STAKE_POOL_ADDRESS) {
            const info = await wallet.getBalance(address);
            return {
                balance: info.balance || '0',
                pending: info.pending || '0',
                total: info.total || '0'
            };
        }
    } catch (_) { /* cai no acesso direto */ }

    const doc = await WalletModel.findOne({ address }).select('balance').lean();
    const bal = decimalString(doc ? doc.balance : 0);
    return { balance: bal, pending: '0', total: bal };
}

// ============================================
// RESUMO GERAL DA CHAIN
// ============================================
async function getConfirmedTxCount() {
    await ensureIndexes();
    return cached('tx:confirmed-count', 15_000, () => TransactionModel.countDocuments({ status: 'confirmed' }));
}

async function getBlockchainSummary() {
    const [{ height, latest }, totalTransactions, isChainValid] = await Promise.all([
        getChainTip(),
        getConfirmedTxCount(),
        blockchain.isValid()
    ]);

    return {
        chainName: 'Bradicoin',
        symbol: 'BRD',
        blockHeight: height,
        latestBlockHash: latest ? latest.hash : null,
        latestBlockTimestamp: latest ? latest.timestamp : null,
        totalTransactions,
        miningDifficulty: blockchain.getCurrentDifficulty(),
        miningReward: toNumber(blockchain.CONFIG && blockchain.CONFIG.blockReward),
        isChainValid,
        totalSupply: calculateTotalSupply(),
        lastUpdated: new Date().toISOString()
    };
}

// ============================================
// BLOCOS PAGINADOS
// ============================================
async function getBlocks(limit = 20, offset = 0) {
    const lim = intParam(limit, 20, 1, MAX_PAGE);
    const off = intParam(offset, 0, 0, MAX_OFFSET);
    const { height } = await getChainTip();

    // $size evita trazer o corpo de todas as transações só para contar
    const rows = await BlockModel.aggregate([
        { $sort: { index: -1 } },
        { $skip: off },
        { $limit: lim },
        {
            $project: {
                _id: 0,
                index: 1,
                hash: 1,
                previousHash: 1,
                timestamp: 1,
                nonce: 1,
                difficulty: 1,
                minerAddress: 1,
                transactionsCount: { $size: { $ifNull: ['$transactions', []] } }
            }
        }
    ]);

    return {
        totalBlocks: height,
        limit: lim,
        offset: off,
        blocks: rows.map((b) => ({ ...b, isGenesis: b.index === 0 }))
    };
}

// ============================================
// BLOCO POR ÍNDICE / HASH
// ============================================
async function getBlockByIndex(index) {
    const n = typeof index === 'string' && /^\d{1,12}$/.test(index) ? Number(index) : index;
    if (!Number.isSafeInteger(n) || n < 0) throw new AppError('Índice de bloco inválido', 400);

    const [block, { height }] = await Promise.all([
        BlockModel.findOne({ index: n }).lean(),
        getChainTip()
    ]);
    if (!block) throw new AppError('Bloco não encontrado', 404);
    return formatBlock(block, height);
}

async function getBlockByHash(hash) {
    const h = normalizeHash(hash);
    const [block, { height }] = await Promise.all([
        BlockModel.findOne({ hash: h }).lean(),
        getChainTip()
    ]);
    if (!block) throw new AppError('Bloco não encontrado', 404);
    return formatBlock(block, height);
}

// ============================================
// TRANSAÇÃO POR HASH
// ============================================
async function getTransaction(hash) {
    const h = normalizeHash(hash);
    const [doc, { height }] = await Promise.all([
        TransactionModel.findOne({ hash: h }).select(TX_FIELDS).lean(),
        getChainTip()
    ]);
    if (!doc) throw new AppError('Transação não encontrada', 404);
    return formatDbTx(doc, height);
}

// ============================================
// TRANSAÇÕES DE UM ENDEREÇO
// ============================================
async function getAddressTransactions(address, limit = 50, offset = 0) {
    const addr = normalizeAddr(address);
    const lim = intParam(limit, 50, 1, MAX_PAGE);
    const off = intParam(offset, 0, 0, 100_000);

    const query = { status: 'confirmed', $or: [{ from: addr }, { to: addr }] };

    const [docs, total, { height }, bal] = await Promise.all([
        TransactionModel.find(query).sort({ timestamp: -1 }).skip(off).limit(lim).select(TX_FIELDS).lean(),
        TransactionModel.countDocuments(query),
        getChainTip(),
        balanceOf(addr)
    ]);

    return {
        address: addr,
        balance: bal.balance,
        pending: bal.pending,
        total: bal.total,
        totalTransactions: total,
        limit: lim,
        offset: off,
        hasMore: off + lim < total,
        transactions: docs.map((d) => formatDbTx(d, height, addr))
    };
}

// ============================================
// RESUMO DE ENDEREÇO
// ============================================
async function getAddressSummary(address) {
    const addr = normalizeAddr(address);

    const [bal, [agg], stakingInfo] = await Promise.all([
        balanceOf(addr),
        TransactionModel.aggregate([
            { $match: { status: 'confirmed', $or: [{ from: addr }, { to: addr }] } },
            {
                $group: {
                    _id: null,
                    sent: {
                        $sum: {
                            $cond: [
                                { $eq: ['$from', { $literal: addr }] },
                                { $convert: { input: '$amount', to: 'decimal', onError: 0, onNull: 0 } },
                                0
                            ]
                        }
                    },
                    received: {
                        $sum: {
                            $cond: [
                                { $eq: ['$to', { $literal: addr }] },
                                { $convert: { input: '$amount', to: 'decimal', onError: 0, onNull: 0 } },
                                0
                            ]
                        }
                    },
                    count: { $sum: 1 },
                    firstSeen: { $min: '$timestamp' }
                }
            }
        ]),
        addr === STAKE_POOL_ADDRESS ? null : staking.getStake(addr).catch(() => null)
    ]);

    const sent = agg ? decimalString(agg.sent) : '0';
    const received = agg ? decimalString(agg.received) : '0';
    const staked = stakingInfo ? Number(stakingInfo.staked) || 0 : 0;

    return {
        address: addr,
        balance: bal.balance,
        pending: bal.pending,
        total: bal.total,
        totalSent: Number(sent),
        totalSentStr: sent,
        totalReceived: Number(received),
        totalReceivedStr: received,
        transactionsCount: agg ? agg.count : 0,
        firstSeen: agg && agg.firstSeen ? agg.firstSeen : null,
        hasStake: staked > 0,
        stakedAmount: staked,
        isRich: unitsOf(bal.balance) > RICH_THRESHOLD_UNITS
    };
}

// ============================================
// RICH LIST (top holders) — ordenada e somada no banco
// ============================================
function addressLabels() {
    const labels = new Map([[STAKE_POOL_ADDRESS, 'Staking Pool']]);
    if (blockchain.CONFIG && blockchain.CONFIG.feeCollectorAddress) {
        labels.set(blockchain.CONFIG.feeCollectorAddress, 'Fee Collector');
    }
    if (process.env.RESERVE_ADDRESS) {
        labels.set(wallet.normalizeAddress(process.env.RESERVE_ADDRESS), 'Reserve');
    }
    return labels;
}

async function getRichList(limit = 100) {
    const lim = intParam(limit, 100, 1, 500);

    const [res] = await WalletModel.aggregate([
        { $addFields: { _bal: { $convert: { input: '$balance', to: 'decimal', onError: 0, onNull: 0 } } } },
        { $match: { _bal: { $gt: 0 } } },
        {
            $facet: {
                top: [
                    { $sort: { _bal: -1 } },
                    { $limit: lim },
                    { $project: { _id: 0, address: 1, balance: { $toString: '$_bal' } } }
                ],
                totals: [
                    { $group: { _id: null, wallets: { $sum: 1 }, total: { $sum: '$_bal' } } }
                ]
            }
        }
    ]);

    const top = (res && res.top) || [];
    const totals = res && res.totals && res.totals[0];
    const totalUnits = totals && totals.total !== undefined && totals.total !== null
        ? unitsOf(totals.total.toString())
        : 0n;

    // percentual com 2 casas, sem float intermediário
    const pct = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : 0);

    // percentual do supply máximo já emitido
    let maxUnits = 0n;
    try { maxUnits = unitsOf(process.env.MAX_SUPPLY); } catch (_) { maxUnits = 0n; }

    const labels = addressLabels();

    return {
        totalWallets: totals ? totals.wallets : 0,        // carteiras com saldo > 0
        totalBalance: Number(fromUnits(totalUnits)),
        totalBalanceStr: fromUnits(totalUnits),
        totalSupply: Number(fromUnits(totalUnits)),
        maxSupply: maxUnits > 0n ? Number(fromUnits(maxUnits)) : null,
        percentageOfSupply: maxUnits > 0n ? pct(totalUnits, maxUnits) : null,   // % do supply máximo já emitido
        limit: lim,
        holders: top.map((w, i) => {
            const units = unitsOf(w.balance);
            return {
                rank: i + 1,
                address: w.address,
                label: labels.get(w.address) || null,
                balance: Number(fromUnits(units)),
                balanceStr: fromUnits(units),
                percentage: pct(units, totalUnits)
            };
        })
    };
}

// ============================================
// ÚLTIMAS TRANSAÇÕES
// ============================================
async function getLatestTransactions(limit = 20) {
    const lim = intParam(limit, 20, 1, MAX_PAGE);
    await ensureIndexes();

    const [docs, { height }, total] = await Promise.all([
        TransactionModel.find({ status: 'confirmed' }).sort({ timestamp: -1 }).limit(lim).select(TX_FIELDS).lean(),
        getChainTip(),
        getConfirmedTxCount()
    ]);

    return {
        totalTransactions: total,
        limit: lim,
        transactions: docs.map((d) => formatDbTx(d, height))
    };
}

// ============================================
// TOTAL DE TRANSAÇÕES (agora assíncrono)
// ============================================
async function getTotalTransactionCount() {
    return getConfirmedTxCount();
}

// ============================================
// BUSCA — só consulta o que o formato da entrada indica
// ============================================
async function search(query) {
    if (typeof query !== 'string') throw new AppError('Busca inválida', 400);
    const q = query.trim();
    if (!q || q.length > 130) throw new AppError('Busca inválida', 400);

    const results = { blocks: [], transactions: [], addresses: [] };

    // Número → bloco por índice
    if (/^\d{1,12}$/.test(q)) {
        const block = await soft(() => getBlockByIndex(Number(q)));
        if (block) results.blocks.push({ index: block.index, hash: block.hash });
    }

    // 64 hex → hash de bloco e/ou de transação
    if (/^(0x)?[a-fA-F0-9]{64}$/.test(q)) {
        const [block, tx] = await Promise.all([
            soft(() => getBlockByHash(q)),
            soft(() => getTransaction(q))
        ]);
        if (block) results.blocks.push({ index: block.index, hash: block.hash });
        if (tx) {
            results.transactions.push({ id: tx.id, fromAddress: tx.fromAddress, toAddress: tx.toAddress });
        }
    }

    // Br... → endereço
    if (/^br/i.test(q)) {
        const summary = await soft(() => getAddressSummary(q));
        if (summary) results.addresses.push({ address: summary.address, balance: summary.balance });
    }

    return {
        query: q,
        results,
        totalResults: results.blocks.length + results.transactions.length + results.addresses.length,
        timestamp: new Date().toISOString()
    };
}

// ============================================
// ESTATÍSTICAS DE REDE
// ============================================
async function getNetworkStats() {
    const [{ height, latest }, totalTransactions, isChainValid, recent] = await Promise.all([
        getChainTip(),
        getConfirmedTxCount(),
        blockchain.isValid(),
        cached('recent-blocks', 5000, () =>
            BlockModel.find().sort({ index: -1 }).limit(11).select('index timestamp').lean())
    ]);

    let avgBlockTime = 0;
    const times = recent
        .map((b) => new Date(b.timestamp).getTime())
        .filter(Number.isFinite)
        .sort((a, b) => b - a);
    if (times.length >= 2) {
        let sum = 0;
        for (let i = 1; i < times.length; i++) sum += times[i - 1] - times[i];
        avgBlockTime = sum / (times.length - 1) / 1000;
    }

    return {
        network: 'Bradicoin Mainnet',
        symbol: 'BRD',
        blockHeight: height,
        latestBlockHash: latest ? latest.hash : null,
        latestBlockTimestamp: latest ? latest.timestamp : null,
        miningDifficulty: blockchain.getCurrentDifficulty(),
        miningReward: toNumber(blockchain.CONFIG && blockchain.CONFIG.blockReward),
        averageBlockTimeSeconds: Math.round(avgBlockTime),
        totalTransactions,
        pendingTransactions: Array.isArray(blockchain.pendingTransactions) ? blockchain.pendingTransactions.length : 0,
        totalSupply: calculateTotalSupply(),
        activeNodes: 1,
        isSynced: isChainValid,
        lastUpdated: new Date().toISOString()
    };
}

// ============================================
// EXPORTA (funções, não classe!)
// ============================================
module.exports = {
    initialize,
    getBlocks,
    getBlockByIndex,
    getBlockByHash,
    getBlockchainSummary,
    getTransaction,
    getAddressTransactions,
    getAddressSummary,
    getRichList,
    getLatestTransactions,
    getNetworkStats,
    search,
    calculateTotalSupply,       // síncrono (cache) — usado pelo server.js
    getTotalSupply,             // assíncrono, valor fresco
    refreshSupply,
    getTotalTransactionCount
};
