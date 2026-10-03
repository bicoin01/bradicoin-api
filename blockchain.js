// blockchain.js
// ============================================
// Bradicoin Blockchain - Core (v4.1 - PoW Puro)
// ============================================
// 🔗 CONSENSO: PoW puro com retarget
// ✅ Saldo materializado no MongoDB (rápido)
// ✅ Sem emissão infinita (só taxas)
// ✅ Verificação de assinatura obrigatória
// ✅ Atomic updates
//
// 🔧 v4.1 (fixes reorg-safe):
//   [1] _revertTransactions usa revertDebit/revertCredit (nonce simétrico)
//   [2] decideFork/tryBuildAltChain async + fetchBlockByHash (Mongo)
//   [3] retarget busca RETARGET_INTERVAL blocos do Mongo
//   [4] _reorg valida PoW dos blocos novos
//   [5] _processOrphans() reprocessa órfãos após append/reorg
//   [6] addTransaction normaliza timestamp (assinatura == hash canônico)
// ============================================

const mongoose = require('mongoose');
const { EventEmitter } = require('events');
const { Decimal128 } = mongoose.Schema.Types;

const { sha256 } = require('@noble/hashes/sha2');
const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');

const BlockModel = require('./models/Block');
const TransactionModel = require('./models/Transaction');
const WalletModel = require('./models/Wallet');

const {
    computeNextDifficulty,
    blockWork,
    RETARGET_INTERVAL
} = require('./consensus/retarget');
const { decideFork, chainworkOf } = require('./consensus/forkChoice');

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
    genesisTimestamp: new Date('2026-01-01T00:00:00Z').toISOString(),
    maxOrphanPool: parseInt(process.env.MAX_ORPHAN_POOL) || 100
};

if (!CONFIG.feeCollectorAddress) {
    throw new Error('❌ FEE_COLLECTOR_ADDRESS não configurado no .env');
}
if (!/^Br[a-fA-F0-9]{38}$/.test(CONFIG.feeCollectorAddress)) {
    throw new Error('❌ FEE_COLLECTOR_ADDRESS inválido');
}

// ============================================
// HELPERS
// ============================================
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
// CLASSE BLOCK
// ============================================
class Block {
    constructor({ index, timestamp, transactions, previousHash, hash, nonce,
                  minerAddress, minerSignature, difficulty }) {
        this.index = index;
        this.timestamp = timestamp;
        this.transactions = (transactions || []).map(normalizeTx);
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
        const cached = this.chain.find(b => b.index === index);
        if (cached) return cached.toObject();
        return BlockModel.findOne({ index }).lean();
    }

    async getBlockByHashOrNull(hash) {
        const cached = this.chain.find(b => b.hash === hash);
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

                this.chain = latestBlocks.reverse().map(b => new Block(b));
                console.log(`📦 ${this.chain.length} blocos carregados (últimos)`);
            }

            const pending = await TransactionModel.find({ status: 'pending' })
                .sort({ timestamp: 1 })
                .limit(10000)
                .lean();

            this.pendingTransactions = pending.map(normalizeTx);
            console.log(`⏳ ${pending.length} transações pendentes carregadas`);

            this._chainwork = 0n;
            for (const b of this.chain) {
                this._chainwork += blockWork(b.difficulty || CONFIG.difficulty);
            }
            const tip = this.getLatestBlock();
            this._currentDifficulty = (tip && tip.difficulty) || CONFIG.difficulty;

            console.log(`⚖️  chainwork=${this._chainwork.toString()} difficulty=${this._currentDifficulty}`);

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
    // HASH CANÔNICO DA TX
    // ============================================
    calculateTxHash(tx) {
        const payload = JSON.stringify({
            from: tx.fromAddress || tx.from || null,
            to: tx.toAddress || tx.to || null,
            amount: safeToString(tx.amount),
            fee: safeToString(tx.fee, '0'),
            nonce: tx.nonce || 0,
            type: tx.type || 'transfer',
            timestamp: safeToString(tx.timestamp),
            signature: tx.signature || 'system'
        });
        return bytesToHex(sha256(utf8ToBytes(payload)));
    }

    // ============================================
    // ADICIONAR TRANSAÇÃO À MEMPOOL
    // ============================================
    async addTransaction(transaction) {
        if (!transaction || typeof transaction !== 'object') {
            throw new Error('Transação inválida');
        }
        if (!transaction.toAddress) {
            throw new Error('Destinatário obrigatório');
        }

        // 🆕 [6] Normaliza timestamp ANTES de tudo (assinatura == hash canônico)
        if (!transaction.timestamp) {
            transaction.timestamp = new Date().toISOString();
        }

        const amount = parseFloat(transaction.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Valor inválido');
        }

        const fee = parseFloat(transaction.fee || '0');
        if (!Number.isFinite(fee) || fee < 0) {
            throw new Error('Taxa inválida');
        }

        const isSystemTx = transaction.fromAddress === null || transaction.fromAddress === undefined;

        if (!isSystemTx) {
            const wallet = require('./wallet');
            const signableMessage = this.buildSignableMessage(transaction);
            const isValid = wallet.verifySignature(
                signableMessage,
                transaction.signature,
                transaction.publicKey
            );
            if (!isValid) throw new Error('Assinatura inválida');

            const expectedAddress = wallet.deriveAddressFromPublicKey(transaction.publicKey);
            const normalizedFrom = wallet.normalizeAddress(transaction.fromAddress);
            if (expectedAddress !== normalizedFrom) {
                throw new Error('Public key não corresponde ao endereço de origem');
            }

            const walletDoc = await WalletModel.findOne({
                address: normalizedFrom,
                status: 'active'
            });
            if (!walletDoc) throw new Error('Carteira de origem não encontrada ou inativa');

            const balance = parseFloat(walletDoc.balance.toString());
            const totalCost = amount + fee;
            if (balance < totalCost) throw new Error(`Saldo insuficiente: ${balance} < ${totalCost}`);

            if (walletDoc.nonce !== transaction.nonce) {
                throw new Error(`Nonce inválido: esperado ${walletDoc.nonce}, recebido ${transaction.nonce}`);
            }

            const existingSig = await TransactionModel.findOne({ signature: transaction.signature });
            if (existingSig) throw new Error('Transação já submetida (replay detectado)');
        }

        const txHash = this.calculateTxHash(transaction);
        const existingTx = await TransactionModel.findOne({ hash: txHash });
        if (existingTx) {
            console.log(`ℹ️ TX já existe: ${txHash}`);
            return { hash: existingTx.hash, status: existingTx.status, message: 'Transação já existia' };
        }

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
            timestamp: new Date(transaction.timestamp),
            metadata: transaction.metadata || {}
        };

        const savedTx = await TransactionModel.create(txData);
        const normalized = normalizeTx(savedTx.toObject());
        this.pendingTransactions.push(normalized);

        this.emit('tx:new', normalized);

        return { hash: savedTx.hash, status: 'pending', message: 'Transação adicionada à fila' };
    }

    // ============================================
    // ASSINATURA
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
    // RETARGET (busca do Mongo)
    // 🆕 [3]
    // ============================================
    async _computeNextDifficultyFor(nextIndex) {
        if (nextIndex === 0) return this._currentDifficulty;
        if (nextIndex % RETARGET_INTERVAL !== 0) return this._currentDifficulty;

        const startIdx = nextIndex - RETARGET_INTERVAL;
        if (startIdx < 0) return this._currentDifficulty;

        const blocks = await BlockModel.find({
            index: { $gte: startIdx, $lte: nextIndex - 1 }
        })
            .sort({ index: 1 })
            .lean();

        if (blocks.length < RETARGET_INTERVAL) {
            return this._currentDifficulty;
        }

        return computeNextDifficulty(nextIndex, blocks, this._currentDifficulty);
    }

    // ============================================
    // MINERAR BLOCO
    // ============================================
    async minePendingTransactions(minerAddress) {
        if (this.mining) throw new Error('Mineração já em andamento');
        this.mining = true;

        try {
            if (this.pendingTransactions.length === 0) return null;

            if (minerAddress && !/^Br[a-fA-F0-9]{38}$/.test(minerAddress)) {
                throw new Error('❌ minerAddress inválido');
            }

            const txsToMine = this.pendingTransactions.slice(0, CONFIG.maxTxPerBlock);

            const previousBlock = this.getLatestBlock();
            if (!previousBlock) throw new Error('Nenhum bloco anterior');

            const newIndex = previousBlock.index + 1;

            const nextDifficulty = await this._computeNextDifficultyFor(newIndex);

            const newBlock = new Block({
                index: newIndex,
                timestamp: new Date().toISOString(),
                transactions: txsToMine,
                previousHash: previousBlock.hash,
                nonce: 0,
                difficulty: nextDifficulty,
                minerAddress: minerAddress || null,
                minerSignature: null
            });

            while (!newBlock.meetsDifficulty(nextDifficulty)) {
                newBlock.nonce++;
                newBlock.hash = newBlock.calculateHash();

                if (newBlock.nonce > 10_000_000) {
                    console.error(`🚨 PoW falhou após 10M tentativas. Dificuldade: ${nextDifficulty}`);
                    throw new Error('Não foi possível minerar');
                }
            }

            await this.applyTransactions(txsToMine);
            await BlockModel.create(newBlock.toObject());

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

            this.chain.push(newBlock);
            if (this.chain.length > this.maxChainCache) this.chain.shift();

            this._chainwork += blockWork(nextDifficulty);
            this._currentDifficulty = nextDifficulty;

            this.pendingTransactions = this.pendingTransactions.slice(txsToMine.length);

            console.log(`⛏️  Bloco ${newBlock.index} minerado: ${newBlock.hash.substring(0, 16)}... (${txsToMine.length} TXs, diff=${nextDifficulty})`);

            this.emit('block:new', newBlock.toObject());

            // 🆕 [5] Tenta pescar órfãos que dependiam desse bloco
            await this._processOrphans().catch(e =>
                console.error('processOrphans (miner):', e.message)
            );

            return newBlock.toObject();
        } finally {
            this.mining = false;
        }
    }

    // ============================================
    // APLICAR TRANSAÇÕES
    // ============================================
    async applyTransactions(transactions) {
        for (const rawTx of transactions) {
            try {
                const tx = normalizeTx(rawTx);
                const amountStr = safeToString(tx.amount);
                const feeStr = safeToString(tx.fee, '0');
                const fromAddr = tx.fromAddress;
                const toAddr = tx.toAddress;
                const isSystemTx = !fromAddr;

                if (isSystemTx) {
                    await WalletModel.credit(toAddr, amountStr);
                    console.log(`💰 Sistema creditou ${amountStr} em ${toAddr.substring(0, 12)}...`);
                } else {
                    const totalDebit = (parseFloat(amountStr) + parseFloat(feeStr)).toFixed(8);
                    await WalletModel.debit(fromAddr, totalDebit);
                    await WalletModel.credit(toAddr, amountStr);

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
                    { $set: { status: 'failed', 'metadata.reason': error.message } }
                );
            }
        }
    }

    // ============================================
    // REVERTER TRANSAÇÕES
    // 🆕 [1] usa revertDebit/revertCredit (simétricos ao apply)
    // ============================================
    async _revertTransactions(transactions) {
        for (const rawTx of [...transactions].reverse()) {
            try {
                const tx = normalizeTx(rawTx);
                const amountStr = safeToString(tx.amount);
                const feeStr = safeToString(tx.fee, '0');
                const fromAddr = tx.fromAddress;
                const toAddr = tx.toAddress;
                const isSystemTx = !fromAddr;

                if (isSystemTx) {
                    await WalletModel.revertCredit(toAddr, amountStr);
                } else {
                    const totalDebit = (parseFloat(amountStr) + parseFloat(feeStr)).toFixed(8);
                    await WalletModel.revertCredit(toAddr, amountStr);
                    await WalletModel.revertDebit(fromAddr, totalDebit);

                    if (parseFloat(feeStr) > 0) {
                        try {
                            await WalletModel.revertCredit(CONFIG.feeCollectorAddress, feeStr);
                        } catch (e) {
                            console.error('Erro ao reverter fee:', e.message);
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ Erro ao reverter TX ${rawTx.hash}:`, error.message);
            }
        }
    }

    // ============================================
    // ACEITAR BLOCO VINDO DE PEER
    // 🆕 [2] decideFork agora é async + fetchBlockByHash
    // ============================================
    async acceptBlockFromPeer(blockData) {
        const block = new Block(blockData);

        if (!block.meetsDifficulty(block.difficulty)) {
            throw new Error(`Bloco ${block.index}: PoW inválido (diff=${block.difficulty})`);
        }

        if (block.calculateHash() !== block.hash) {
            throw new Error(`Bloco ${block.index}: hash inválido`);
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
            if (this._orphanPool.length >= CONFIG.maxOrphanPool) {
                this._orphanPool.shift();
            }
            this._orphanPool.push(decision.block);
            console.log(`🟡 Órfão guardado: #${block.index} (pool=${this._orphanPool.length})`);
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
    // HELPER: ANEXA BLOCO
    // 🆕 [5] chama _processOrphans no fim
    // ============================================
    async _appendBlock(blockData) {
        const block = new Block(blockData);

        await this.applyTransactions(block.transactions);

        try {
            await BlockModel.create(block.toObject());
        } catch (e) {
            if (e.code === 11000) return block.toObject();
            throw e;
        }

        const txHashes = block.transactions.map(t => t.hash).filter(Boolean);
        if (txHashes.length) {
            await TransactionModel.updateMany(
                { hash: { $in: txHashes } },
                {
                    $set: {
                        status: 'confirmed',
                        blockIndex: block.index,
                        blockHash: block.hash,
                        confirmations: 1
                    }
                }
            );
        }

        this.chain.push(block);
        if (this.chain.length > this.maxChainCache) this.chain.shift();

        this._chainwork += blockWork(block.difficulty);
        this._currentDifficulty = block.difficulty;

        const set = new Set(txHashes);
        this.pendingTransactions = this.pendingTransactions.filter(t => !set.has(t.hash));

        this.emit('block:new', block.toObject());
        console.log(`📥 Bloco ${block.index} aceito da rede (diff=${block.difficulty})`);

        // 🆕 [5]
        await this._processOrphans().catch(e =>
            console.error('processOrphans (append):', e.message)
        );

        return block.toObject();
    }

    // ============================================
    // REORG
    // 🆕 [1] revert simétrico
    // 🆕 [4] valida PoW dos blocos novos
    // 🆕 [5] processa órfãos no fim
    // ============================================
    async _reorg(newChain) {
        console.log(`🔀 REORG: ${this.chain.length} → ${newChain.length} blocos`);

        // 🆕 [4] Valida PoW de TODOS os blocos da nova chain
        for (const blk of newChain) {
            const b = new Block(blk);
            if (b.calculateHash() !== b.hash) {
                throw new Error(`Reorg rejeitado: bloco ${b.index} hash inválido`);
            }
            if (!b.meetsDifficulty(b.difficulty)) {
                throw new Error(`Reorg rejeitado: bloco ${b.index} sem PoW válido`);
            }
        }

        // Acha fork point comparando por hash (funciona mesmo com cache parcial,
        // porque newChain tem ancestrais vindos do Mongo)
        let forkPoint = -1;
        const cachedByHash = new Map(this.chain.map(b => [b.hash, b]));
        for (const blk of newChain) {
            if (cachedByHash.has(blk.hash)) {
                forkPoint = blk.index;
            } else {
                break;
            }
        }

        if (forkPoint === -1) {
            throw new Error('Reorg rejeitado: fork point não encontrado no cache');
        }

        // Blocos a reverter: tudo em this.chain com index > forkPoint
        const revertedBlocks = this.chain.filter(b => b.index > forkPoint);
        for (const blk of [...revertedBlocks].reverse()) {
            const txs = (blk.transactions || []).map(normalizeTx);
            await this._revertTransactions(txs);
            console.log(`↩️  Revertido bloco #${blk.index} (${txs.length} TXs)`);
        }

        const revertedIndexes = revertedBlocks.map(b => b.index);
        if (revertedIndexes.length > 0) {
            await BlockModel.deleteMany({ index: { $in: revertedIndexes } });
        }

        // Aplica blocos novos (index > forkPoint)
        const newBlocks = newChain.filter(blk => blk.index > forkPoint);
        for (const blk of newBlocks) {
            await this.applyTransactions(blk.transactions || []);
            try {
                await BlockModel.create(blk);
            } catch (e) {
                if (e.code !== 11000) console.error('reorg persist:', e.message);
            }
            const txHashes = (blk.transactions || []).map(t => t.hash).filter(Boolean);
            if (txHashes.length) {
                await TransactionModel.updateMany(
                    { hash: { $in: txHashes } },
                    {
                        $set: {
                            status: 'confirmed',
                            blockIndex: blk.index,
                            blockHash: blk.hash
                        }
                    }
                );
            }
        }

        this.chain = newChain.map(b => new Block(b));
        if (this.chain.length > this.maxChainCache) {
            this.chain = this.chain.slice(-this.maxChainCache);
        }

        this._chainwork = chainworkOf(newChain);
        this._currentDifficulty = newChain[newChain.length - 1].difficulty;

        const usedHashes = new Set(newChain.map(b => b.hash));
        this._orphanPool = this._orphanPool.filter(o => !usedHashes.has(o.hash));

        console.log(`✅ Reorg concluída. Altura: ${this.getLatestBlock().index}, chainwork=${this._chainwork}`);

        this.emit('block:new', this.getLatestBlock().toObject());

        // 🆕 [5]
        await this._processOrphans().catch(e =>
            console.error('processOrphans (reorg):', e.message)
        );

        return this.getLatestBlock().toObject();
    }

    // ============================================
    // ÓRFÃOS
    // 🆕 [5]
    // ============================================
    async _processOrphans() {
        if (this._processingOrphans) return;
        if (this._orphanPool.length === 0) return;

        this._processingOrphans = true;
        try {
            let changed = true;
            let rounds = 0;
            const MAX_ROUNDS = 10;

            while (changed && rounds < MAX_ROUNDS) {
                changed = false;
                rounds++;

                const remaining = [];
                for (const orphan of this._orphanPool) {
                    try {
                        const result = await this.acceptBlockFromPeer(orphan);
                        if (result && !result.orphan) {
                            changed = true;
                            console.log(`♻️  Órfão #${orphan.index} reaproveitado`);
                        } else {
                            remaining.push(orphan);
                        }
                    } catch (_) {
                        remaining.push(orphan);
                    }
                }
                this._orphanPool = remaining;
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
        return BlockModel.find().sort({ index: -1 }).skip(offset).limit(limit).lean();
    }

    async getChainInfo() {
        const [totalBlocks, latest] = await Promise.all([
            BlockModel.countDocuments({}),
            BlockModel.findOne().sort({ index: -1 }).lean()
        ]);

        return {
            totalBlocks,
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
    // VALIDAÇÃO
    // ============================================
    async isValid() {
        for (let i = 1; i < this.chain.length; i++) {
            const current = this.chain[i];
            const previous = this.chain[i - 1];

            if (current.calculateHash() !== current.hash) {
                console.log(`❌ Bloco ${current.index}: hash inválido`);
                return false;
            }
            if (current.previousHash !== previous.hash) {
                console.log(`❌ Bloco ${current.index}: link quebrado`);
                return false;
            }
            if (!current.meetsDifficulty(current.difficulty || CONFIG.difficulty)) {
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
