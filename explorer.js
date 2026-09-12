// explorer.js
// ============================================
// Bradicoin Blockchain - Explorer (read-only)
// ============================================

const crypto = require('crypto');
const blockchain = require('./blockchain');
const wallet = require('./wallet');
const staking = require('./staking');
const { WalletModel } = require('./wallet');

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    console.log('✅ Explorer inicializado');
}

// ============================================
// HELPERS
// ============================================
function safeTxs(block) {
    return Array.isArray(block.transactions) ? block.transactions : [];
}

function txId(tx) {
    if (tx.hash) return tx.hash;
    const canonical = `${tx.fromAddress || 'null'}|${tx.toAddress || 'null'}|${tx.amount}|${tx.timestamp}|${tx.type || 'transfer'}`;
    return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 32);
}

// ============================================
// RESUMO GERAL DA CHAIN
// ============================================
async function getBlockchainSummary() {
    const chain = blockchain.chain;
    const latestBlock = chain[chain.length - 1];

    let totalTransactions = 0;
    for (const block of chain) {
        totalTransactions += safeTxs(block).length;
    }

    return {
        chainName: 'Bradicoin',
        symbol: 'BRD',
        blockHeight: chain.length,
        latestBlockHash: latestBlock ? latestBlock.hash : null,
        latestBlockTimestamp: latestBlock ? latestBlock.timestamp : null,
        totalTransactions,
        miningDifficulty: blockchain.difficulty,
        miningReward: blockchain.miningReward,
        isChainValid: blockchain.isValid(),   // ✅ isValid, não isChainValid
        totalSupply: calculateTotalSupply(),
        lastUpdated: new Date().toISOString()
    };
}

// ============================================
// SUPPLY TOTAL (rewards de mineração)
// ============================================
function calculateTotalSupply() {
    let totalMined = 0;
    for (const block of blockchain.chain) {
        for (const tx of safeTxs(block)) {
            if (tx.fromAddress === null && tx.toAddress && !tx.type) {
                totalMined += tx.amount || 0;
            }
            if (tx.type === 'wallet_creation' || tx.type === 'reward') {
                totalMined += tx.amount || 0;
            }
        }
    }
    return totalMined;
}

// ============================================
// BLOCOS PAGINADOS — server.js chama getBlocks
// ============================================
async function getBlocks(limit = 20, offset = 0) {
    const chain = [...blockchain.chain].reverse();
    const paginated = chain.slice(offset, offset + limit);

    const blocks = paginated.map((block) => ({
        index: block.index,
        hash: block.hash,
        previousHash: block.previousHash,
        timestamp: block.timestamp,
        transactionsCount: safeTxs(block).length,
        nonce: block.nonce,
        isGenesis: block.index === 0
    }));

    return {
        totalBlocks: blockchain.chain.length,
        limit,
        offset,
        blocks
    };
}

// ============================================
// BLOCO POR ÍNDICE — server.js chama getBlockByIndex
// ============================================
async function getBlockByIndex(index) {
    const block = blockchain.getBlockByIndex(index);
    if (!block) throw new Error('Bloco não encontrado');
    return formatBlock(block);
}

// ============================================
// BLOCO POR HASH
// ============================================
async function getBlockByHash(hash) {
    for (const block of blockchain.chain) {
        if (block.hash === hash) return formatBlock(block);
    }
    throw new Error('Bloco não encontrado');
}

// ============================================
// FORMATAR BLOCO
// ============================================
function formatBlock(block) {
    const txs = safeTxs(block).map((tx) => ({
        id: txId(tx),
        fromAddress: tx.fromAddress || 'COINBASE',
        toAddress: tx.toAddress,
        amount: tx.amount,
        fee: tx.fee || 0,
        type: tx.type || 'transfer',
        timestamp: tx.timestamp
    }));

    const totalAmount = txs.reduce((sum, t) => sum + (t.amount || 0), 0);

    return {
        index: block.index,
        hash: block.hash,
        previousHash: block.previousHash,
        timestamp: block.timestamp,
        transactionsCount: txs.length,
        transactions: txs.slice(0, 25),
        totalAmount,
        nonce: block.nonce,
        isGenesis: block.index === 0
    };
}

// ============================================
// TRANSAÇÃO POR HASH
// ============================================
async function getTransaction(hash) {
    for (const block of blockchain.chain) {
        for (const tx of safeTxs(block)) {
            if (txId(tx) === hash || tx.hash === hash) {
                return {
                    id: txId(tx),
                    blockIndex: block.index,
                    blockHash: block.hash,
                    confirmations: blockchain.chain.length - block.index,
                    fromAddress: tx.fromAddress || 'COINBASE',
                    toAddress: tx.toAddress,
                    amount: tx.amount,
                    fee: tx.fee || 0,
                    type: tx.type || 'transfer',
                    status: 'confirmed',
                    timestamp: tx.timestamp
                };
            }
        }
    }

    for (const tx of blockchain.pendingTransactions) {
        if (txId(tx) === hash || tx.hash === hash) {
            return {
                id: txId(tx),
                blockIndex: null,
                confirmations: 0,
                fromAddress: tx.fromAddress,
                toAddress: tx.toAddress,
                amount: tx.amount,
                fee: tx.fee || 0,
                type: tx.type || 'transfer',
                status: 'pending',
                timestamp: tx.timestamp
            };
        }
    }

    throw new Error('Transação não encontrada');
}

// ============================================
// TRANSAÇÕES DE UM ENDEREÇO
// ============================================
async function getAddressTransactions(address, limit = 50, offset = 0) {
    const all = [];

    for (const block of blockchain.chain) {
        for (const tx of safeTxs(block)) {
            if (tx.fromAddress === address || tx.toAddress === address) {
                all.push({
                    id: txId(tx),
                    blockIndex: block.index,
                    blockHash: block.hash,
                    confirmations: blockchain.chain.length - block.index,
                    direction: tx.fromAddress === address ? 'SENT' : 'RECEIVED',
                    fromAddress: tx.fromAddress || 'COINBASE',
                    toAddress: tx.toAddress,
                    amount: tx.amount,
                    fee: tx.fee || 0,
                    timestamp: tx.timestamp,
                    status: 'confirmed'
                });
            }
        }
    }

    all.sort((a, b) => b.blockIndex - a.blockIndex);
    const paginated = all.slice(offset, offset + limit);
    const balanceInfo = await wallet.getBalance(address).catch(() => ({ total: 0, balance: 0 }));

    return {
        address,
        balance: balanceInfo.balance || 0,
        pending: balanceInfo.pending || 0,
        total: balanceInfo.total || 0,
        totalTransactions: all.length,
        limit,
        offset,
        transactions: paginated
    };
}

// ============================================
// RESUMO DE ENDEREÇO
// ============================================
async function getAddressSummary(address) {
    const balanceInfo = await wallet.getBalance(address).catch(() => ({ balance: 0, total: 0 }));
    const txs = await getAddressTransactions(address, 100, 0);

    let totalSent = 0;
    let totalReceived = 0;

    for (const tx of txs.transactions) {
        if (tx.direction === 'SENT') totalSent += tx.amount;
        else totalReceived += tx.amount;
    }

    // Staking info via módulo staking
    let stakingInfo = null;
    try {
        stakingInfo = await staking.getStake(address);
    } catch (_) {
        stakingInfo = null;
    }

    return {
        address,
        balance: balanceInfo.balance || 0,
        pending: balanceInfo.pending || 0,
        total: balanceInfo.total || 0,
        totalSent,
        totalReceived,
        transactionsCount: txs.totalTransactions,
        firstSeen: txs.transactions.length > 0
            ? txs.transactions[txs.transactions.length - 1].timestamp
            : null,
        hasStake: stakingInfo ? stakingInfo.staked > 0 : false,
        stakedAmount: stakingInfo ? stakingInfo.staked : 0,
        isRich: (balanceInfo.balance || 0) > 10000
    };
}

// ============================================
// RICH LIST (top holders)
// ============================================
async function getRichList(limit = 100) {
    const wallets = await WalletModel.find().lean();

    const enriched = await Promise.all(
        wallets.map(async (w) => {
            const bal = blockchain.getBalance(w.address);
            return { address: w.address, username: w.username, balance: bal };
        })
    );

    enriched.sort((a, b) => b.balance - a.balance);
    const top = enriched.slice(0, limit);

    const totalBalance = enriched.reduce((sum, w) => sum + w.balance, 0);
    const totalSupply = calculateTotalSupply();

    return {
        totalWallets: enriched.length,
        totalBalance,
        totalSupply,
        percentageOfSupply: totalSupply > 0 ? (totalBalance / totalSupply) * 100 : 0,
        limit,
        holders: top.map((w, i) => ({
            rank: i + 1,
            address: w.address,
            username: w.username,
            balance: w.balance,
            percentage: totalBalance > 0 ? (w.balance / totalBalance) * 100 : 0
        }))
    };
}

// ============================================
// ÚLTIMAS TRANSAÇÕES
// ============================================
async function getLatestTransactions(limit = 20) {
    const transactions = [];

    const reversed = [...blockchain.chain].reverse();

    for (const block of reversed) {
        for (const tx of safeTxs(block)) {
            transactions.push({
                id: txId(tx),
                blockIndex: block.index,
                blockHash: block.hash,
                fromAddress: tx.fromAddress || 'COINBASE',
                toAddress: tx.toAddress,
                amount: tx.amount,
                fee: tx.fee || 0,
                type: tx.type || 'transfer',
                timestamp: tx.timestamp,
                confirmations: blockchain.chain.length - block.index
            });

            if (transactions.length >= limit) break;
        }
        if (transactions.length >= limit) break;
    }

    return {
        totalTransactions: getTotalTransactionCount(),
        limit,
        transactions
    };
}

// ============================================
// TOTAL DE TRANSAÇÕES
// ============================================
function getTotalTransactionCount() {
    let count = 0;
    for (const block of blockchain.chain) {
        count += safeTxs(block).length;
    }
    return count;
}

// ============================================
// BUSCA
// ============================================
async function search(query) {
    const results = { blocks: [], transactions: [], addresses: [] };

    // Por índice
    if (!isNaN(parseInt(query))) {
        try {
            const block = await getBlockByIndex(parseInt(query));
            results.blocks.push({ index: block.index, hash: block.hash });
        } catch (_) {}
    }

    // Por hash de bloco
    try {
        const block = await getBlockByHash(query);
        if (!results.blocks.find((b) => b.hash === block.hash)) {
            results.blocks.push({ index: block.index, hash: block.hash });
        }
    } catch (_) {}

    // Por hash de transação
    try {
        const tx = await getTransaction(query);
        results.transactions.push({
            id: tx.id,
            fromAddress: tx.fromAddress,
            toAddress: tx.toAddress
        });
    } catch (_) {}

    // Por endereço
    if (typeof query === 'string' && query.startsWith('Br')) {
        try {
            const summary = await getAddressSummary(query);
            results.addresses.push({
                address: summary.address,
                balance: summary.balance
            });
        } catch (_) {}
    }

    return {
        query,
        results,
        totalResults:
            results.blocks.length + results.transactions.length + results.addresses.length,
        timestamp: new Date().toISOString()
    };
}

// ============================================
// ESTATÍSTICAS DE REDE
// ============================================
async function getNetworkStats() {
    const chain = blockchain.chain;
    const latestBlock = chain[chain.length - 1];

    let avgBlockTime = 0;
    if (chain.length > 10) {
        const last10 = chain.slice(-10);
        let totalTime = 0;
        for (let i = 1; i < last10.length; i++) {
            const t1 = new Date(last10[i].timestamp).getTime();
            const t2 = new Date(last10[i - 1].timestamp).getTime();
            totalTime += Math.abs(t1 - t2);
        }
        avgBlockTime = totalTime / (last10.length - 1) / 1000;
    }

    return {
        network: 'Bradicoin Mainnet',
        symbol: 'BRD',
        blockHeight: chain.length,
        latestBlockHash: latestBlock ? latestBlock.hash : null,
        latestBlockTimestamp: latestBlock ? latestBlock.timestamp : null,
        miningDifficulty: blockchain.difficulty,
        miningReward: blockchain.miningReward,
        averageBlockTimeSeconds: Math.round(avgBlockTime),
        totalTransactions: getTotalTransactionCount(),
        totalSupply: calculateTotalSupply(),
        activeNodes: 1,
        isSynced: true,
        lastUpdated: new Date().toISOString()
    };
}

// ============================================
// EXPORTA (funções, não classe!)
// ============================================
module.exports = {
    initialize,                 // ✅ server.js precisa
    getBlocks,                  // ✅ server.js precisa
    getBlockByIndex,            // ✅ server.js precisa
    getBlockByHash,
    getBlockchainSummary,
    getTransaction,
    getAddressTransactions,
    getAddressSummary,
    getRichList,
    getLatestTransactions,
    getNetworkStats,
    search,
    calculateTotalSupply,
    getTotalTransactionCount
};
