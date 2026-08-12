// transactions.js
const crypto = require('crypto');
const blockchain = require('./blockchain');
const wallet = require('./wallet');

// ============================================
// FUNÇÕES DE TRANSAÇÃO
// ============================================

// ============================================
// ENVIAR TRANSAÇÃO
// ============================================
async function sendTransaction(from, to, amount, fee = 0) {
    // Validações
    if (!from || !to || !amount) {
        throw new Error('Dados incompletos');
    }

    if (!wallet.isValidAddress(from)) {
        throw new Error('Endereço de origem inválido');
    }

    if (!wallet.isValidAddress(to)) {
        throw new Error('Endereço de destino inválido');
    }

    if (amount <= 0) {
        throw new Error('Valor deve ser positivo');
    }

    if (fee < 0) {
        throw new Error('Taxa não pode ser negativa');
    }

    // Verifica saldo
    const balance = blockchain.getBalance(from);
    const totalCost = amount + fee;
    if (balance < totalCost) {
        throw new Error(`Saldo insuficiente: ${balance} < ${totalCost}`);
    }

    // Cria a transação
    const transaction = {
        from,
        to,
        amount,
        fee,
        type: 'transfer',
        timestamp: Date.now(),
        hash: crypto
            .createHash('sha256')
            .update(from + to + amount + fee + Date.now())
            .digest('hex')
    };

    // Adiciona à blockchain
    blockchain.addTransaction(transaction);
    blockchain.saveToDisk();

    return {
        success: true,
        transaction,
        status: 'pending',
        message: `✅ Transação de ${amount} BRD enviada`
    };
}

// ============================================
// BUSCAR TRANSAÇÃO POR HASH
// ============================================
async function getTransactionByHash(hash) {
    if (!hash) {
        throw new Error('Hash é obrigatório');
    }

    // Procura em todos os blocos
    for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
            if (tx.hash === hash) {
                return {
                    ...tx,
                    blockIndex: block.index,
                    blockHash: block.hash,
                    confirmed: true,
                    timestamp: block.timestamp
                };
            }
        }
    }

    // Procura em transações pendentes
    for (const tx of blockchain.pendingTransactions) {
        if (tx.hash === hash) {
            return {
                ...tx,
                confirmed: false,
                status: 'pending'
            };
        }
    }

    throw new Error('Transação não encontrada');
}

// ============================================
// ESTATÍSTICAS DE TRANSAÇÕES
// ============================================
async function getTransactionStats() {
    let total = 0;
    let volume = 0;

    for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
            total++;
            volume += tx.amount || 0;
        }
    }

    return {
        totalTransactions: total,
        totalVolume: volume,
        pending: blockchain.pendingTransactions.length,
        blocks: blockchain.chain.length
    };
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    sendTransaction,
    getTransactionByHash,
    getTransactionStats
};
