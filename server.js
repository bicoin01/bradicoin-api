// server.js
// ============================================
// Bradicoin Blockchain - Servidor Principal
// ============================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const winston = require('winston');

// ============================================
// VALIDAÇÃO DE VARIÁVEIS DE AMBIENTE
// ============================================
const REQUIRED_ENV = ['MONGO_URI', 'JWT_SECRET'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
    console.error(`❌ Variáveis de ambiente obrigatórias faltando: ${missingEnv.join(', ')}`);
    console.error('📄 Copie .env.example para .env e preencha os valores.');
    process.exit(1);
}

if (!process.env.MONGO_URI.startsWith('mongodb')) {
    console.error('❌ MONGO_URI inválida. Deve começar com "mongodb://" ou "mongodb+srv://".');
    process.exit(1);
}

// ============================================
// IMPORTAÇÕES LOCAIS
// ============================================
const blockchain = require('./blockchain');
const wallet = require('./wallet');
const transactions = require('./transactions');
const staking = require('./staking');
const validator = require('./validator');
const zkPrivacy = require('./zkPrivacy');
const explorer = require('./explorer');
const market = require('./market');

// ============================================
// IMPORTAÇÕES — AUTH
// ============================================
const mongoose = require('mongoose');
const authRoutes = require('./routes/auth');
const reserveRoutes = require('./routes/reserve');
const reserveStakingRoutes = require('./routes/reserveStaking');
const { errorHandler, notFoundHandler } = require('./middleware/error');

// ============================================
// CONFIGURAÇÃO DO LOGGER
// ============================================
const { logger } = require('./middleware/error');
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// ============================================
// INICIALIZAÇÃO DO EXPRESS
// ============================================
const app = express();
const server = http.createServer(app);

const corsOrigin = process.env.CORS_ORIGIN ||
    (process.env.NODE_ENV === 'production' ? false : '*');

const io = socketIo(server, {
    cors: {
        origin: corsOrigin,
        methods: ['GET', 'POST', 'PUT', 'DELETE']
    }
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet({
    contentSecurityPolicy: false // desativa CSP padrão para não bloquear o frontend
}));
app.use(cors({ origin: corsOrigin }));
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Confia no proxy (útil atrás de Nginx, Heroku, etc.)
app.set('trust proxy', 1);

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas requisições, tente novamente mais tarde.' }
});
app.use('/api', limiter);

// Logger de requisições
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`);
    next();
});

// ============================================
// ROTAS PÚBLICAS
// ============================================

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '2.0.0',
        uptime: process.uptime(),
        blockchain: {
            blocks: blockchain.chain ? blockchain.chain.length : 0,
            isValid: blockchain.isValid ? blockchain.isValid() : false,
            pending: blockchain.pendingTransactions ? blockchain.pendingTransactions.length : 0
        },
        network: {
            name: process.env.NETWORK_NAME || 'Bradicoin Mainnet',
            chainId: parseInt(process.env.CHAIN_ID) || 1
        }
    });
});

// ============================================
// ROTAS DA API
// ============================================

// ========== AUTH (v1) ==========
app.use('/api/v1/auth', authRoutes);
logger.info('✅ Rotas de auth montadas em /api/v1/auth');

// ========== FUNDO DE RESERVA ==========
app.use('/api/v1/reserve', reserveRoutes);
app.use('/api/v1/reserve-staking', reserveStakingRoutes);
logger.info('✅ Rotas do Fundo de Reserva montadas');

// ========== WALLET ==========
app.post('/api/wallet/create', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) {
            return res.status(400).json({ error: 'Username é obrigatório' });
        }

        const result = await wallet.createWallet(username);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao criar carteira:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/wallet/balance/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const result = await wallet.getBalance(address);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao consultar saldo:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/wallet/history/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const { limit = 50 } = req.query;
        const result = await wallet.getHistory(address, parseInt(limit));
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao buscar histórico:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== TRANSACTIONS ==========
app.post('/api/transaction/send', async (req, res) => {
    try {
        const { from, to, amount, fee } = req.body;

        if (!from || !to || !amount) {
            return res.status(400).json({ error: 'Dados incompletos' });
        }

        const result = await transactions.sendTransaction(from, to, amount, fee || 0);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao enviar transação:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/transaction/:hash', async (req, res) => {
    try {
        const { hash } = req.params;
        const result = await transactions.getTransactionByHash(hash);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao buscar transação:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== STAKING ==========
app.post('/api/staking/stake', async (req, res) => {
    try {
        const { address, amount } = req.body;

        if (!address || !amount) {
            return res.status(400).json({ error: 'Dados incompletos' });
        }

        const result = await staking.stake(address, amount);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao fazer stake:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/staking/unstake', async (req, res) => {
    try {
        const { address, amount } = req.body;

        if (!address || !amount) {
            return res.status(400).json({ error: 'Dados incompletos' });
        }

        const result = await staking.unstake(address, amount);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao fazer unstake:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/staking/rewards/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const result = await staking.getRewards(address);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao buscar recompensas:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== VALIDATORS ==========
app.post('/api/validator/register', async (req, res) => {
    try {
        const { address, stake } = req.body;

        if (!address || !stake) {
            return res.status(400).json({ error: 'Dados incompletos' });
        }

        const result = await validator.register(address, stake);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao registrar validador:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/validator/list', async (req, res) => {
    try {
        const result = await validator.getValidators();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao listar validadores:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== EXPLORER ==========
app.get('/api/explorer/blocks', async (req, res) => {
    try {
        const { limit = 20, offset = 0 } = req.query;
        const result = await explorer.getBlocks(parseInt(limit), parseInt(offset));
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao buscar blocos:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/explorer/block/:index', async (req, res) => {
    try {
        const { index } = req.params;
        const result = await explorer.getBlockByIndex(parseInt(index));
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao buscar bloco:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== ZK-SNARK ==========
app.post('/api/zk/generate-proof', async (req, res) => {
    try {
        const { data } = req.body;
        const result = await zkPrivacy.generateProof(data);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao gerar prova ZK:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/zk/verify-proof', async (req, res) => {
    try {
        const { proof, publicSignals } = req.body;
        const result = await zkPrivacy.verifyProof(proof, publicSignals);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao verificar prova ZK:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== MARKET ==========
app.get('/api/market/price', async (req, res) => {
    try {
        const result = await market.getPrice();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Erro ao buscar preço:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// WEBSOCKET - ATUALIZAÇÕES EM TEMPO REAL
// ============================================
io.on('connection', async (socket) => {
    logger.info(`🔌 Cliente conectado: ${socket.id}`);

    try {
        let validatorsCount = 0;
        if (validator.getValidators) {
            const validators = await validator.getValidators();
            validatorsCount = Array.isArray(validators) ? validators.length : 0;
        }

        socket.emit('blockchain:init', {
            blocks: blockchain.chain ? blockchain.chain.length : 0,
            transactions: blockchain.pendingTransactions ? blockchain.pendingTransactions.length : 0,
            validators: validatorsCount
        });
    } catch (error) {
        logger.error('Erro ao enviar dados iniciais via WS:', error);
    }

    socket.on('disconnect', () => {
        logger.info(`🔌 Cliente desconectado: ${socket.id}`);
    });
});

// ============================================
// MIDDLEWARES DE ERRO (DEVEM SER OS ÚLTIMOS)
// ============================================
app.use(notFoundHandler);
app.use(errorHandler);

// ============================================
// SERVIÇO DE ARQUIVOS ESTÁTICOS
// ============================================
app.use(express.static(path.join(__dirname, 'public')));

// Fallback para SPA — serve HTML se existir, senão deixa passar
app.get('*', (req, res, next) => {
    // Deixa as rotas /api passarem como 404 JSON
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'Rota não encontrada' });
    }

    // Tenta servir o arquivo específico (ex: /wallet.html)
    const safePath = req.path.replace(/^\//, '').split('?')[0];
    if (safePath && safePath.includes('.')) {
        const filePath = path.join(__dirname, 'public', safePath);
        return res.sendFile(filePath, (err) => {
            if (err) next();
        });
    }

    // Senão, serve index.html (SPA fallback)
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) next();
    });
});

// ============================================
// MINERAÇÃO AUTOMÁTICA
// ============================================
const AUTO_MINER_ADDRESS = process.env.AUTO_MINER_ADDRESS || 'BrAutoMiner';
const AUTO_MINER_USERNAME = process.env.AUTO_MINER_USERNAME || 'AutoMiner';
const MINING_INTERVAL_MS = parseInt(process.env.MINING_INTERVAL_MS) || 30000;

let miningInterval = null;

async function startAutoMining() {
    miningInterval = setInterval(async () => {
        try {
            if (blockchain.pendingTransactions && blockchain.pendingTransactions.length > 0) {
                // Verifica se o minerador já existe
                const balance = await wallet.getBalance(AUTO_MINER_ADDRESS);

                if (!balance || !balance.exists) {
                    try {
                        await wallet.createWallet(AUTO_MINER_USERNAME);
                        logger.info(`👤 Carteira do minerador automático criada: ${AUTO_MINER_ADDRESS}`);
                    } catch (createErr) {
                        // Se já existe (race condition), ignora
                        logger.warn(`Minerador já existe: ${createErr.message}`);
                    }
                }

                const block = await blockchain.minePendingTransactions(AUTO_MINER_ADDRESS);
                if (block) {
                    logger.info(`⛏️ Bloco ${block.index} minerado automaticamente`);
                    io.emit('block:mined', block);
                }
            }
        } catch (error) {
            logger.error('Erro na mineração automática:', error);
        }
    }, MINING_INTERVAL_MS);
}

// ============================================
// DISTRIBUIÇÃO DE REWARDS
// ============================================
const REWARD_INTERVAL_MS = parseInt(process.env.REWARD_INTERVAL_MS) || 3600000;

let rewardInterval = null;

async function startRewardDistribution() {
    rewardInterval = setInterval(async () => {
        try {
            const stakers = await staking.getActiveStakers();
            if (!Array.isArray(stakers)) return;

            for (const staker of stakers) {
                const reward = await staking.calculateReward(staker.address);
                if (reward > 0) {
                    await staking.distributeReward(staker.address, reward);
                    logger.info(`💰 ${reward.toFixed(2)} BRD distribuído para ${staker.address}`);
                    io.emit('staking:reward', { address: staker.address, reward });
                }
            }
        } catch (error) {
            logger.error('Erro na distribuição de rewards:', error);
        }
    }, REWARD_INTERVAL_MS);
}

// ============================================
// CONEXÃO COM MONGODB
// ============================================
async function connectMongoDB() {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000
        });
        logger.info('✅ MongoDB conectado');
    } catch (error) {
        logger.error('❌ Erro ao conectar MongoDB:', error);
        process.exit(1);
    }
}

// ============================================
// INICIALIZAÇÃO
// ============================================
async function initialize() {
    try {
        logger.info('🚀 Inicializando Bradicoin Blockchain...');

        // Conecta no MongoDB PRIMEIRO
        await connectMongoDB();
        
        // Inicializa todos os módulos em sequência
        await blockchain.initialize();
        await wallet.initialize();
        await transactions.initialize();
        await staking.initialize();
        await validator.initialize();
        await zkPrivacy.initialize();
        await explorer.initialize();
        await market.initialize();

        logger.info('✅ Todos os módulos inicializados');

        // Inicia serviços automáticos
        await startAutoMining();
        await startRewardDistribution();

        // Inicia o servidor HTTP
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            logger.info(`✅ Bradicoin Blockchain rodando na porta ${PORT}`);
            logger.info(`📍 API: http://localhost:${PORT}`);
            logger.info(`🌐 Frontend: http://localhost:${PORT}`);
            logger.info(`🔗 WebSocket: ws://localhost:${PORT}`);
            logger.info(`💚 Health: http://localhost:${PORT}/health`);
        });
    } catch (error) {
        logger.error('❌ Erro ao inicializar:', error);
        process.exit(1);
    }
}

// ============================================
// TRATAMENTO DE ERROS
// ============================================
process.on('unhandledRejection', (error) => {
    logger.error('❌ Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
    logger.error('❌ Uncaught Exception:', error);
    // Em produção, deixar o processo cair é mais seguro que rodar em estado corrompido
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
async function shutdown(signal) {
    logger.info(`🛑 Recebido ${signal}. Encerrando...`);

    if (miningInterval) clearInterval(miningInterval);
    if (rewardInterval) clearInterval(rewardInterval);

    server.close(() => {
        logger.info('✅ Servidor HTTP encerrado');
        process.exit(0);
    });

    // Força saída depois de 10s
    setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================
// INICIAR
// ============================================
initialize();
