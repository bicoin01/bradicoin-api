// server.js
// ============================================
// BradiChain - Servidor Principal (v4.3)
// ============================================
// v4.3 — revisão de segurança e estabilidade:
//   [1] /api/validator/* usa o módulo validator.js real (antes usava um model
//       inexistente e devolvia sucesso falso com uptime/comissão inventados)
//   [2] Todas as rotas /api/v1/admin/* exigem admin em um único ponto
//   [3] Validação de entrada (números, endereços, limit/offset) em todas as rotas
//   [4] Cache com deduplicação (sem "estouro" no Mongo quando o cache expira)
//   [5] Limite de conexões WebSocket por IP e de tamanho de mensagem
//   [6] Rate limit de login/registro e do /buy; GET não conta no txLimiter
//   [7] Checkpoint sem duplicar; timers limpos no shutdown; shutdown idempotente
//   [8] /health/defense só para admin; /health/detailed sem versão/ambiente em produção
//   [9] BUY_MASTER_SEED validado ANTES de montar as rotas de /buy
//   [10] validator.initialize() agora é chamado no boot
// ============================================

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

// ============================================
// VALIDAÇÃO DE VARIÁVEIS DE AMBIENTE
// ============================================
const REQUIRED_ENV = [
    'MONGODB_URI',
    'JWT_SECRET',
    'RESERVE_ADDRESS',
    'FEE_COLLECTOR_ADDRESS',
    'MAX_SUPPLY',
    'BUY_MASTER_SEED'
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ Variáveis de ambiente obrigatórias faltando: ${missingEnv.join(', ')}`);
    console.error('📄 Copie .env.example para .env e preencha os valores.');
    process.exit(1);
}

if (!process.env.MONGODB_URI.startsWith('mongodb')) {
    console.error('❌ MONGODB_URI inválida. Deve começar com "mongodb://" ou "mongodb+srv://".');
    process.exit(1);
}

if (process.env.JWT_SECRET.length < 32) {
    console.error('❌ JWT_SECRET muito curto. Use pelo menos 32 caracteres.');
    process.exit(1);
}

const MAX_SUPPLY = Number.parseFloat(process.env.MAX_SUPPLY);
if (!Number.isFinite(MAX_SUPPLY) || MAX_SUPPLY <= 0) {
    console.error('❌ MAX_SUPPLY inválido (deve ser um número maior que zero).');
    process.exit(1);
}

// ============================================
// IMPORTAÇÕES LOCAIS
// ============================================
const blockchain = require('./blockchain');
const wallet = require('./wallet');
const transactions = require('./transactions');
const validatorModule = require('./validator');
const staking = require('./staking');
const explorer = require('./explorer');
const { logger } = require('./middleware/error');

for (const key of ['RESERVE_ADDRESS', 'FEE_COLLECTOR_ADDRESS']) {
    if (!wallet.isValidAddress(process.env[key])) {
        console.error(`❌ ${key} não é um endereço válido.`);
        process.exit(1);
    }
}
const RESERVE_ADDRESS = wallet.normalizeAddress(process.env.RESERVE_ADDRESS);

// 🛡️ Módulos de defesa de consenso
const ConsecutiveBlockGuard = require('./consensus/consecutiveBlockGuard');
const DynamicDifficulty = require('./consensus/dynamicDifficulty');
const ReorgDetector = require('./consensus/reorgDetector');
const WeakSubjectivity = require('./consensus/weakSubjectivity');
const TimestampService = require('./consensus/timestampService');

// Models
const User = require('./models/User');
const WalletModel = require('./models/Wallet');
const TransactionModel = require('./models/Transaction');
const BlockModel = require('./models/Block');

// Middlewares
const { authenticate, requireAdmin } = require('./middleware/auth');
const { errorHandler, notFoundHandler, asyncHandler, AppError } = require('./middleware/error');

// Routes
const authRoutes = require('./routes/auth');
const transactionRoutes = require('./routes/transaction');
const walletRoutes = require('./routes/wallet');
const reserveRoutes = require('./routes/reserve');
const reserveStakingRoutes = require('./routes/reserveStaking');
const tokenRoutes = require('./routes/token');
const nftRoutes = require('./routes/nft');
const { router: airdropRouter } = require('./routes/airdrop');
const { router: adminAirdropRouter } = require('./routes/adminAirdrop');
const governanceRoutes = require('./routes/governance');
const atomicSwapRoutes = require('./routes/atomicSwap');
const atomicSwap = require('./atomic-swap');

// 💰 Motor de preço dinâmico
const priceEngine = require('./priceEngine');

// ============================================
// CONFIGURAÇÃO
// ============================================
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const DOMAIN = process.env.DOMAIN || 'localhost';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const MINING_INTERVAL_MS = Number.parseInt(process.env.MINING_INTERVAL_MS, 10) || 30000;
const WS_MAX_PER_IP = Number.parseInt(process.env.WS_MAX_PER_IP, 10) || 20;
const RATE_LIMIT_GENERAL = Number.parseInt(process.env.RATE_LIMIT_GENERAL, 10) || 600;

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || APP_URL)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

const AMOUNT_REGEX = /^\d{1,18}(\.\d{1,8})?$/;

// ============================================
// HELPERS
// ============================================
function intParam(value, def, min, max) {
    const raw = Array.isArray(value) ? value[0] : value;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(n, min), max);
}

// Aceita string ou número e devolve string canônica (ou lança 400)
function amountString(value, label = 'Amount') {
    const str = typeof value === 'number' && Number.isFinite(value)
        ? value.toFixed(8)
        : value;
    if (typeof str !== 'string' || !AMOUNT_REGEX.test(str.trim()) || Number(str) <= 0) {
        throw new AppError(`${label} inválido`, 400);
    }
    return str.trim();
}

// Cache com deduplicação: se 10 requisições chegam com o cache vencido,
// só uma consulta ao Mongo é feita.
const _cache = new Map();
const _inflight = new Map();

async function cached(key, ttlMs, fn) {
    const now = Date.now();
    const entry = _cache.get(key);
    if (entry && entry.expires > now) {
        return { value: entry.value, cached: true, ts: entry.ts };
    }
    if (_inflight.has(key)) return _inflight.get(key);

    const promise = (async () => {
        try {
            const value = await fn();
            const ts = Date.now();
            _cache.set(key, { value, ts, expires: ts + ttlMs });
            return { value, cached: false, ts };
        } finally {
            _inflight.delete(key);
        }
    })();

    _inflight.set(key, promise);
    return promise;
}

function calcAvgBlockTimeSeconds(blocks) {
    if (!Array.isArray(blocks) || blocks.length < 2) return 0;
    const ts = blocks
        .map((b) => new Date(b.timestamp).getTime())
        .filter(Number.isFinite)
        .sort((a, b) => b - a);
    if (ts.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < ts.length; i++) sum += ts[i - 1] - ts[i];
    return sum / (ts.length - 1) / 1000;
}

// ============================================
// INICIALIZAÇÃO DO EXPRESS
// ============================================
const app = express();
const server = http.createServer(app);
// Evita 502 intermitente atrás de proxy/balanceador (Render, Nginx, etc.)
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// ============================================
// 🛡️ Instâncias de defesa de consenso
// ============================================
const consecutiveGuard = new ConsecutiveBlockGuard({ maxConsecutive: 5 });
const dynamicDiff = new DynamicDifficulty({
    baseTarget: 0x00000fff,
    minTarget: 0x000000ff,
    maxTarget: 0x00ffffff,
    alpha: 0.1,
    decayMs: 60_000
});
const reorgDetector = new ReorgDetector({
    maxDepth: 100,
    maxFrequent: 3,
    alertWindowMs: 300_000
});
const weakSubj = new WeakSubjectivity({
    periodBlocks: 1000,
    quorum: 0.67,
    maxCheckpointAgeBlocks: 2000
});
const timestampService = new TimestampService({ maxEntries: 10_000 });

app.set('consecutiveGuard', consecutiveGuard);
app.set('dynamicDiff', dynamicDiff);
app.set('reorgDetector', reorgDetector);
app.set('weakSubj', weakSubj);
app.set('timestamps', timestampService);
app.set('atomicSwap', atomicSwap);

// ============================================
// SOCKET.IO (com auth e limites)
// ============================================
const io = socketIo(server, {
    maxHttpBufferSize: 1e5,        // 100 KB por mensagem
    pingTimeout: 20_000,
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ['GET', 'POST'],
        credentials: true
    },
    allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        if (!origin) return callback(null, true);
        callback(null, ALLOWED_ORIGINS.includes(origin));
    }
});

io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token || typeof token !== 'string') {
            socket.user = null;
            return next();
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET, {
            algorithms: ['HS256'],
            issuer: 'bradicoin-api',
            audience: 'bradicoin-clients'
        });

        const user = await User.findById(decoded.id)
            .select('-password -twoFactorSecret -resetPasswordToken -resetPasswordExpires');

        if (user && user.status === 'active') {
            socket.user = user;
            socket.userId = user._id;
        } else {
            socket.user = null;
        }
        next();
    } catch (error) {
        socket.user = null;
        next();
    }
});

// ============================================
// MIDDLEWARE DE SEGURANÇA
// ============================================
app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'", 'wss:', 'https:'],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            ...(IS_PROD ? { upgradeInsecureRequests: [] } : {})
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: IS_PROD
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    frameguard: { action: 'deny' }
}));

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        logger.warn('CORS bloqueado para origem:', origin);
        cb(new AppError('Origem não permitida pelo CORS', 403));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));

app.use(mongoSanitize({ replaceWith: '_', allowDots: false }));
app.use(hpp());
app.use(compression());

app.use(express.json({ limit: '1mb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ============================================
// LOGGER SANITIZADO (não loga query string)
// ============================================
function sanitizePathForLog(req) {
    const fullPath = req.originalUrl || req.url || '';
    const qIndex = fullPath.indexOf('?');
    return qIndex >= 0 ? fullPath.substring(0, qIndex) : fullPath;
}

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (!IS_PROD || res.statusCode >= 400 || duration > 1000) {
            logger.info(`${req.method} ${sanitizePathForLog(req)} ${res.statusCode} ${duration}ms`);
        }
    });
    next();
});

// ============================================
// RATE LIMITERS
// ============================================
const limiterBase = { standardHeaders: true, legacyHeaders: false };

const generalLimiter = rateLimit({
    ...limiterBase,
    windowMs: 15 * 60 * 1000,
    max: RATE_LIMIT_GENERAL,
    message: { success: false, error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});

// Login/registro/recuperação: conta só tentativas que falharam (anti força bruta)
const authLimiter = rateLimit({
    ...limiterBase,
    windowMs: 15 * 60 * 1000,
    max: 30,
    skipSuccessfulRequests: true,
    message: { success: false, error: 'Muitas tentativas. Tente novamente em 15 minutos.' }
});

const txLimiter = rateLimit({
    ...limiterBase,
    windowMs: 60 * 1000,
    max: 20,
    skip: (req) => req.method === 'GET',
    message: { success: false, error: 'Muitas transações. Tente novamente em 1 minuto.' }
});

const swapLimiter = rateLimit({
    ...limiterBase,
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, error: 'Muitas operações de swap. Tente novamente em 1 minuto.' }
});

const buyLimiter = rateLimit({
    ...limiterBase,
    windowMs: 60 * 1000,
    max: 20,
    message: { success: false, error: 'Muitas operações de compra. Tente novamente em 1 minuto.' }
});

app.use('/api', generalLimiter);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime())
    });
});

app.get('/health/detailed', asyncHandler(async (req, res) => {
    const info = await blockchain.getChainInfo();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        ...(IS_PROD ? {} : {
            version: process.env.npm_package_version || '4.3.0',
            environment: process.env.NODE_ENV || 'development'
        }),
        blockchain: info
    });
}));

// Diagnóstico interno dos guards: só admin
app.get('/health/defense', authenticate, requireAdmin, (req, res) => {
    try {
        const tail = (blockchain.chain || []).slice(-50);
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            guards: {
                consecutiveBlock: {
                    maxAllowed: 5,
                    tailValid: consecutiveGuard.validate(tail).ok
                },
                dynamicDifficulty: {
                    baseTarget: '0x' + dynamicDiff.baseTarget.toString(16),
                    stats: dynamicDiff.stats()
                },
                reorgDetector: {
                    maxDepth: reorgDetector.maxDepth,
                    recentReorgs: reorgDetector.history.length
                },
                weakSubjectivity: {
                    periodBlocks: weakSubj.periodBlocks,
                    checkpoints: weakSubj.checkpoints.length
                },
                timestampService: {
                    trackedBlocks: timestampService.timestamps.size
                }
            }
        });
    } catch (err) {
        logger.error('❌ Erro em /health/defense:', err);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// ============================================
// 📜 EXPLORER — rotas públicas (dados reais)
// ============================================
app.get('/api/explorer/transactions', asyncHandler(async (req, res) => {
    const limit = intParam(req.query.limit, 20, 1, 100);
    const offset = intParam(req.query.offset, 0, 0, 100000);

    const [txs, total] = await Promise.all([
        TransactionModel.find({})
            .sort({ timestamp: -1 })
            .skip(offset)
            .limit(limit)
            .select('hash from to amount fee timestamp status blockIndex blockHash confirmations type')
            .lean(),
        TransactionModel.estimatedDocumentCount()
    ]);

    const data = txs.map((tx) => ({
        hash: tx.hash,
        fromAddress: tx.from || null,
        toAddress: tx.to,
        amount: tx.amount ? Number.parseFloat(tx.amount.toString()) : 0,
        fee: tx.fee ? Number.parseFloat(tx.fee.toString()) : 0,
        timestamp: tx.timestamp ? new Date(tx.timestamp).getTime() : null,
        type: tx.type || 'transfer',
        status: tx.status,
        confirmed: tx.status === 'confirmed',
        blockIndex: tx.blockIndex ?? null,
        blockHash: tx.blockHash ?? null,
        confirmations: tx.confirmations ?? 0
    }));

    res.json({ success: true, data, total, limit, offset });
}));

app.get('/api/explorer/stats', asyncHandler(async (req, res) => {
    const { value } = await cached('explorer:stats', 10_000, async () => {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [chainInfo, totalWallets, totalTx, recentBlocks, tx24h] = await Promise.all([
            blockchain.getChainInfo(),
            WalletModel.countDocuments({}),
            TransactionModel.estimatedDocumentCount(),
            BlockModel.find().sort({ index: -1 }).limit(100).select('index timestamp').lean(),
            TransactionModel.countDocuments({ timestamp: { $gte: oneDayAgo } })
        ]);

        let currentPrice = null;
        let basePrice = null;
        try {
            const state = priceEngine.getPriceState();
            currentPrice = state.currentPrice;
            basePrice = state.basePrice;
        } catch (_) {
            // indisponível: devolve null em vez de inventar
        }

        return {
            blockHeight: chainInfo.totalBlocks || 0,
            difficulty: chainInfo.difficulty || 0,
            chainwork: chainInfo.chainwork || '0',
            avgBlockTime: Number(calcAvgBlockTimeSeconds(recentBlocks).toFixed(2)),
            pending: chainInfo.pendingTransactions || 0,
            orphanPoolSize: chainInfo.orphanPoolSize || 0,
            totalTX: totalTx,
            tx24h,
            activeWallets: totalWallets,
            basePrice,
            currentPrice,
            blockReward: chainInfo.blockReward || '0',
            latestBlock: chainInfo.latestBlock || null
        };
    });

    res.json({ success: true, data: value, timestamp: Date.now() });
}));

// ============================================
// 🛡️ VALIDATORS
// ============================================
function formatValidator(v) {
    return {
        address: v.address,
        publicKey: v.address,
        stake: v.stake || 0,
        blocksMined: v.blocksProposed || 0,
        uptime: null,          // não inventamos uptime
        commission: null,      // não inventamos comissão
        status: v.active === false ? 'inactive' : 'active',
        firstSeen: v.joined || null,
        lastBlock: v.lastBlock ?? null,
        lastActive: null
    };
}

app.get('/api/validator/list', asyncHandler(async (req, res) => {
    let validators = (await validatorModule.getValidators(100)).map(formatValidator);
    let source = 'registry';

    // Sem validadores registrados: deriva da chain real (mineradores e stakes)
    if (validators.length === 0) {
        source = 'chain';
        const blocks = await BlockModel.find()
            .sort({ index: -1 })
            .limit(1000)
            .select('minerAddress timestamp transactions.type transactions.fromAddress transactions.amount')
            .lean();

        const stakeBy = new Map();
        const blocksBy = new Map();
        const firstSeen = new Map();
        const lastActive = new Map();

        for (const block of blocks) {
            const miner = block.minerAddress;
            if (miner) {
                blocksBy.set(miner, (blocksBy.get(miner) || 0) + 1);
                if (!firstSeen.has(miner)) firstSeen.set(miner, block.timestamp);
                lastActive.set(miner, block.timestamp);
            }
            for (const tx of (block.transactions || [])) {
                if (tx.type === 'stake' && tx.fromAddress) {
                    stakeBy.set(tx.fromAddress, (stakeBy.get(tx.fromAddress) || 0) + Number(tx.amount || 0));
                }
            }
        }

        const addresses = new Set([...blocksBy.keys(), ...stakeBy.keys()]);
        validators = Array.from(addresses).map((addr) => ({
            address: addr,
            publicKey: addr,
            stake: stakeBy.get(addr) || 0,
            blocksMined: blocksBy.get(addr) || 0,
            uptime: null,
            commission: null,
            status: 'active',
            firstSeen: firstSeen.get(addr) || null,
            lastActive: lastActive.get(addr) || null
        }));
    }

    validators.sort((a, b) => (b.stake || 0) - (a.stake || 0));

    res.json({
        success: true,
        data: validators,
        total: validators.length,
        source,
        timestamp: Date.now()
    });
}));

// Registro de validador (admin). Agora trava o stake de verdade via validator.js
app.post(
    '/api/validator/register',
    authenticate,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const address = wallet.normalizeAddress(req.body?.address);
        if (!wallet.isValidAddress(address)) {
            throw new AppError('Endereço inválido', 400);
        }

        const stakeNum = Number(req.body?.stake);
        if (!Number.isFinite(stakeNum) || stakeNum < validatorModule.MIN_VALIDATOR_STAKE) {
            throw new AppError(`Stake mínimo é ${validatorModule.MIN_VALIDATOR_STAKE} BRD`, 400);
        }

        let saved;
        try {
            saved = await validatorModule.register(address, stakeNum);
        } catch (err) {
            throw new AppError(err.message || 'Falha ao registrar validador', 400);
        }

        logger.warn(`🛡️ ADMIN ${req.user._id} registrou validador ${address} (${stakeNum} BRD)`);

        res.json({
            success: true,
            message: 'Validador registrado com sucesso',
            data: formatValidator(saved)
        });
    })
);

// ============================================
// 💰 PREÇO DINÂMICO
// ============================================
app.get('/api/market/price', (req, res) => {
    const state = priceEngine.getPriceState();
    res.json({
        success: true,
        data: {
            price: state.currentPrice,
            basePrice: state.basePrice,
            maxPrice: state.maxPrice,
            variation24h: state.variation24h,
            lastUpdate: state.lastUpdate
        }
    });
});

app.get('/api/market/price/history', (req, res) => {
    const state = priceEngine.getPriceState();
    res.json({ success: true, data: state.history });
});

app.post(
    '/api/market/price/recalculate',
    authenticate,
    requireAdmin,
    asyncHandler(async (req, res) => {
        // Só aceita os 4 campos conhecidos, todos números finitos >= 0
        const input = {};
        for (const key of ['tx24h', 'stakingAmount', 'newWallets', 'burnedAmount']) {
            const n = Number(req.body?.[key]);
            input[key] = Number.isFinite(n) && n >= 0 ? n : 0;
        }
        const newPrice = priceEngine.calculatePrice(input);
        logger.warn(`💰 ADMIN ${req.user._id} recalculou o preço manualmente → ${newPrice}`);
        res.json({ success: true, data: { price: newPrice } });
    })
);

app.post(
    '/api/market/price/buy',
    authenticate,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const amount = Number(amountString(req.body?.amount));
        const newPrice = priceEngine.applyBoost(amount, 'buy');
        logger.warn(`💰 ADMIN ${req.user._id} aplicou boost de preço (${amount}) → ${newPrice}`);
        res.json({ success: true, data: { price: newPrice, amount } });
    })
);

// ============================================
// 📊 LISTAS PÚBLICAS (token / nft) — antes dos routers
// ============================================
function publicListRoute(modelPath, label) {
    return asyncHandler(async (req, res) => {
        try {
            const Model = require(modelPath);
            const items = await Model.find({ status: 'active' })
                .sort({ createdAt: -1 })
                .limit(100)
                .lean();
            res.json({ success: true, data: items, total: items.length });
        } catch (err) {
            logger.warn(`Lista de ${label} indisponível: ${err.message}`);
            res.json({ success: true, data: [], total: 0 });
        }
    });
}

app.get('/api/v1/token/list', publicListRoute('./models/Token', 'tokens'));
app.get('/api/v1/nft/list', publicListRoute('./models/NFT', 'NFTs'));

// ============================================
// 🛒 BUY — valida BUY_MASTER_SEED ANTES de montar as rotas
// ============================================
let buyEnabled = false;
try {
    const deposit = require('./services/buy/depositAddress');
    if (!deposit.selfTest()) {
        console.error('❌ BUY_MASTER_SEED inválida — abortando boot');
        process.exit(1);
    }
    buyEnabled = true;
} catch (err) {
    logger.error(`⚠️ depositAddress não carregou: ${err.message} (rotas /buy desativadas)`);
}

// ============================================
// ROTAS DA API — v1
// ============================================
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/transaction', txLimiter, transactionRoutes);
app.use('/api/v1/reserve', reserveRoutes);
app.use('/api/v1/reserve-staking', reserveStakingRoutes);
app.use('/api/v1/token', tokenRoutes);
app.use('/api/v1/nft', nftRoutes);
app.use('/api/v1/airdrop', airdropRouter);
app.use('/api/v1/governance', governanceRoutes);
app.use('/api/atomic-swap', swapLimiter, atomicSwapRoutes);

// 🔐 Tudo em /api/v1/admin/* exige admin, em um único ponto
app.use('/api/v1/admin', authenticate, requireAdmin);
app.use('/api/v1/admin/airdrop', adminAirdropRouter);

if (buyEnabled) {
    app.use('/api/v1/buy', buyLimiter, require('./routes/buy'));
} else {
    app.use('/api/v1/buy', (req, res) =>
        res.status(503).json({ success: false, error: 'Compra temporariamente indisponível' }));
}

// Aliases sem /v1 (compatibilidade com o frontend público)
app.use('/api/wallet', walletRoutes);
app.use('/api/transaction', txLimiter, transactionRoutes);
app.use('/api/token', tokenRoutes);
app.use('/api/nft', nftRoutes);

logger.info('✅ Rotas da API registradas');

// ============================================
// 📊 NETWORK STATS (cache de 15s, sem estouro)
// ============================================
async function buildNetworkStats() {
    const now = Date.now();
    const oneDayAgo = new Date(now - 86400000);

    const [
        chainInfo, totalTx, tx24h, activeWallets, newWalletsToday,
        feesAgg, volumeAgg, stakingStats, priceState, latestBlocks, reserveDoc
    ] = await Promise.all([
        blockchain.getChainInfo().catch(() => ({})),
        TransactionModel.estimatedDocumentCount().catch(() => 0),
        TransactionModel.countDocuments({ timestamp: { $gte: oneDayAgo } }).catch(() => 0),
        WalletModel.countDocuments({ status: 'active' }).catch(() => 0),
        WalletModel.countDocuments({ createdAt: { $gte: oneDayAgo } }).catch(() => 0),

        TransactionModel.aggregate([
            { $match: { timestamp: { $gte: oneDayAgo } } },
            { $group: { _id: null, total: { $sum: { $toDouble: '$fee' } }, count: { $sum: 1 } } }
        ]).catch(() => []),

        TransactionModel.aggregate([
            { $match: { timestamp: { $gte: oneDayAgo }, from: { $ne: null } } },
            { $group: { _id: null, total: { $sum: { $toDouble: '$amount' } } } }
        ]).catch(() => []),

        staking.getStakingStats().catch(() => ({ totalStaked: 0, totalRewards: 0, activeStakers: 0 })),

        Promise.resolve().then(() => {
            try { return priceEngine.getPriceState(); } catch (_) { return null; }
        }),

        BlockModel.find().sort({ index: -1 }).limit(100).select('index timestamp minerAddress').lean().catch(() => []),

        Promise.resolve().then(async () => {
            try {
                const { ReserveModel } = require('./models/Reserve');
                return await ReserveModel.getReserve();
            } catch (_) { return null; }
        })
    ]);

    const avgBlockTime = calcAvgBlockTimeSeconds(latestBlocks);
    const blocksPerMin = avgBlockTime > 0 ? 60 / avgBlockTime : 0;
    const tps = tx24h / 86400;

    // Supply
    let minedSupply = 0;
    try { minedSupply = explorer.calculateTotalSupply() || 0; } catch (_) { /* mantém 0 */ }

    const locked = reserveDoc ? Number.parseFloat(reserveDoc.balance.toString()) : 0;
    const staked = Number(stakingStats.totalStaked || 0);
    const burned = 0;
    const circulating = Math.max(0, minedSupply - locked - burned);

    // Preço de referência
    const currentPrice = priceState?.currentPrice || 0;
    const basePrice = priceState?.basePrice || 0;
    const maxPrice = priceState?.maxPrice || currentPrice * 1.5;

    // Descentralização (HHI) e saúde da rede
    let decentralization = 0;
    let networkHealth = 0;
    try {
        const miners = new Map();
        for (const b of latestBlocks) {
            if (b.minerAddress) miners.set(b.minerAddress, (miners.get(b.minerAddress) || 0) + 1);
        }
        const totalBlocks = latestBlocks.length || 1;
        let hhi = 0;
        for (const count of miners.values()) {
            const share = count / totalBlocks;
            hhi += share * share;
        }
        decentralization = Math.round((1 - hhi) * 1000) / 10;

        const pendingPenalty = Math.min(40, (chainInfo.pendingTransactions || 0) / 25);
        const orphanPenalty = Math.min(20, (chainInfo.orphanPoolSize || 0) * 2);
        const decPenalty = (100 - decentralization) / 5;
        networkHealth = Math.max(0, Math.round((100 - pendingPenalty - orphanPenalty - decPenalty) * 10) / 10);
    } catch (_) { /* mantém 0 */ }

    const feesToday = feesAgg[0]?.total || 0;
    const tx24hCount = feesAgg[0]?.count || tx24h;
    const avgFee = tx24hCount > 0 ? feesToday / tx24hCount : 0;

    return {
        blockHeight: chainInfo.totalBlocks || 0,
        blocksPerMin: Number(blocksPerMin.toFixed(1)),
        avgBlockTime: Number(avgBlockTime.toFixed(1)),
        nodesOnline: 1,
        validators: stakingStats.activeStakers || 0,
        networkHealth,
        decentralization,
        difficulty: chainInfo.difficulty || 0,
        isValid: chainInfo.isValid !== false,

        tps: Number(tps.toFixed(2)),
        avgConfirmation: Number(avgBlockTime.toFixed(1)),
        avgFee: Number(avgFee.toFixed(4)),
        volume24h: volumeAgg[0]?.total || 0,
        feesToday,
        pending: chainInfo.pendingTransactions || 0,
        totalTX: totalTx,
        tx24h,

        activeWallets,
        newToday: newWalletsToday,
        inStaking: stakingStats.activeStakers || 0,
        topHolders: 0,

        total: minedSupply,
        circulating,
        maxSupply: MAX_SUPPLY,
        locked,
        staked,
        burned,
        deflation: 0,

        basePrice,
        currentPrice,
        priceSupport: basePrice,
        maxPrice,
        realMarketCap: circulating * currentPrice,
        dilutedMC: MAX_SUPPLY * currentPrice,
        targetMC: MAX_SUPPLY * maxPrice,
        variation24h: priceState?.variation24h || 0,

        buybackActive: false,
        stabilityFund: 0,
        boughtToday: 0,
        burnedToday: 0,

        latestBlock: chainInfo.latestBlock || null,
        cachedAt: now
    };
}

app.get('/api/network/stats', asyncHandler(async (req, res) => {
    const result = await cached('network:stats', 15_000, buildNetworkStats);
    res.json({ success: true, cached: result.cached, timestamp: result.ts, data: result.value });
}));

app.get('/api/network/supply', asyncHandler(async (req, res) => {
    const { value } = await cached('network:supply', 15_000, async () => {
        let mined = 0;
        try { mined = explorer.calculateTotalSupply() || 0; } catch (_) { /* 0 */ }

        let reserve = 0;
        try {
            const { ReserveModel } = require('./models/Reserve');
            const r = await ReserveModel.getReserve();
            reserve = Number.parseFloat(r.balance.toString());
        } catch (_) { /* 0 */ }

        let stakedTotal = 0;
        try {
            const s = await staking.getStakingStats();
            stakedTotal = s.totalStaked || 0;
        } catch (_) { /* 0 */ }

        return {
            maxSupply: MAX_SUPPLY,
            total: mined,
            circulating: Math.max(0, mined - reserve),
            locked: reserve,
            staked: stakedTotal,
            burned: 0,
            remaining: Math.max(0, MAX_SUPPLY - mined)
        };
    });
    res.json({ success: true, data: value });
}));

app.get('/api/explorer/rich-list', asyncHandler(async (req, res) => {
    const limit = intParam(req.query.limit, 100, 1, 500);
    const { value } = await cached(`rich:${limit}`, 30_000, () => explorer.getRichList(limit));
    res.json({ success: true, data: value });
}));

// ============================================
// ROTAS DE ADMIN (o gate authenticate+requireAdmin já vale para /api/v1/admin/*)
// ============================================
app.post(
    '/api/v1/admin/reserve/send',
    txLimiter,
    asyncHandler(async (req, res) => {
        const { toAddress, amount, fee, nonce, timestamp, signature, publicKey } = req.body || {};
        const fromAddress = wallet.normalizeAddress(req.body?.fromAddress);

        if (fromAddress !== RESERVE_ADDRESS) {
            throw new AppError('Admin só pode enviar do Reserve', 403);
        }

        const safeAmount = amountString(amount);
        const safeFee = fee === undefined || fee === null || fee === '' ? '0' : String(fee);
        if (!/^\d{1,18}(\.\d{1,8})?$/.test(safeFee)) {
            throw new AppError('Fee inválida', 400);
        }

        const result = await transactions.submitSignedTransaction({
            fromAddress,
            toAddress: wallet.normalizeAddress(toAddress),
            amount: safeAmount,
            fee: safeFee,
            nonce, timestamp,
            type: 'transfer',
            signature, publicKey
        });

        logger.warn(`🏦 ADMIN ${req.user._id} enviou ${safeAmount} BRD do Reserve para ${toAddress}`);

        res.json({ success: true, message: 'Transação do Reserve submetida', data: result });
    })
);

app.get(
    '/api/v1/admin/reserve/info',
    asyncHandler(async (req, res) => {
        const { ReserveModel } = require('./models/Reserve');
        res.json({ success: true, data: await ReserveModel.getInfo() });
    })
);

app.post(
    '/api/v1/admin/reserve/mint',
    asyncHandler(async (req, res) => {
        const amount = amountString(req.body?.amount);

        const { ReserveModel } = require('./models/Reserve');
        const reserve = await ReserveModel.mint(amount, req.user._id);

        logger.warn(`🏦 ADMIN ${req.user._id} fez MINT de ${amount} BRD`);

        res.json({ success: true, message: `Minted ${amount} BRD`, data: reserve.toPublic() });
    })
);

logger.info('✅ Rotas de admin: /api/v1/admin/*');

// ============================================
// WEBSOCKET — EVENTOS
// ============================================
const wsByIp = new Map();

function clientIp(socket) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',').pop().trim();   // IP adicionado pelo proxy
    return socket.handshake.address;
}

io.on('connection', async (socket) => {
    const ip = clientIp(socket);
    const current = wsByIp.get(ip) || 0;

    if (current >= WS_MAX_PER_IP) {
        socket.disconnect(true);
        return;
    }
    wsByIp.set(ip, current + 1);

    logger.info(`🔌 WS conectado: ${socket.id} (${socket.user ? 'autenticado' : 'anônimo'})`);

    try {
        socket.emit('blockchain:init', await blockchain.getChainInfo());
    } catch (error) {
        logger.error('Erro ao enviar init WS:', error);
    }

    socket.on('disconnect', () => {
        const left = (wsByIp.get(ip) || 1) - 1;
        if (left <= 0) wsByIp.delete(ip);
        else wsByIp.set(ip, left);
        logger.info(`🔌 WS desconectado: ${socket.id}`);
    });
});

// ============================================
// SPA FALLBACK + ARQUIVOS ESTÁTICOS
// ============================================
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: IS_PROD ? '1d' : 0,
    etag: true
}));

// Qualquer rota que não seja /api cai no index.html
app.get(/^\/(?!api(\/|$)).*/, (req, res, next) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) next();
    });
});

// ============================================
// HANDLERS DE ERRO
// ============================================
app.use(notFoundHandler);
app.use(errorHandler);

// ============================================
// CONEXÃO COM MONGODB
// ============================================
async function connectMongoDB() {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            maxPoolSize: 20,
            minPoolSize: 2
        });
        logger.info('✅ MongoDB conectado');
    } catch (error) {
        logger.error('❌ Erro ao conectar MongoDB:', error);
        process.exit(1);
    }
}

// ============================================
// AUTO-MINING
// ============================================
let miningInterval = null;
let miningLock = false;
let lastKnownHead = null;

const GUARD_ENABLED = process.env.ENFORCE_CONSECUTIVE_GUARD !== 'false';

function startAutoMining() {
    if (process.env.AUTO_MINING_ENABLED === 'false') {
        logger.warn('⚠️ Auto-mining desativado (AUTO_MINING_ENABLED=false)');
        return;
    }

    const minerAddress = wallet.normalizeAddress(process.env.AUTO_MINER_ADDRESS || '');
    if (!wallet.isValidAddress(minerAddress)) {
        logger.warn('⚠️ AUTO_MINER_ADDRESS ausente ou inválido — auto-mining não iniciado');
        return;
    }

    miningInterval = setInterval(async () => {
        if (miningLock) return;
        miningLock = true;

        try {
            if (!blockchain.pendingTransactions || blockchain.pendingTransactions.length === 0) return;

            const minerWallet = await WalletModel.findOne({ address: minerAddress }).select('_id').lean();
            if (!minerWallet) {
                logger.warn(`Carteira do minerador não encontrada: ${minerAddress}`);
                return;
            }

            if (GUARD_ENABLED) {
                const tailCheck = consecutiveGuard.validate((blockchain.chain || []).slice(-20));
                if (!tailCheck.ok) {
                    logger.warn(`🛡️ Mineração bloqueada: ${tailCheck.reason} (${tailCheck.streak}x ${tailCheck.producer})`);
                    return;
                }
            }

            const chain = blockchain.chain || [];
            const currentHead = chain[chain.length - 1];

            if (currentHead && lastKnownHead) {
                const prevStillInChain = chain.some((b) => b.hash === lastKnownHead.hash);
                if (!prevStillInChain) {
                    const reorgCheck = reorgDetector.check(currentHead, lastKnownHead);
                    if (!reorgCheck.ok && reorgCheck.action === 'halt_and_alert') {
                        logger.error(`🚨 Reorg detectado! Mineração pausada: ${reorgCheck.reason}`);
                        return;
                    }
                    logger.warn(`⚠️ Reorg detectado (profundidade: ${lastKnownHead.index - currentHead.index})`);
                }
            }
            if (currentHead) lastKnownHead = currentHead;

            const target = dynamicDiff.getTarget(minerAddress);
            logger.debug(`⚙️ Target dinâmico para ${minerAddress}: 0x${target.toString(16)}`);

            const block = await blockchain.minePendingTransactions(minerAddress);
            if (block) {
                dynamicDiff.recordAttempt(minerAddress);
                timestampService.stamp(block);

                logger.info(`⛏️ Bloco ${block.index} minerado (${block.transactions.length} txs)`);

                io.emit('block:mined', {
                    index: block.index,
                    hash: block.hash,
                    txCount: block.transactions.length,
                    timestamp: block.timestamp
                });
            }
        } catch (error) {
            logger.error('❌ Erro na mineração automática:', error.message);
        } finally {
            miningLock = false;
        }
    }, MINING_INTERVAL_MS);

    logger.info(`⛏️ Auto-mining iniciado (intervalo: ${MINING_INTERVAL_MS}ms)`);
}

// ============================================
// 💰 AUTO-RECALCULADOR DE PREÇO (5 min)
// ============================================
let priceInterval = null;

function startAutoPriceUpdate() {
    priceInterval = setInterval(async () => {
        try {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const tx24h = await TransactionModel.countDocuments({ timestamp: { $gte: oneDayAgo } });

            const newPrice = priceEngine.calculatePrice({
                tx24h,
                stakingAmount: 0,
                newWallets: 0,
                burnedAmount: 0
            });

            logger.info(`💰 Preço recalculado: $${newPrice} (TX24h: ${tx24h})`);
        } catch (err) {
            logger.error('❌ Erro ao recalcular preço:', err.message);
        }
    }, 5 * 60 * 1000);

    logger.info('💰 Auto-recalculador de preço iniciado (a cada 5min)');
}

// ============================================
// 🛡️ Checkpoint periódico
// ============================================
let checkpointInterval = null;
let lastCheckpointHeight = -1;

function startCheckpointing() {
    checkpointInterval = setInterval(() => {
        try {
            const chain = blockchain.chain || [];
            const head = chain[chain.length - 1];
            if (!head || head.index % 100 !== 0) return;
            if (head.index === lastCheckpointHeight) return;   // não repete no mesmo bloco

            const root = crypto.createHash('sha256')
                .update(JSON.stringify(head.state || head.stateRoot || { index: head.index }))
                .digest('hex');

            const validatorSet = blockchain.validators
                ? Array.from(blockchain.validators.values())
                : [];

            const signatures = validatorSet
                .filter((v) => v.status === 'active')
                .map((v) => ({ validator: v.id || v.address, valid: true }));

            weakSubj.addCheckpoint({ height: head.index, root, signatures, ts: Date.now() });
            lastCheckpointHeight = head.index;

            logger.info(`🛡️ Checkpoint criado no bloco ${head.index} (root: ${root.slice(0, 12)}...)`);
        } catch (err) {
            logger.error('❌ Erro ao criar checkpoint:', err.message);
        }
    }, 60_000);

    logger.info('🛡️ Checkpointing ativo');
}

// ============================================
// P2P REF
// ============================================
let p2pNode = null;

// ============================================
// INICIALIZAÇÃO
// ============================================
async function initialize() {
    try {
        logger.info('🚀 Inicializando BradiChain...');
        logger.info(`🌐 Domínio: ${DOMAIN}`);
        logger.info(`🔧 Modo: ${process.env.NODE_ENV || 'development'}`);

        await connectMongoDB();

        await blockchain.initialize();
        await wallet.initialize();
        await transactions.initialize();
        await validatorModule.initialize();

        // 🌐 P2P — opcional (P2P_ENABLED=false desativa)
        if (process.env.P2P_ENABLED !== 'false') {
            try {
                const { startP2P } = require('./p2p');
                const p2pResult = await startP2P({
                    blockchain,
                    port: Number.parseInt(process.env.P2P_PORT, 10) || 4001
                });
                p2pNode = p2pResult.node;
                logger.info(`🌐 P2P rodando (PeerID: ${p2pNode.peerId.toString()})`);
            } catch (p2pErr) {
                logger.error('⚠️ P2P falhou ao iniciar (continuando sem P2P):', p2pErr.message);
                p2pNode = null;
            }
        } else {
            logger.warn('⚠️ P2P desativado (P2P_ENABLED=false)');
        }

        // 📡 SwapGossip (só com P2P ativo)
        if (p2pNode) {
            try {
                const { initGossip, orderBook } = require('./atomic-swap/negotiation');

                await orderBook.loadFromMongo();
                orderBook.startCleanup();

                initGossip({
                    node: p2pNode,
                    peerId: p2pNode.peerId.toString(),
                    privateKey: process.env.SWAP_PRIVATE_KEY || null,
                    publicKey: process.env.SWAP_PUBLIC_KEY || null
                });

                logger.info('📡 SwapGossip P2P inicializado');
            } catch (e) {
                logger.error('❌ Erro ao inicializar SwapGossip:', e.message);
            }
        } else {
            logger.warn('⚠️ SwapGossip ignorado (sem P2P)');
        }

        const { ReserveModel } = require('./models/Reserve');
        const reserve = await ReserveModel.getReserve();
        logger.info(`🏦 Reserve: ${reserve.address}`);
        logger.info(`💰 Reserve balance: ${reserve.balance.toString()} BRD`);
        logger.info(`📊 Max supply: ${reserve.maxSupply.toString()} BRD`);

        startAutoMining();
        startAutoPriceUpdate();
        startCheckpointing();

        // 💰 BUY — workers de crédito
        if (buyEnabled) {
            try {
                const creditWorker = require('./services/buy/creditWorker');
                const creditingWatchdog = require('./services/buy/creditingWatchdog');
                creditWorker.start({ io });
                creditingWatchdog.start({ io });
            } catch (err) {
                logger.error('⚠️ Falha ao iniciar creditWorker/watchdog:', err.message);
                logger.error('   Verifique models/Treasury.js e services/buy/credit*.js');
            }
        }

        server.listen(PORT, '0.0.0.0', () => {
            logger.info('════════════════════════════════════════');
            logger.info('✅ BradiChain rodando!');
            logger.info(`📍 API: ${APP_URL}`);
            logger.info(`💚 Health: ${APP_URL}/health`);
            logger.info(`🌐 CORS: ${ALLOWED_ORIGINS.join(', ')}`);
            logger.info('════════════════════════════════════════');
        });
    } catch (error) {
        logger.error('❌ Erro fatal ao inicializar:', error);
        process.exit(1);
    }
}

// ============================================
// ERROS NÃO TRATADOS
// ============================================
process.on('unhandledRejection', (reason) => {
    logger.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('❌ Uncaught Exception:', error);
    // Estado indefinido: sempre encerra (o gerenciador de processos reinicia)
    process.exit(1);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`🛑 Recebido ${signal}. Encerrando graciosamente...`);

    const forceTimer = setTimeout(() => {
        logger.error('⚠️ Forçando saída após timeout');
        process.exit(1);
    }, 10_000);
    forceTimer.unref();

    for (const timer of [miningInterval, priceInterval, checkpointInterval]) {
        if (timer) clearInterval(timer);
    }

    try {
        if (p2pNode) {
            const { stopP2P } = require('./p2p');
            await stopP2P(p2pNode);
        }
    } catch (e) {
        logger.error('Erro ao parar P2P:', e.message);
    }

    io.close();

    server.close(async () => {
        logger.info('✅ Servidor HTTP encerrado');
        try {
            await mongoose.connection.close();
            logger.info('✅ MongoDB desconectado');
        } catch (e) {
            logger.error('Erro ao fechar MongoDB:', e.message);
        }
        process.exit(0);
    });

    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================
// START
// ============================================
initialize();
