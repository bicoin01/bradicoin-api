// blockchain.js
// ============================================
// Bradicoin Blockchain - Core (v3.0)
// ============================================
// ⚠️ CONSENSO: PoA (Proof of Authority) — centralizado
// ✅ Saldo materializado no MongoDB (rápido)
// ✅ Sem emissão infinita (só taxas)
// ✅ Verificação de assinatura obrigatória
// ✅ Atomic updates
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;
const { sha256 } = require('@noble/hashes/sha256');
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
    blockReward: Decimal128.fromString(process.env.BLOCK_REWARD || '0'), // ZERO por padrão (só taxas)
    feeCollectorAddress: process.env.FEE_COLLECTOR_ADDRESS, // recebe as taxas
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
// CLASSE BLOCK (leve, em memória)
// ============================================
class Block {
    constructor({ index, timestamp, transactions, previousHash, hash, nonce, minerAddress, minerSignature }) {
        this.index = index;
        this.timestamp = timestamp;
        this.transactions = transactions;
        this.previousHash = previousHash;
        this.nonce = nonce || 0;
        this.minerAddress = minerAddress || null;
        this.minerSignature = minerSignature || null;
        this.hash = hash || this.calculateHash();
    }

    calculateHash() {
        const payload = JSON.stringify({
            index: this.index,
            timestamp: this.timestamp,
            previousHash: this.previousHash,
            nonce: this.nonce,
            minerAddress: this.minerAddress,
            txHashes: this.transactions.map(tx => tx.hash).sort()
        });

        return bytesToHex(sha256(utf8ToBytes(payload)));
    }

    // PoW simples (para validação, não para segurança real)
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
        this.chain = [];              // cache em memória (últimos N blocos)
        this.pendingTransactions = []; // mempool
        this.initialized = false;
        this.mining = false;          // lock para evitar mineração paralela
        this.maxChainCache = 100;     // só cacheia últimos 100 blocos
    }

    // ============================================
    // INICIALIZAÇÃO
    // ============================================
    async initialize() {
        if (this.initialized) return;

        try {
            // 1. Carrega últimos N blocos do Mongo
            const latestBlocks = await BlockModel.find()
                .sort({ index: -1 })
                .limit(this.maxChainCache)
                .lean();

            if (latestBlocks.length === 0) {
                // Cria gênese
                const genesis = await this.createGenesisBlock();
                this.chain = [genesis];
                console.log('🌱 Genesis block criado');
            } else {
                // Reconstrói em ordem crescente
                this.chain = latestBlocks.reverse().map(b => new Block(b));
                console.log(`📦 ${this.chain.length} blocos carregados (últimos)`);
            }

            // 2. Carrega transações pendentes do Mongo (se houver persistência)
            const pending = await TransactionModel.find({ status: 'pending' })
                .sort({ timestamp: 1 })
                .limit(10000)
                .lean();

            this.pendingTransactions = pending;
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

        // Ajusta até bater a dificuldade
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

        // 2. Transações do sistema (fromAddress = null) não precisam de assinatura
        //    Exemplos: wallet_creation (saldo inicial), mint, airdrop
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

            // 4. Verifica que publicKey corresponde ao fromAddress
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

        // 8. Cria transação com hash único
        const txData = {
            hash: this.calculateTxHash(transaction),
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

        // 9. Persiste no Mongo (pending)
        const savedTx = await TransactionModel.create(txData);

        // 10. Adiciona à mempool em memória
        this.pendingTransactions.push(savedTx.toObject());

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
            from: tx.fromAddress || null,
            to: tx.toAddress,
            amount: tx.amount.toString(),
            fee: (tx.fee || '0').toString(),
            nonce: tx.nonce || 0,
            type: tx.type || 'transfer',
            timestamp: tx.timestamp || new Date().toISOString(),
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
            tx.nonce.toString(),
            tx.timestamp,
            tx.type || 'transfer'
        ].join('|');
    }

    // ============================================
    // MINERAR BLOCO
    // ============================================
    async minePendingTransactions(minerAddress) {
        // 🔒 Lock (evita mineração paralela)
        if (this.mining) {
            throw new Error('Mineração já em andamento');
        }
        this.mining = true;

        try {
            // 1. Pega transações pendentes
            if (this.pendingTransactions.length === 0) {
                return null; // nada a minerar
            }

            const txsToMine = this.pendingTransactions.slice(0, CONFIG.maxTxPerBlock);

            // 2. Cria bloco
            const previousBlock = this.getLatestBlock();
            const newIndex = previousBlock.index + 1;

            const newBlock = new Block({
                index: newIndex,
                timestamp: new Date().toISOString(),
                transactions: txsToMine,
                previousHash: previousBlock.hash,
                nonce: 0,
                minerAddress: minerAddress || null,
                minerSignature: null  // simplificado (PoA)
            });

            // 3. PoW (simples)
            while (!newBlock.meetsDifficulty(CONFIG.difficulty)) {
                newBlock.nonce++;
                newBlock.hash = newBlock.calculateHash();

                // Sanity check (evita loop infinito)
                if (newBlock.nonce > 10_000_000) {
                    throw new Error('Não foi possível minerar (dificuldade muito alta?)');
                }
            }

            // 4. Aplica transações (atualiza saldos no Mongo)
            await this.applyTransactions(txsToMine);

            // 5. Persiste bloco
            await BlockModel.create(newBlock.toObject());

            // 6. Confirma transações no Mongo
            const txHashes = txsToMine.map(tx => tx.hash);
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

            // 7. Atualiza cache em memória
            this.chain.push(newBlock);
            if (this.chain.length > this.maxChainCache) {
                this.chain.shift(); // remove o mais antigo
            }

            // 8. Remove da mempool
            this.pendingTransactions = this.pendingTransactions.slice(txsToMine.length);

            console.log(`⛏️  Bloco ${newBlock.index} minerado: ${newBlock.hash.substring(0, 16)}...`);

            return newBlock.toObject();
        } finally {
            this.mining = false;
        }
    }

    // ============================================
    // APLICAR TRANSAÇÕES (atualiza saldos)
    // ============================================
    async applyTransactions(transactions) {
        for (const tx of transactions) {
            try {
                const amountStr = tx.amount.toString();
                const feeStr = tx.fee ? tx.fee.toString() : '0';
                const isSystemTx = tx.fromAddress === null || !tx.fromAddress;

                if (isSystemTx) {
                    // Sistema cria saldo (wallet_creation, mint, airdrop)
                    await WalletModel.credit(tx.toAddress, amountStr);
                } else {
                    // Transação normal: debita from, credita to, coleta fee
                    const totalDebit = (
                        parseFloat(amountStr) + parseFloat(feeStr)
                    ).toFixed(8);

                    await WalletModel.debit(tx.fromAddress, totalDebit);
                    await WalletModel.credit(tx.toAddress, amountStr);

                    // Fee vai para o coletor
                    if (parseFloat(feeStr) > 0) {
                        try {
                            await WalletModel.credit(CONFIG.feeCollectorAddress, feeStr);
                        } catch (e) {
                            console.error('Erro ao creditar fee:', e.message);
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ Erro ao aplicar TX ${tx.hash}:`, error.message);

                // Marca como falha
                await TransactionModel.updateOne(
                    { hash: tx.hash },
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
        // Primeiro do cache
        const cached = this.chain.find(b => b.index === index);
        if (cached) return cached;

        // Depois do Mongo
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
                transactionsCount: latest.transactions.length
            } : null,
            isValid: await this.isValid()
        };
    }

    // ============================================
    // VALIDAÇÃO DA CHAIN
    // ============================================
    async isValid() {
        // Valida só o cache em memória (rápido)
        for (let i = 1; i < this.chain.length; i++) {
            const current = this.chain[i];
            const previous = this.chain[i - 1];

            // 1. Hash do bloco atual está correto?
            const recalculated = current.calculateHash();
            if (recalculated !== current.hash) {
                console.log(`❌ Bloco ${current.index}: hash inválido`);
                return false;
            }

            // 2. Link com bloco anterior?
            if (current.previousHash !== previous.hash) {
                console.log(`❌ Bloco ${current.index}: link quebrado`);
                return false;
            }

            // 3. PoW válido?
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
