// blockchain.js
// ============================================
// Bradicoin Blockchain - Core
// ============================================

const SHA256 = require('crypto-js/sha256');
const mongoose = require('mongoose');

// ============================================
// SCHEMAS MONGOOSE
// ============================================
const TransactionSchema = new mongoose.Schema({
    fromAddress: { type: String, default: null },
    toAddress: { type: String, required: true },
    amount: { type: Number, required: true },
    timestamp: { type: String, default: () => new Date().toISOString() },
    hash: { type: String, default: null }
}, { _id: false });

const BlockSchema = new mongoose.Schema({
    index: { type: Number, required: true, unique: true, index: true },
    timestamp: { type: String, required: true },
    transactions: { type: [TransactionSchema], default: [] },
    previousHash: { type: String, required: true },
    hash: { type: String, required: true, index: true },
    nonce: { type: Number, default: 0 }
});

const BlockModel = mongoose.model('Block', BlockSchema);

// ============================================
// CLASSE BLOCK
// ============================================
class Block {
    constructor(index, timestamp, transactions, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.transactions = transactions;
        this.previousHash = previousHash;
        this.nonce = 0;
        this.hash = this.calculateHash();
    }

    calculateHash() {
        return SHA256(
            this.index +
            this.previousHash +
            this.timestamp +
            JSON.stringify(this.transactions) +
            this.nonce
        ).toString();
    }

    mineBlock(difficulty) {
        const target = Array(difficulty + 1).join('0');
        while (this.hash.substring(0, difficulty) !== target) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
    }

    toObject() {
        return {
            index: this.index,
            timestamp: this.timestamp,
            transactions: this.transactions,
            previousHash: this.previousHash,
            hash: this.hash,
            nonce: this.nonce
        };
    }
}

// ============================================
// CLASSE BLOCKCHAIN
// ============================================
class Blockchain {
    constructor() {
        this.chain = [];
        this.difficulty = 4;
        this.pendingTransactions = [];
        this.miningReward = 100;
        this.initialized = false;
    }

    // ============================================
    // INICIALIZAÇÃO (conecta no Mongo)
    // ============================================
    async initialize() {
        if (this.initialized) return;

        try {
            // Conecta no Mongo (se ainda não conectado)
            if (mongoose.connection.readyState === 0) {
                await mongoose.connect(process.env.MONGO_URI);
                console.log('✅ MongoDB conectado (blockchain)');
            }

            // Carrega a chain do banco
            const blocks = await BlockModel.find().sort({ index: 1 }).lean();

            if (blocks.length === 0) {
                // Cria genesis block
                const genesis = this.createGenesisBlock();
                await BlockModel.create(genesis.toObject());
                this.chain = [genesis];
                console.log('🌱 Genesis block criado');
            } else {
                // Reconstrói instâncias de Block a partir do banco
                this.chain = blocks.map((b) => {
                    const block = new Block(
                        b.index,
                        b.timestamp,
                        b.transactions,
                        b.previousHash
                    );
                    block.hash = b.hash;
                    block.nonce = b.nonce;
                    return block;
                });
                console.log(`📦 ${blocks.length} blocos carregados do MongoDB`);
            }

            this.initialized = true;
        } catch (error) {
            console.error('❌ Erro ao inicializar blockchain:', error);
            throw error;
        }
    }

    createGenesisBlock() {
        return new Block(
            0,
            new Date('2026-01-01T00:00:00Z').toISOString(),
            [],              // ✅ array vazio (não string!)
            '0'
        );
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    async addTransaction(transaction) {
        if (!transaction.toAddress || transaction.amount === undefined) {
            throw new Error('Transação precisa de toAddress e amount');
        }
        if (typeof transaction.amount !== 'number' || transaction.amount <= 0) {
            throw new Error('Amount precisa ser um número positivo');
        }

        const tx = {
            fromAddress: transaction.fromAddress || null,
            toAddress: transaction.toAddress,
            amount: transaction.amount,
            timestamp: new Date().toISOString()
        };

        // Valida saldo se houver remetente
        if (tx.fromAddress) {
            const balance = this.getBalance(tx.fromAddress);
            if (balance < tx.amount) {
                throw new Error(`Saldo insuficiente: ${balance} < ${tx.amount}`);
            }
        }

        this.pendingTransactions.push(tx);
        return this.pendingTransactions.length - 1;
    }

    async minePendingTransactions(minerAddress) {
        // Reward para o minerador
        const rewardTransaction = {
            fromAddress: null,
            toAddress: minerAddress,
            amount: this.miningReward,
            timestamp: new Date().toISOString()
        };

        const transactionsToMine = [...this.pendingTransactions, rewardTransaction];

        const block = new Block(
            this.getLatestBlock().index + 1,
            new Date().toISOString(),
            transactionsToMine,
            this.getLatestBlock().hash
        );

        block.mineBlock(this.difficulty);

        // Persiste no Mongo
        await BlockModel.create(block.toObject());

        this.chain.push(block);
        this.pendingTransactions = [];

        console.log(`⛏️  Bloco ${block.index} minerado: ${block.hash}`);
        return block;
    }

    getBalance(address) {
        let balance = 0;

        for (const block of this.chain) {
            if (!Array.isArray(block.transactions)) continue;

            for (const tx of block.transactions) {
                if (tx.fromAddress === address) balance -= tx.amount;
                if (tx.toAddress === address) balance += tx.amount;
            }
        }

        return balance;
    }

    getAllTransactionsForAddress(address) {
        const transactions = [];

        for (const block of this.chain) {
            if (!Array.isArray(block.transactions)) continue;

            for (const tx of block.transactions) {
                if (tx.fromAddress === address || tx.toAddress === address) {
                    transactions.push({ ...tx, blockIndex: block.index });
                }
            }
        }

        return transactions;
    }

    isValid() {
        for (let i = 1; i < this.chain.length; i++) {
            const currentBlock = this.chain[i];
            const previousBlock = this.chain[i - 1];

            if (currentBlock.hash !== currentBlock.calculateHash()) {
                console.log(`❌ Hash inválido no bloco ${currentBlock.index}`);
                return false;
            }

            if (currentBlock.previousHash !== previousBlock.hash) {
                console.log(`❌ Link quebrado no bloco ${currentBlock.index}`);
                return false;
            }
        }
        return true;
    }

    getBlockByIndex(index) {
        if (index >= 0 && index < this.chain.length) {
            return this.chain[index];
        }
        return null;
    }

    getLatestBlockInfo() {
        const latestBlock = this.getLatestBlock();
        if (!latestBlock) return null;
        return {
            index: latestBlock.index,
            hash: latestBlock.hash,
            previousHash: latestBlock.previousHash,
            timestamp: latestBlock.timestamp,
            transactionsCount: Array.isArray(latestBlock.transactions)
                ? latestBlock.transactions.length
                : 0,
            nonce: latestBlock.nonce
        };
    }

    getChainInfo() {
        return {
            totalBlocks: this.chain.length,
            difficulty: this.difficulty,
            miningReward: this.miningReward,
            pendingTransactionsCount: this.pendingTransactions.length,
            isValid: this.isValid(),
            latestBlock: this.getLatestBlockInfo()
        };
    }

    getPendingTransactions() {
        return this.pendingTransactions;
    }

    clearPendingTransactions() {
        const count = this.pendingTransactions.length;
        this.pendingTransactions = [];
        return { message: 'Pending transactions cleared', count };
    }

    updateDifficulty(newDifficulty) {
        if (newDifficulty >= 1 && newDifficulty <= 10) {
            this.difficulty = newDifficulty;
            return { message: `Difficulty updated to ${newDifficulty}`, newDifficulty };
        }
        throw new Error('Difficulty must be between 1 and 10');
    }

    updateMiningReward(newReward) {
        if (newReward > 0 && newReward <= 1000) {
            this.miningReward = newReward;
            return { message: `Mining reward updated to ${newReward} Bradicoins`, newReward };
        }
        throw new Error('Mining reward must be between 1 and 1000');
    }
}

// ============================================
// EXPORTA INSTÂNCIA ÚNICA (Singleton)
// ============================================
module.exports = new Blockchain();
