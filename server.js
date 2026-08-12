// server.js
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
// CONFIGURAÇÃO DO LOGGER
// ============================================
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
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
const io = socketIo(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE']
    }
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Muitas requisições, tente novamente mais tarde.'
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

// ========== WALLET ==========
app.post('/api/wallet/create', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) {
            return res.status(400).json({ error: 'Username é obrigatório' });
        }

        const result = await wallet.createWallet(username);
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Erro ao criar carteira:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/wallet/balance/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const result = await wallet.getBalance(address);
        res.json({
            success: true,
            data: result
        });
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
        res.json({
            success: true,
            data: result
        });
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
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Erro ao enviar transação:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/transaction/:hash', async (req, res) => {
    try {
        const { hash } = req.params;
        const result = await transactions.getTransactionByHash(hash);
        res.json({
            success: true,
            data: result
        });
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
        res.json({
            success: true,
            data: result
        });
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
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Erro ao fazer unstake:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/staking/rewards/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const result = await staking.getRewards(address);
        res.json({
            success: true,
            data: result
        });
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
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Erro ao registrar validador:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/validator/list', async (req, res) => {
    try {
        const result = await validator.getValidators();
        res.json({
            success: true,
            data: result
        });
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
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Erro ao buscar blocos:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/explorer/block/:index', async (req, res) => {
    try {
        const { index } = req.params;
        const result = await explorer.getBlockByIndex(parseInt(index));
        res.json({
            success: true,
            data: result
        });
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
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Erro ao gerar prova ZK:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/zk/verify-proof', async (req, res) => {
    try {
        const { proof, publicSignals } = req.body;
        const result = await zkPrivacy.verifyProof(proof, publicSignals);
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Erro ao verificar prova ZK:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== MARKET ==========
app.get('/api/market/price', async (req, res) => {
    try {
        const result = await market.getPrice();
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Erro ao buscar preço:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// WEBSOCKET - ATUALIZAÇÕES EM TEMPO REAL
// ============================================
io.on('connection', (socket) => {
    logger.info(`🔌 Cliente conectado: ${socket.id}`);
    
    // Envia dados iniciais
    socket.emit('blockchain:init', {
        blocks: blockchain.chain ? blockchain.chain.length : 0,
        transactions: blockchain.pendingTransactions ? blockchain.pendingTransactions.length : 0,
        validators: validator.getValidators ? (await validator.getValidators()).length : 0
    });
    
    socket.on('disconnect', () => {
        logger.info(`🔌 Cliente desconectado: ${socket.id}`);
    });
});

// ============================================
// SERVIÇO DE ARQUIVOS ESTÁTICOS
// ============================================
app.use(express.static(path.join(__dirname, 'public')));

// Fallback para SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// MINERAÇÃO AUTOMÁTICA
// ============================================
async function startAutoMining() {
    setInterval(async () => {
        try {
            if (blockchain.pendingTransactions && blockchain.pendingTransactions.length > 0) {
                const minerAddress = 'BrAutoMiner';
                
                // Cria minerador se não existir
                const balance = await wallet.getBalance(minerAddress);
                if (!balance.exists) {
                    await wallet.createWallet('AutoMiner');
                }
                
                const block = await blockchain.minePendingTransactions(minerAddress);
                if (block) {
                    logger.info(`⛏️ Bloco ${block.index} minerado automaticamente`);
                    io.emit('block:mined', block);
                }
            }
        } catch (error) {
            logger.error('Erro na mineração automática:', error);
        }
    }, 30000);
}

// ============================================
// DISTRIBUIÇÃO DE REWARDS
// ============================================
async function startRewardDistribution() {
    setInterval(async () => {
        try {
            const stakers = await staking.getActiveStakers();
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
    }, 3600000);
}

// ============================================
// INICIALIZAÇÃO
// ============================================
async function initialize() {
    try {
        logger.info('🚀 Inicializando Bradicoin Blockchain...');
        
        // Inicializa todos os módulos
        await blockchain.initialize();
        await wallet.initialize();
        await transactions.initialize();
        await staking.initialize();
        await validator.initialize();
        await zkPrivacy.initialize();
        await explorer.initialize();
        await market.initialize();
        
        // Inicia serviços automáticos
        await startAutoMining();
        await startRewardDistribution();
        
        // Inicia o servidor
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            logger.info(`✅ Bradicoin Blockchain rodando na porta ${PORT}`);
            logger.info(`📍 API: http://localhost:${PORT}`);
            logger.info(`🌐 Frontend: http://localhost:${PORT}`);
            logger.info(`🔗 WebSocket: ws://localhost:${PORT}`);
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
});

// ============================================
// INICIAR
// ============================================
initialize();
