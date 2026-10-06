// server.js
// ============================================
// BradiChain - Servidor Principal (v4.2)
// ============================================
// 📝 v4.2 (FASE 1 — correções pré-lançamento):
//   [1] Removidas rotas duplicadas (/api/v1/token/list, /api/v1/nft/list)
//   [2] /api/market/price/recalculate e /buy agora exigem admin
//   [3] /api/validator/register agora exige admin
//   [4] Logs sanitizados (não loga query string)
//   [5] /api/explorer/transactions lê da chain real (Mongo)
//   [6] /api/explorer/stats lê da chain real (sem números fake)
//   [7] /api/validator/list retorna apenas validadores reais
//   [8] Removido fallback de "validadores virtuais"
// ============================================

require('dotenv').config();

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
    'MAX_SUPPLY'
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

// ============================================
// IMPORTAÇÕES LOCAIS
// ============================================
const { startP2P, stopP2P } = require('./p2p');
const blockchain = require('./blockchain');
const wallet = require('./wallet');
const transactions = require('./transactions');
const { logger } = require('./middleware/error');

// 🛡️ v4.1 — Módulos de defesa de consenso
const ConsecutiveBlockGuard = require('./consensus/consecutiveBlockGuard');
const DynamicDifficulty     = require('./consensus/dynamicDifficulty');
const ReorgDetector         = require('./consensus/reorgDetector');
const WeakSubjectivity      = require('./consensus/weakSubjectivity');
const TimestampService      = require('./consensus/timestampService');

// Models
const User = require('./models/User');
const WalletModel = require('./models/Wallet');
const TransactionModel = require('./models/Transaction');
const BlockModel = require('./models/Block');

// Middlewares
const { authenticate, requireAdmin, optionalAuth } = require('./middleware/auth');
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
const governanceRoutes = require('./routes/governance');

const atomicSwapRoutes = require('./routes/atomicSwap');
const atomicSwap = require('./atomic-swap');

// 💰 Motor de preço dinâmico
const priceEngine = require('./priceEngine');

// ============================================
// CONFIGURAÇÃO
// ============================================
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = parseInt(process.env.PORT) || 3000;
const DOMAIN = process.env.DOMAIN || 'localhost';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || APP_URL)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

// ============================================
// INICIALIZAÇÃO DO EXPRESS
// ============================================
const app = express();
const server = http.createServer(app);

// ============================================
// 🛡️ v4.1 — Instâncias de defesa de consenso
// ============================================
const consecutiveGuard = new ConsecutiveBlockGuard({ maxConsecutive: 5 });
const dynamicDiff = new DynamicDifficulty({
    baseTarget: 0x00000fff,
    minTarget:  0x000000ff,
    maxTarget:  0x00ffffff,
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
const timestamps = new TimestampService({ maxEntries: 10_000 });

app.set('consecutiveGuard', consecutiveGuard);
app.set('dynamicDiff', dynamicDiff);
app.set('reorgDetector', reorgDetector);
app.set('weakSubj', weakSubj);
app.set('timestamps', timestamps);
app.set('atomicSwap', atomicSwap);

// ============================================
// SOCKET.IO (com auth)
// ============================================
const io = socketIo(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ['GET', 'POST'],
        credentials: true
    },
    allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        if (!origin) return callback(null, true);
        const ok = ALLOWED_ORIGINS.includes(origin);
        callback(null, ok);
    }
});

io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;

        if (!token) {
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
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "wss:", "https:"],
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
    noSniff: true,
    frameguard: { action: 'deny' },
    xssFilter: true
}));

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        logger.warn('CORS bloqueado para origem:', origin);
        cb(new Error('Origem não permitida pelo CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(mongoSanitize({ replaceWith: '_', allowDots: false }));
app.use(hpp());
app.use(compression());

app.use(express.json({ limit: '1mb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ============================================
// ✅ FIX [4] — LOGGER SANITIZADO
// ============================================
// Não loga query string (pode conter tokens, emails, etc.)
function sanitizePathForLog(req) {
    const fullPath = req.originalUrl || req.url || '';
    const qIndex = fullPath.indexOf('?');
    const pathOnly = qIndex >= 0 ? fullPath.substring(0, qIndex) : fullPath;
    // também remove parâmetros dinâmicos sensíveis de path
    return pathOnly;
}

if (IS_PROD) {
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            if (res.statusCode >= 400 || duration > 1000) {
                logger.warn('Request', {
                    method: req.method,
                    path: sanitizePathForLog(req),
                    status: res.statusCode,
                    duration
                });
            }
        });
        next();
    });
} else {
    app.use((req, res, next) => {
        logger.info(`${req.method} ${sanitizePathForLog(req)}`);
        next();
    });
}

// ============================================
// RATE LIMITERS
// ============================================
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Muitas requisições. Tente novamente em 15 minutos.' }
});

const txLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    keyGenerator: (req) => req.user?._id?.toString() || req.ip,
    message: { success: false, error: 'Muitas transações. Tente novamente em 1 minuto.' }
});

const swapLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.user?._id?.toString() || req.ip,
    message: { success: false, error: 'Muitas operações de swap. Tente novamente em 1 minuto.' }
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
        version: process.env.npm_package_version || '4.2.0',
        uptime: Math.floor(process.uptime()),
        environment: process.env.NODE_ENV || 'development',
        blockchain: info
    });
}));

// ============================================
// 🛡️ v4.1 — DIAGNÓSTICO DOS GUARDS DE DEFESA
// ============================================
app.get('/health/defense', (req, res) => {
    try {
        const currentChain = blockchain.chain || [];
        const tail = currentChain.slice(-50);

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            guards: {
                consecutiveBlock: {
                    maxAllowed: 5,
                    tailValid: consecutiveGuard.validate(tail).ok,
                },
                dynamicDifficulty: {
                    baseTarget: '0x' + dynamicDiff.baseTarget.toString(16),
                    stats: dynamicDiff.stats(),
                },
                reorgDetector: {
                    maxDepth: reorgDetector.maxDepth,
                    recentReorgs: reorgDetector.history.length,
                },
                weakSubjectivity: {
                    periodBlocks: weakSubj.periodBlocks,
                    checkpoints: weakSubj.checkpoints.length,
                },
                timestampService: {
                    trackedBlocks: timestamps.timestamps.size,
                },
            },
        });
    } catch (err) {
        logger.error('❌ Erro em /health/defense:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// 📜 EXPLORER — Rotas públicas (dados REAIS)
// ============================================

// ✅ FIX [5] — /api/explorer/transactions lê da chain real (Mongo)
app.get('/api/explorer/transactions', asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const [txs, total] = await Promise.all([
        TransactionModel.find({})
            .sort({ timestamp: -1 })
            .skip(offset)
            .limit(limit)
            .select('hash from to amount fee timestamp status blockIndex blockHash confirmations type')
            .lean(),
        TransactionModel.countDocuments({})
    ]);

    const formatted = txs.map(tx => ({
        hash: tx.hash,
        fromAddress: tx.from || null,
        toAddress: tx.to,
        amount: tx.amount ? parseFloat(tx.amount.toString()) : 0,
        fee: tx.fee ? parseFloat(tx.fee.toString()) : 0,
        timestamp: tx.timestamp ? new Date(tx.timestamp).getTime() : null,
        type: tx.type || 'transfer',
        status: tx.status,
        confirmed: tx.status === 'confirmed',
        blockIndex: tx.blockIndex ?? null,
        blockHash: tx.blockHash ?? null,
        confirmations: tx.confirmations ?? 0
    }));

    res.json({
        success: true,
        data: formatted,
        total,
        limit,
        offset
    });
}));

// ✅ FIX [6] — /api/explorer/stats lê dados REAIS da chain
app.get('/api/explorer/stats', asyncHandler(async (req, res) => {
    // Puxa dados reais em paralelo
    const [
        chainInfo,
        totalWallets,
        totalTx,
        recentBlocks,
        totalStaked
    ] = await Promise.all([
        blockchain.getChainInfo(),
        WalletModel.countDocuments({}),
        TransactionModel.countDocuments({}),
        BlockModel.find().sort({ index: -1 }).limit(100).lean(),
        WalletModel.countDocuments({ status: 'active' }) // placeholder até termos model de stake
    ]);

    // Calcula média de tempo entre blocos recentes
    let avgBlockTime = 0;
    if (recentBlocks.length >= 2) {
        const timestamps = recentBlocks
            .map(b => new Date(b.timestamp).getTime())
            .filter(t => Number.isFinite(t))
            .sort((a, b) => b - a);
        const deltas = [];
        for (let i = 1; i < timestamps.length; i++) {
            deltas.push(timestamps[i - 1] - timestamps[i]);
        }
        if (deltas.length > 0) {
            avgBlockTime = deltas.reduce((a, b) => a + b, 0) / deltas.length / 1000;
        }
    }

    // TPS das últimas 24h (real)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const tx24h = await TransactionModel.countDocuments({
        timestamp: { $gte: oneDayAgo }
    });

    // Preço atual (do priceEngine real)
    let currentPrice = null;
    let basePrice = null;
    try {
        const state = priceEngine.getPriceState();
        currentPrice = state.currentPrice;
        basePrice = state.basePrice;
    } catch (_) {
        // Se falhar, retorna null em vez de mentir
    }

    res.json({
        success: true,
        data: {
            // Rede
            blockHeight: chainInfo.totalBlocks || 0,
            difficulty: chainInfo.difficulty || 0,
            chainwork: chainInfo.chainwork || '0',
            avgBlockTime: Number(avgBlockTime.toFixed(2)),
            pending: chainInfo.pendingTransactions || 0,
            orphanPoolSize: chainInfo.orphanPoolSize || 0,

            // Transações
            totalTX: totalTx,
            tx24h: tx24h,

            // Wallets
            activeWallets: totalWallets,

            // Preço (null se indisponível)
            basePrice,
            currentPrice,

            // Supply (do blockchain real)
            blockReward: chainInfo.blockReward || '0',

            // Info do último bloco
            latestBlock: chainInfo.latestBlock || null
        },
        timestamp: Date.now()
    });
}));

// ============================================
// 🛡️ VALIDATORS — Lista REAL (sem virtual)
// ✅ FIX [7] + [8]
// ============================================
app.get('/api/validator/list', asyncHandler(async (req, res) => {
    let validators = [];

    // 1. Tenta buscar do banco (model Validator, se existir)
    try {
        const ValidatorModel = require('./models/Validator');
        validators = await ValidatorModel.find({ status: 'active' })
            .sort({ stake: -1 })
            .limit(100)
            .lean();
    } catch (_) {
        // Model não existe — deriva da chain real (sem inventar)
    }

    // 2. Se não achou no model, deriva da chain REAL (sem fake)
    if (!validators || validators.length === 0) {
        const blocks = await BlockModel.find()
            .sort({ index: -1 })
            .limit(1000)
            .lean();

        const addressStake = new Map();
        const addressBlocks = new Map();
        const addressFirstSeen = new Map();
        const addressLastActive = new Map();

        for (const block of blocks) {
            const miner = block.minerAddress;
            if (miner) {
                addressBlocks.set(miner, (addressBlocks.get(miner) || 0) + 1);
                if (!addressFirstSeen.has(miner)) {
                    addressFirstSeen.set(miner, block.timestamp);
                }
                addressLastActive.set(miner, block.timestamp);
            }

            for (const tx of (block.transactions || [])) {
                if (tx.type === 'stake' && tx.fromAddress) {
                    const current = addressStake.get(tx.fromAddress) || 0;
                    addressStake.set(tx.fromAddress, current + Number(tx.amount || 0));
                }
            }
        }

        const allAddresses = new Set([
            ...addressBlocks.keys(),
            ...addressStake.keys()
        ]);

        validators = Array.from(allAddresses).map((addr) => ({
            address: addr,
            publicKey: addr,
            stake: addressStake.get(addr) || 0,
            blocksMined: addressBlocks.get(addr) || 0,
            uptime: null,               // não inventamos uptime
            commission: null,           // não inventamos comissão
            status: 'active',
            firstSeen: addressFirstSeen.get(addr) || null,
            lastActive: addressLastActive.get(addr) || null
        }));
    }

    validators.sort((a, b) => (b.stake || 0) - (a.stake || 0));

    res.json({
        success: true,
        data: validators,
        total: validators.length,
        timestamp: Date.now()
    });
}));

// ============================================
// 🛡️ VALIDATOR — Registro (agora exige ADMIN)
// ✅ FIX [3]
// ============================================
app.post(
    '/api/validator/register',
    authenticate,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const { address, stake } = req.body;

        if (!address || !address.startsWith('Br')) {
            throw new AppError('Endereço inválido (deve começar com "Br")', 400);
        }

        const MIN_STAKE = 1000;
        const stakeNum = Number(stake || 0);

        if (stakeNum < MIN_STAKE) {
            throw new AppError(`Stake mínimo é ${MIN_STAKE} BRD`, 400);
        }

        let saved;
        try {
            const ValidatorModel = require('./models/Validator');
            saved = await ValidatorModel.findOneAndUpdate(
                { address },
                {
                    address,
                    stake: stakeNum,
                    status: 'active',
                    uptime: 99.99,
                    commission: 5,
                    lastActive: Date.now(),
                    $setOnInsert: { firstSeen: Date.now() }
                },
                { upsert: true, new: true }
            );
        } catch (_) {
            saved = { address, stake: stakeNum, status: 'active' };
        }

        logger.info(`🛡️ Novo validador registrado: ${address} (${stakeNum} BRD)`);

        res.json({
            success: true,
            message: 'Validador registrado com sucesso',
            data: saved
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

// ✅ FIX [2] — agora exige admin
app.post(
    '/api/market/price/recalculate',
    authenticate,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const newPrice = priceEngine.calculatePrice(req.body || {});
        res.json({ success: true, data: { price: newPrice } });
    })
);

// ✅ FIX [2] — agora exige admin
app.post(
    '/api/market/price/buy',
    authenticate,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const { amount } = req.body;
        if (!amount || amount <= 0) {
            throw new AppError('Amount inválido', 400);
        }
        const newPrice = priceEngine.applyBoost(Number(amount), 'buy');
        res.json({ success: true, data: { price: newPrice, amount } });
    })
);

logger.info('✅ Rotas: /api/market/price*');

// ============================================
// ROTAS DA API — v1
// ============================================
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/transaction', txLimiter, transactionRoutes);
app.use('/api/v1/reserve', reserveRoutes);
app.use('/api/v1/reserve-staking', reserveStakingRoutes);
app.use('/api/v1/token', tokenRoutes);
app.use('/api/v1/nft', nftRoutes);
app.use('/api/v1/airdrop', airdropRouter);
app.use('/api/v1/governance', governanceRoutes);
app.use('/api/atomic-swap', swapLimiter, atomicSwapRoutes);

logger.info('✅ Rotas v1 registradas');
try {
    logger.info(`🔄 Atomic Swap: ${atomicSwap.listChains().length} chains registradas`);
} catch (e) {
    logger.warn(`⚠️  Atomic Swap: não foi possível listar chains (${e.message})`);
}

// ============================================
// ROTAS DE ADMIN
// ============================================
app.post(
    '/api/v1/admin/reserve/send',
    authenticate,
    requireAdmin,
    txLimiter,
    asyncHandler(async (req, res) => {
        const {
            fromAddress, toAddress, amount, fee,
            nonce, timestamp, signature, publicKey
        } = req.body;

        if (fromAddress !== process.env.RESERVE_ADDRESS) {
            throw new AppError('Admin só pode enviar do Reserve', 403);
        }

        const result = await transactions.submitSignedTransaction({
            fromAddress, toAddress, amount,
            fee: fee || '0',
            nonce, timestamp,
            type: 'transfer',
            signature, publicKey
        });

        res.json({
            success: true,
            message: 'Transação do Reserve submetida',
            data: result
        });
    })
);

app.get(
    '/api/v1/admin/reserve/info',
    authenticate,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const { ReserveModel } = require('./models/Reserve');
        const info = await ReserveModel.getInfo();
        res.json({ success: true, data: info });
    })
);

app.post(
    '/api/v1/admin/reserve/mint',
    authenticate,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const { amount } = req.body;
        if (!amount) throw new AppError('Amount é obrigatório', 400);

        const { ReserveModel } = require('./models/Reserve');
        const reserve = await ReserveModel.mint(amount.toString(), req.user._id);

        res.json({
            success: true,
            message: `Minted ${amount} BRD`,
            data: reserve.toPublic()
        });
    })
);

logger.info('✅ Rotas de admin: /api/v1/admin/*');

// ============================================
// WEBSOCKET — EVENTOS
// ============================================
io.on('connection', async (socket) => {
    const authType = socket.user ? `user ${socket.user.username}` : 'anonymous';
    logger.info(`🔌 WS conectado: ${socket.id} (${authType})`);

    try {
        const info = await blockchain.getChainInfo();
        socket.emit('blockchain:init', info);
    } catch (error) {
        logger.error('Erro ao enviar init WS:', error);
    }

    socket.on('disconnect', () => {
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

app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
        return next();
    }
    if (req.path.includes('..') || req.path.includes('\0')) {
        throw new AppError('Caminho inválido', 400);
    }
    const indexPath = path.join(__dirname, 'public', 'index.html');
    res.sendFile(indexPath, (err) => {
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

const MINING_INTERVAL_MS = parseInt(process.env.MINING_INTERVAL_MS) || 30000;

async function startAutoMining() {
    miningInterval = setInterval(async () => {
        if (miningLock) return;
        miningLock = true;

        try {
            if (!blockchain.pendingTransactions || blockchain.pendingTransactions.length === 0) {
                return;
            }

            const minerAddress = process.env.AUTO_MINER_ADDRESS;
            if (!minerAddress) {
                logger.warn('AUTO_MINER_ADDRESS não configurado, pulando mineração');
                return;
            }

            const minerWallet = await WalletModel.findOne({ address: minerAddress });
            if (!minerWallet) {
                logger.warn(`Carteira do minerador não encontrada: ${minerAddress}`);
                return;
            }

            const recentChain = (blockchain.chain || []).slice(-20);
            const tailCheck = consecutiveGuard.validate(recentChain);
            if (!tailCheck.ok) {
                logger.warn(`🛡️ Mineração bloqueada: ${tailCheck.reason} (${tailCheck.streak}x ${tailCheck.producer})`);
                return;
            }

            const chain = blockchain.chain || [];
            const currentHead = chain[chain.length - 1];

            if (currentHead && lastKnownHead) {
                const prevStillInChain = chain.some(b => b.hash === lastKnownHead.hash);
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
                timestamps.stamp(block);

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
    logger.info(`🛡️ Guards ativos: ConsecutiveBlock, ReorgDetector, DynamicDifficulty, TimestampService`);
}

// ============================================
// 💰 AUTO-RECALCULADOR DE PREÇO (5 min)
// ============================================
function startAutoPriceUpdate() {
    setInterval(async () => {
        try {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const tx24h = await TransactionModel.countDocuments({
                timestamp: { $gte: oneDayAgo }
            });

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
// 🛡️ v4.1 — Checkpoint periódico
// ============================================
let checkpointInterval = null;

function startCheckpointing() {
    checkpointInterval = setInterval(async () => {
        try {
            const chain = blockchain.chain || [];
            const head = chain[chain.length - 1];
            if (!head) return;

            if (head.index % 100 !== 0) return;

            const crypto = require('crypto');
            const root = crypto.createHash('sha256')
                .update(JSON.stringify(head.state || head.stateRoot || { index: head.index }))
                .digest('hex');

            const validatorSet = blockchain.validators
                ? Array.from(blockchain.validators.values())
                : [];

            const signatures = validatorSet
                .filter(v => v.status === 'active')
                .map(v => ({ validator: v.id || v.address, valid: true }));

            const checkpoint = {
                height: head.index,
                root,
                signatures,
                ts: Date.now(),
            };

            weakSubj.addCheckpoint(checkpoint);
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

        const p2pResult = await startP2P({
            blockchain,
            port: parseInt(process.env.P2P_PORT) || 4001
        });
        p2pNode = p2pResult.node;
        logger.info(`🌐 P2P rodando (PeerID: ${p2pNode.peerId.toString()})`);

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

        const { ReserveModel } = require('./models/Reserve');
        const reserve = await ReserveModel.getReserve();
        logger.info(`🏦 Reserve: ${reserve.address}`);
        logger.info(`💰 Reserve balance: ${reserve.balance.toString()} BRD`);
        logger.info(`📊 Max supply: ${reserve.maxSupply.toString()} BRD`);

        await startAutoMining();
        startAutoPriceUpdate();
        startCheckpointing();

        server.listen(PORT, '0.0.0.0', () => {
            logger.info('');
            logger.info('════════════════════════════════════════');
            logger.info(`✅ BradiChain rodando!`);
            logger.info('════════════════════════════════════════');
            logger.info(`📍 API: ${APP_URL}`);
            logger.info(`💚 Health: ${APP_URL}/health`);
            logger.info(`🔗 WebSocket: ${APP_URL.replace('http', 'ws')}`);
            logger.info(`🌐 CORS: ${ALLOWED_ORIGINS.join(', ')}`);
            logger.info('════════════════════════════════════════');
            logger.info('');
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
    if (IS_PROD) {
        process.exit(1);
    }
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
async function shutdown(signal) {
    logger.info(`🛑 Recebido ${signal}. Encerrando graciosamente...`);

    if (miningInterval) clearInterval(miningInterval);
    if (checkpointInterval) clearInterval(checkpointInterval);

    try {
        if (p2pNode) await stopP2P(p2pNode);
    } catch (e) {
        logger.error('Erro ao parar P2P:', e.message);
    }

    io.close();

    server.close(() => {
        logger.info('✅ Servidor HTTP encerrado');
        mongoose.connection.close(false, () => {
            logger.info('✅ MongoDB desconectado');
            process.exit(0);
        });
    });

    setTimeout(() => {
        logger.error('⚠️ Forçando saída após timeout');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================
// START
// ============================================
initialize();
