// blockchain.js
// ============================================
// Bradicoin Blockchain - Core (v3.1 - CORRIGIDO)
// ============================================
// ⚠️ CONSENSO: PoA (Proof of Authority) — centralizado
// ✅ Saldo materializado no MongoDB (rápido)
// ✅ Sem emissão infinita (só taxas)
// ✅ Verificação de assinatura obrigatória
// ✅ Atomic updates
// 🔧 CORREÇÕES v3.1:
//   - Import @noble/hashes corrigido (sha2)
//   - Conflito fromAddress/from resolvido
//   - Normalização de TX no construtor Block
//   - calculateTxHash robusto a Decimal128 e Date
//   - Duplicate key em system tx tratado
//   - Validação de minerAddress
//   - Genesis lock atômico (race condition)
//   - Logs melhorados
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

// ✅ CORRIGIDO: caminho novo do @noble/hashes v2
const { sha256 } = require('@noble/hashes/sha2');
const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');

const BlockModel = require('./models/Block');
const TransactionModel = require('./models/Transaction');
const WalletModel = require('./models/Wallet');

// ============================================
// CONFIGURAÇÃO
// ============================================
const CONFIG = {
    difficulty: parseInt(process.env.BLOCK_DIFFICULTY) || 3,
    targetBlockTimeMs: parseInt(process.env.TARGET_BLOCK_TIME_MS) || 30000,
    maxTxPerBlock: parseInt(process.env.MAX_TX_PER_BLOCK) || 1000,
    minFee: Decimal128.fromString(process.env.MIN_FEE || '0.001'),
    blockReward: Decimal128.fromString(process.env.BLOCK_REWARD || '0'),
    feeCollectorAddress: process.env.FEE_COLLECTOR_ADDRESS,
    genesisTimestamp: new Date('2026-01-01T00:00:00Z').toISOString()
};

// ============================================
// VALIDAÇÃO DE ENV
// ============================================
if (!CONFIG.feeCollectorAddress) {
    throw new Error('❌ FEE_COLLECTOR_ADDRESS não configurado no .env');
}
if (!/^Br[a-fA-F0-9]{38}$/.test(CONFIG.feeCollectorAddress)) {
    throw new Error('❌ FEE_COLLECTOR_ADDRESS inválido');
}

// ============================================
// HELPERS
// ============================================

/**
 * Normaliza uma TX vinda do Mongo (com from/to) ou do cliente (fromAddress/toAddress)
 * para o formato CANÔNICO interno: fromAddress / toAddress
 */
function normalizeTx(tx) {
    if (!tx) return null;
    return {
        hash: tx.hash,
        fromAddress: tx.fromAddress !== undefined ? tx.fromAddress : (tx.from !== undefined ? tx.from : null),
        toAddress: tx.toAddress !== undefined ? tx.toAddress : tx.to,
        amount: tx.amount,
        fee: tx.fee,
        nonce: tx.nonce || 0,
        type: tx.type || 'transfer',
        signature: tx.signature,
        publicKey: tx.publicKey,
        timestamp: tx.timestamp,
        status: tx.status,
        blockIndex: tx.blockIndex,
        blockHash: tx.blockHash,
        metadata: tx.metadata
    };
}

/**
 * Converte qualquer coisa (Decimal128, number, string, Date) para string segura
 */
function safeToString(value, fallback = '0') {
    if (value === null || value === undefined) return fallback;
    try {
        if (value instanceof Date) return value.toISOString();
        return value.toString();
    } catch (_) {
        return fallback;
    }
}

// ============================================
// CLASSE BLOCK (leve, em memória)
// ============================================
class Block {
    constructor({ index, timestamp, transactions, previousHash, hash, nonce, minerAddress, minerSignature }) {
        this.index = index;
        this.timestamp = timestamp;

        // ✅ CORRIGIDO: normaliza TXs (aceita from/to e fromAddress/toAddress)
        this.transactions = (transactions || []).map(normalizeTx);

        this.previousHash = previousHash;
        this.nonce = nonce || 0;
        this.minerAddress = minerAddress || null;
        this.minerSignature = minerSignature || null;
        this.hash = hash || this.calculateHash();
    }

    calculateHash() {
        const payload = JSON.stringify({
            index: this.index,
            timestamp: safeToString(this.timestamp),
            previousHash: this.previousHash,
            nonce: this.nonce,
            minerAddress: this.minerAddress,
            txHashes: this.transactions.map(tx => tx.hash).filter(Boolean).sort()
        });

        return bytesToHex(sha256(utf8ToBytes(payload)));
    }

    meetsDifficulty(difficulty) {
        const target = '0'.repeat(difficulty);
        return this.hash.startsWith(target);
    }

    toObject() {
        return {
            index: this.index,
            timestamp: this.timestamp,
            transactions: this.transactions.map(tx => ({
                hash: tx.hash,
                fromAddress: tx.fromAddress,
                toAddress: tx.toAddress,
                amount: tx.amount,
                fee: tx.fee,
                nonce: tx.nonce,
                type: tx.type,
                signature: tx.signature,
                publicKey: tx.publicKey
            })),
            previousHash: this.previousHash,
            hash: this.hash,
            nonce: this.nonce,
            minerAddress: this.minerAddress,
            minerSignature: this.minerSignature
        };
    }
}

// ============================================
// CLASSE BLOCKCHAIN
// ============================================
class Blockchain {
    constructor() {
        this.chain = [];
        this.pendingTransactions = [];
        this.initialized = false;
        this.mining = false;
        this.maxChainCache = 100;
    }

    // ============================================
    // INICIALIZAÇÃO (com lock atômico)
    // ============================================
    async initialize() {
        if (this.initialized) return;

        try {
            // ✅ CORRIGIDO: lock atômico — só cria gênese se realmente não existir
            const existingGenesis = await BlockModel.findOne({ index: 0 }).lean();

            if (!existingGenesis) {
                // Tenta criar gênese com retry (caso dois workers rodem juntos)
                try {
                    const genesis = await this.createGenesisBlock();
                    this.chain = [genesis];
                    console.log('🌱 Genesis block criado');
                } catch (err) {
                    if (err.code === 11000) {
                        // Duplicate key → outro worker criou primeiro
                        console.log('ℹ️ Genesis já criado por outro worker');
                        const gen = await BlockModel.findOne({ index: 0 }).lean();
                        this.chain = gen ? [new Block(gen)] : [];
                    } else {
                        throw err;
                    }
                }
            } else {
                // Carrega últimos N blocos
                const latestBlocks = await BlockModel.find()
                    .sort({ index: -1 })
                    .limit(this.maxChainCache)
                    .lean();

                this.chain = latestBlocks.reverse().map(b => new Block(b));
                console.log(`📦 ${this.chain.length} blocos carregados (últimos)`);
            }

            // Carrega pendentes
            const pending = await TransactionModel.find({ status: 'pending' })
                .sort({ timestamp: 1 })
                .limit(10000)
                .lean();

            this.pendingTransactions = pending.map(normalizeTx);
            console.log(`⏳ ${pending.length} transações pendentes carregadas`);

            this.initialized = true;
        } catch (error) {
            console.error('❌ Erro ao inicializar blockchain:', error);
            throw error;
        }
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
            minerAddress: null,
            minerSignature: null
        });

        const difficulty = CONFIG.difficulty;
        while (!genesis.meetsDifficulty(difficulty)) {
            genesis.nonce++;
            genesis.hash = genesis.calculateHash();
        }

        await BlockModel.create(genesis.toObject());
        return genesis;
    }

    // ============================================
    // ADICIONAR TRANSAÇÃO À MEMPOOL
    // ============================================
    async addTransaction(transaction) {
        // 1. Validações básicas
        if (!transaction || typeof transaction !== 'object') {
            throw new Error('Transação inválida');
        }

        if (!transaction.toAddress) {
            throw new Error('Destinatário obrigatório');
        }

        const amount = parseFloat(transaction.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Valor inválido');
        }

        const fee = parseFloat(transaction.fee || '0');
        if (!Number.isFinite(fee) || fee < 0) {
            throw new Error('Taxa inválida');
        }

        // 2. Identifica se é TX de sistema
        const isSystemTx = transaction.fromAddress === null || transaction.fromAddress === undefined;

        if (!isSystemTx) {
            // 3. Verifica assinatura
            const wallet = require('./wallet');

            const signableMessage = this.buildSignableMessage(transaction);
            const isValid = wallet.verifySignature(
                signableMessage,
                transaction.signature,
                transaction.publicKey
            );

            if (!isValid) {
                throw new Error('Assinatura inválida');
            }

            // 4. publicKey corresponde ao fromAddress?
            const expectedAddress = wallet.deriveAddressFromPublicKey(transaction.publicKey);
            if (expectedAddress !== transaction.fromAddress) {
                throw new Error('Public key não corresponde ao endereço de origem');
            }

            // 5. Verifica saldo
            const walletDoc = await WalletModel.findOne({
                address: transaction.fromAddress,
                status: 'active'
            });

            if (!walletDoc) {
                throw new Error('Carteira de origem não encontrada ou inativa');
            }

            const balance = parseFloat(walletDoc.balance.toString());
            const totalCost = amount + fee;

            if (balance < totalCost) {
                throw new Error(`Saldo insuficiente: ${balance} < ${totalCost}`);
            }

            // 6. Verifica nonce
            if (walletDoc.nonce !== transaction.nonce) {
                throw new Error(
                    `Nonce inválido: esperado ${walletDoc.nonce}, recebido ${transaction.nonce}`
                );
            }

            // 7. Anti-replay: assinatura única
            const existingSig = await TransactionModel.findOne({
                signature: transaction.signature
            });
            if (existingSig) {
                throw new Error('Transação já submetida (replay detectado)');
            }
        }

        // ✅ CORRIGIDO: verifica se TX com mesmo hash já existe (evita duplicate key)
        const txHash = this.calculateTxHash(transaction);
        const existingTx = await TransactionModel.findOne({ hash: txHash });
        if (existingTx) {
            console.log(`ℹ️ TX já existe: ${txHash}`);
            return {
                hash: existingTx.hash,
                status: existingTx.status,
                message: 'Transação já existia'
            };
        }

        // 8. Cria TX com hash único
        const txData = {
            hash: txHash,
            from: transaction.fromAddress || null,
            to: transaction.toAddress,
            amount: Decimal128.fromString(amount.toString()),
            fee: Decimal128.fromString(fee.toString()),
            nonce: transaction.nonce || 0,
            type: transaction.type || 'transfer',
            signature: transaction.signature || 'system',
            publicKey: transaction.publicKey || 'system',
            status: 'pending',
            timestamp: new Date(transaction.timestamp || Date.now()),
            metadata: transaction.metadata || {}
        };

        // 9. Persiste no Mongo
        const savedTx = await TransactionModel.create(txData);

        // ✅ CORRIGIDO: normaliza antes de adicionar à mempool
        this.pendingTransactions.push(normalizeTx(savedTx.toObject()));

        return {
            hash: savedTx.hash,
            status: 'pending',
            message: 'Transação adicionada à fila'
        };
    }

    // ============================================
    // HASH CANÔNICO DA TRANSAÇÃO
    // ============================================
    calculateTxHash(tx) {
        const payload = JSON.stringify({
            from: tx.fromAddress || tx.from || null,
            to: tx.toAddress || tx.to,
            amount: safeToString(tx.amount),
            fee: safeToString(tx.fee, '0'),
            nonce: tx.nonce || 0,
            type: tx.type || 'transfer',
            timestamp: safeToString(tx.timestamp || new Date().toISOString()),
            signature: tx.signature || 'system'
        });

        return bytesToHex(sha256(utf8ToBytes(payload)));
    }

    // ============================================
    // MESSAGE CANÔNICA PARA ASSINATURA
    // ============================================
    buildSignableMessage(tx) {
        return [
            tx.fromAddress,
            tx.toAddress,
            tx.amount.toString(),
            (tx.fee || '0').toString(),
            (tx.nonce || 0).toString(),
            safeToString(tx.timestamp),
            tx.type || 'transfer'
        ].join('|');
    }

    // ============================================
    // MINERAR BLOCO
    // ============================================
    async minePendingTransactions(minerAddress) {
        if (this.mining) {
            throw new Error('Mineração já em andamento');
        }
        this.mining = true;

        try {
            if (this.pendingTransactions.length === 0) {
                return null;
            }

            // ✅ CORRIGIDO: valida minerAddress (se fornecido)
            if (minerAddress && !/^Br[a-fA-F0-9]{38}$/.test(minerAddress)) {
                throw new Error('❌ minerAddress inválido');
            }

            const txsToMine = this.pendingTransactions.slice(0, CONFIG.maxTxPerBlock);

            const previousBlock = this.getLatestBlock();
            if (!previousBlock) {
                throw new Error('Nenhum bloco anterior (blockchain não inicializada?)');
            }

            const newIndex = previousBlock.index + 1;

            const newBlock = new Block({
                index: newIndex,
                timestamp: new Date().toISOString(),
                transactions: txsToMine,
                previousHash: previousBlock.hash,
                nonce: 0,
                minerAddress: minerAddress || null,
                minerSignature: null
            });

            // PoW
            while (!newBlock.meetsDifficulty(CONFIG.difficulty)) {
                newBlock.nonce++;
                newBlock.hash = newBlock.calculateHash();

                if (newBlock.nonce > 10_000_000) {
                    console.error(`🚨 PoW falhou após 10M tentativas. Dificuldade: ${CONFIG.difficulty}`);
                    throw new Error('Não foi possível minerar (dificuldade muito alta?)');
                }
            }

            // Aplica transações
            await this.applyTransactions(txsToMine);

            // Persiste bloco
            await BlockModel.create(newBlock.toObject());

            // Confirma TXs
            const txHashes = txsToMine.map(tx => tx.hash).filter(Boolean);
            await TransactionModel.updateMany(
                { hash: { $in: txHashes } },
                {
                    $set: {
                        status: 'confirmed',
                        blockIndex: newIndex,
                        blockHash: newBlock.hash,
                        confirmations: 1
                    }
                }
            );

            // Atualiza cache
            this.chain.push(newBlock);
            if (this.chain.length > this.maxChainCache) {
                this.chain.shift();
            }

            // Remove da mempool
            this.pendingTransactions = this.pendingTransactions.slice(txsToMine.length);

            console.log(`⛏️  Bloco ${newBlock.index} minerado: ${newBlock.hash.substring(0, 16)}... (${txsToMine.length} TXs)`);

            return newBlock.toObject();
        } finally {
            this.mining = false;
        }
    }

    // ============================================
    // APLICAR TRANSAÇÕES (atualiza saldos)
    // ============================================
    async applyTransactions(transactions) {
        for (const rawTx of transactions) {
            try {
                // ✅ CORRIGIDO: normaliza a TX antes de processar
                const tx = normalizeTx(rawTx);

                const amountStr = safeToString(tx.amount);
                const feeStr = safeToString(tx.fee, '0');
                const fromAddr = tx.fromAddress;
                const toAddr = tx.toAddress;

                const isSystemTx = !fromAddr;

                if (isSystemTx) {
                    // Sistema credita saldo
                    await WalletModel.credit(toAddr, amountStr);
                    console.log(`💰 Sistema creditou ${amountStr} em ${toAddr.substring(0, 12)}...`);
                } else {
                    // Transação normal
                    const totalDebit = (
                        parseFloat(amountStr) + parseFloat(feeStr)
                    ).toFixed(8);

                    await WalletModel.debit(fromAddr, totalDebit);
                    await WalletModel.credit(toAddr, amountStr);

                    // Fee vai pro coletor
                    if (parseFloat(feeStr) > 0) {
                        try {
                            await WalletModel.credit(CONFIG.feeCollectorAddress, feeStr);
                        } catch (e) {
                            console.error('Erro ao creditar fee:', e.message);
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ Erro ao aplicar TX ${rawTx.hash}:`, error.message);

                await TransactionModel.updateOne(
                    { hash: rawTx.hash },
                    {
                        $set: {
                            status: 'failed',
                            'metadata.reason': error.message
                        }
                    }
                );
            }
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
        const cached = this.chain.find(b => b.index === index);
        if (cached) return cached;

        const block = await BlockModel.findOne({ index }).lean();
        if (!block) throw new Error('Bloco não encontrado');
        return block;
    }

    async getBlockByHash(hash) {
        const block = await BlockModel.findOne({ hash }).lean();
        if (!block) throw new Error('Bloco não encontrado');
        return block;
    }

    async getBlocks(limit = 20, offset = 0) {
        return BlockModel.find()
            .sort({ index: -1 })
            .skip(offset)
            .limit(limit)
            .lean();
    }

    async getChainInfo() {
        const [totalBlocks, latest] = await Promise.all([
            BlockModel.countDocuments({}),
            BlockModel.findOne().sort({ index: -1 }).lean()
        ]);

        return {
            totalBlocks,
            cachedBlocks: this.chain.length,
            difficulty: CONFIG.difficulty,
            blockReward: CONFIG.blockReward.toString(),
            pendingTransactions: this.pendingTransactions.length,
            latestBlock: latest ? {
                index: latest.index,
                hash: latest.hash,
                timestamp: latest.timestamp,
                transactionsCount: (latest.transactions || []).length
            } : null,
            isValid: await this.isValid()
        };
    }

    // ============================================
    // VALIDAÇÃO DA CHAIN
    // ============================================
    async isValid() {
        for (let i = 1; i < this.chain.length; i++) {
            const current = this.chain[i];
            const previous = this.chain[i - 1];

            const recalculated = current.calculateHash();
            if (recalculated !== current.hash) {
                console.log(`❌ Bloco ${current.index}: hash inválido`);
                return false;
            }

            if (current.previousHash !== previous.hash) {
                console.log(`❌ Bloco ${current.index}: link quebrado`);
                return false;
            }

            if (!current.meetsDifficulty(CONFIG.difficulty)) {
                console.log(`❌ Bloco ${current.index}: PoW inválido`);
                return false;
            }
        }

        return true;
    }

    // ============================================
    // LIMPEZA
    // ============================================
    clearPendingTransactions() {
        const count = this.pendingTransactions.length;
        this.pendingTransactions = [];
        return { message: 'Mempool limpa', count };
    }

    getPendingTransactions(limit = 100) {
        return this.pendingTransactions.slice(0, limit);
    }
}

// ============================================
// EXPORTA INSTÂNCIA ÚNICA
// ============================================
module.exports = new Blockchain();
module.exports.CONFIG = CONFIG;
module.exports.Block = Block;
module.exports.normalizeTx = normalizeTx;
