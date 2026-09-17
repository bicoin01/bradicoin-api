// server.js
// ============================================
// BradiChain - Servidor Principal (v3.0)
// ============================================
// 🔐 SEGURANÇA:
//   - Validação de env obrigatórias no boot
//   - CSP configurada (não desabilitada)
//   - CORS whitelist
//   - express-mongo-sanitize + hpp
//   - Body limit 1MB
//   - Rate limit por rota
//   - Rotas sensíveis com auth
//   - WebSocket autenticado
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
const blockchain = require('./blockchain');
const wallet = require('./wallet');
const transactions = require('./transactions');
const { logger } = require('./middleware/error');

// Models
const User = require('./models/User');
const WalletModel = require('./models/Wallet');
const TransactionModel = require('./models/Transaction');

// Middlewares
const { authenticate, requireAdmin, optionalAuth } = require('./middleware/auth');
const { errorHandler, notFoundHandler, asyncHandler, AppError } = require('./middleware/error');

// Routes
const authRoutes = require('./routes/auth');
const transactionRoutes = require('./routes/transaction');
const walletRoutes = require('./routes/wallet');
const reserveRoutes = require('./routes/reserve');
const reserveStakingRoutes = require('./routes/reserveStaking');
const { router: airdropRouter } = require('./routes/airdrop');

// ============================================
// CONFIGURAÇÃO
// ============================================
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = parseInt(process.env.PORT) || 3000;
const DOMAIN = process.env.DOMAIN || 'localhost';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Origens permitidas (CORS)
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

// Middleware de auth do WebSocket
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

// Helmet
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

// CORS
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

// Sanitização
app.use(mongoSanitize({ replaceWith: '_', allowDots: false }));
app.use(hpp());

// Compressão
app.use(compression());

// Body parsers
app.use(express.json({ limit: '1mb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ============================================
// LOGGER DE REQUISIÇÕES
// ============================================
if (IS_PROD) {
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            if (res.statusCode >= 400 || duration > 1000) {
                logger.warn('Request', {
                    method: req.method,
                    path: req.path,
                    status: res.statusCode,
                    duration
                });
            }
        });
        next();
    });
} else {
    app.use((req, res, next) => {
        logger.info(`${req.method} ${req.path}`);
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
        version: process.env.npm_package_version || '3.0.0',
        uptime: Math.floor(process.uptime()),
        environment: process.env.NODE_ENV || 'development',
        blockchain: info
    });
}));

// ============================================
// ROTAS DA API — v1
// ============================================

app.use('/api/v1/auth', authRoutes);
logger.info('✅ Rotas: /api/v1/auth');

app.use('/api/v1/wallet', walletRoutes);
logger.info('✅ Rotas: /api/v1/wallet');

app.use('/api/v1/transaction', txLimiter, transactionRoutes);
logger.info('✅ Rotas: /api/v1/transaction');

app.use('/api/v1/reserve', reserveRoutes);
app.use('/api/v1/reserve-staking', reserveStakingRoutes);
logger.info('✅ Rotas: /api/v1/reserve + /api/v1/reserve-staking');
app.use('/api/v1/token', require('./routes/token'));
logger.info('✅ Rotas: /api/v1/token');
app.use('/api/v1/nft', require('./routes/nft'));
logger.info('✅ Rotas: /api/v1/nft');
app.use('/api/v1/airdrop', airdropRouter);
logger.info('✅ Rotas: /api/v1/airdrop');

const tokenRoutes = require('./routes/token');
const nftRoutes = require('./routes/nft');

app.use('/api/v1/token', tokenRoutes);
logger.info('✅ Rotas: /api/v1/token');

app.use('/api/v1/nft', nftRoutes);
logger.info('✅ Rotas: /api/v1/nft');

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
            fromAddress,
            toAddress,
            amount,
            fee,
            nonce,
            timestamp,
            signature,
            publicKey
        } = req.body;

        if (fromAddress !== process.env.RESERVE_ADDRESS) {
            throw new AppError('Admin só pode enviar do Reserve', 403);
        }

        const result = await transactions.submitSignedTransaction({
            fromAddress,
            toAddress,
            amount,
            fee: fee || '0',
            nonce,
            timestamp,
            type: 'transfer',
            signature,
            publicKey
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

        if (!amount) {
            throw new AppError('Amount é obrigatório', 400);
        }

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

            const block = await blockchain.minePendingTransactions(minerAddress);
            if (block) {
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

        const { ReserveModel } = require('./models/Reserve');
        const reserve = await ReserveModel.getReserve();
        logger.info(`🏦 Reserve: ${reserve.address}`);
        logger.info(`💰 Reserve balance: ${reserve.balance.toString()} BRD`);
        logger.info(`📊 Max supply: ${reserve.maxSupply.toString()} BRD`);

        await startAutoMining();

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
