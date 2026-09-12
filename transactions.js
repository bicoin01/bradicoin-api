// transactions.js
// ============================================
// Bradicoin Blockchain - Transactions
// ============================================

const crypto = require('crypto');
const blockchain = require('./blockchain');
const wallet = require('./wallet');

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    console.log('✅ Transactions inicializadas');
    // Nada a inicializar por enquanto — só garante a interface
}

// ============================================
// CRIAR TRANSAÇÃO COM ASSINATURA DIGITAL
// ============================================
function createTransaction(fromAddress, toAddress, amount, privateKey, fee = 0, type = 'transfer') {
    // Validações básicas
    if (!fromAddress || !toAddress || amount === undefined) {
        throw new Error('Dados incompletos: fromAddress, toAddress e amount são obrigatórios');
    }

    if (!wallet.isValidAddress(fromAddress)) {
        throw new Error('Endereço de origem inválido');
    }

    if (!wallet.isValidAddress(toAddress)) {
        throw new Error('Endereço de destino inválido');
    }

    if (typeof amount !== 'number' || amount <= 0) {
        throw new Error('Valor deve ser um número positivo');
    }

    if (fee < 0) {
        throw new Error('Taxa não pode ser negativa');
    }

    if (!privateKey) {
        throw new Error('Chave privada é obrigatória para assinar a transação');
    }

    const timestamp = new Date().toISOString();

    // String canônica para assinatura
    const message = `${fromAddress}|${toAddress}|${amount}|${fee}|${timestamp}|${type}`;

    const hash = crypto.createHash('sha256').update(message).digest('hex');

    let signature;
    try {
        const signer = crypto.createSign('SHA256');
        signer.update(message);
        signer.end();
        signature = signer.sign(privateKey, 'hex');
    } catch (error) {
        throw new Error(`Falha ao assinar transação: ${error.message}`);
    }

    const transaction = {
        fromAddress,        // ✅ formato do blockchain.js
        toAddress,          // ✅
        amount,
        fee,
        type,
        timestamp,
        hash,
        signature,
        publicKey: null     // será preenchido quando derivarmos da wallet
    };

    return transaction;
}

// ============================================
// ENVIAR TRANSAÇÃO
// ============================================
async function sendTransaction(fromAddress, toAddress, amount, privateKey, fee = 0, type = 'transfer') {
    // 1. Validações
    if (!fromAddress || !toAddress || amount === undefined) {
        throw new Error('Dados incompletos');
    }
    if (!wallet.isValidAddress(fromAddress)) throw new Error('Endereço de origem inválido');
    if (!wallet.isValidAddress(toAddress)) throw new Error('Endereço de destino inválido');
    if (typeof amount !== 'number' || amount <= 0) throw new Error('Valor deve ser positivo');
    if (fee < 0) throw new Error('Taxa não pode ser negativa');
    if (!privateKey) throw new Error('Chave privada é obrigatória');

    // 2. Verifica saldo (confirmado + pendente)
    const balanceInfo = await wallet.getBalance(fromAddress);
    const available = balanceInfo.total;
    const totalCost = amount + fee;

    if (available < totalCost) {
        throw new Error(`Saldo insuficiente: ${available} < ${totalCost}`);
    }

    // 3. Cria transação assinada
    const transaction = createTransaction(fromAddress, toAddress, amount, privateKey, fee, type);

    // 4. Adiciona ao blockchain (é async!)
    await blockchain.addTransaction(transaction);

    console.log(`✅ Transação adicionada à fila: ${transaction.hash.substring(0, 12)}...`);

    // NÃO minera aqui — o server.js tem auto-mining a cada 30s
    return {
        success: true,
        transaction,
        status: 'pending',
        message: `Transação de ${amount} BRD enviada. Será confirmada no próximo bloco.`,
        hash: transaction.hash
    };
}

// ============================================
// BUSCAR TRANSAÇÃO POR HASH
// ============================================
async function getTransactionByHash(hash) {
    if (!hash) throw new Error('Hash é obrigatório');

    // 1. Procura em blocos confirmados
    for (const block of blockchain.chain) {
        if (!Array.isArray(block.transactions)) continue;
        for (const tx of block.transactions) {
            if (tx.hash === hash) {
                return {
                    ...tx,
                    blockIndex: block.index,
                    blockHash: block.hash,
                    confirmed: true,
                    status: 'confirmed'
                };
            }
        }
    }

    // 2. Procura em pendentes
    for (const tx of blockchain.pendingTransactions) {
        if (tx.hash === hash) {
            return { ...tx, confirmed: false, status: 'pending' };
        }
    }

    throw new Error('Transação não encontrada');
}

// ============================================
// VERIFICAR ASSINATURA
// ============================================
function verifyTransactionSignature(transaction) {
    try {
        if (!transaction || !transaction.signature || !transaction.publicKey) {
            return false;
        }

        const message = `${transaction.fromAddress}|${transaction.toAddress}|${transaction.amount}|${transaction.fee}|${transaction.timestamp}|${transaction.type}`;

        const verifier = crypto.createVerify('SHA256');
        verifier.update(message);
        verifier.end();

        return verifier.verify(transaction.publicKey, transaction.signature, 'hex');
    } catch (error) {
        console.error('Erro ao verificar assinatura:', error.message);
        return false;
    }
}

// ============================================
// BUSCAR TRANSAÇÕES DE UMA CARTEIRA
// ============================================
async function getWalletTransactions(address, limit = 50, offset = 0) {
    if (!wallet.isValidAddress(address)) throw new Error('Endereço inválido');

    const all = [];

    for (const block of blockchain.chain) {
        if (!Array.isArray(block.transactions)) continue;
        for (const tx of block.transactions) {
            if (tx.fromAddress === address || tx.toAddress === address) {
                all.push({
                    ...tx,
                    blockIndex: block.index,
                    blockHash: block.hash,
                    confirmed: true,
                    status: 'confirmed'
                });
            }
        }
    }

    for (const tx of blockchain.pendingTransactions) {
        if (tx.fromAddress === address || tx.toAddress === address) {
            all.push({ ...tx, confirmed: false, status: 'pending' });
        }
    }

    all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
        address,
        total: all.length,
        transactions: all.slice(offset, offset + limit),
        limit,
        offset,
        hasMore: offset + limit < all.length
    };
}

// ============================================
// ESTATÍSTICAS
// ============================================
async function getTransactionStats() {
    let total = 0;
    let volume = 0;
    let totalFee = 0;
    let feeCount = 0;
    const uniqueAddresses = new Set();

    for (const block of blockchain.chain) {
        if (!Array.isArray(block.transactions)) continue;
        for (const tx of block.transactions) {
            total++;
            volume += tx.amount || 0;
            if (tx.fee !== undefined) {
                totalFee += tx.fee || 0;
                feeCount++;
            }
            if (tx.fromAddress) uniqueAddresses.add(tx.fromAddress);
            if (tx.toAddress) uniqueAddresses.add(tx.toAddress);
        }
    }

    const latestBlock = blockchain.getLatestBlock();

    return {
        totalTransactions: total,
        totalVolume: volume,
        averageFee: feeCount > 0 ? totalFee / feeCount : 0,
        pending: blockchain.pendingTransactions.length,
        blocks: blockchain.chain.length,
        uniqueAddresses: uniqueAddresses.size,
        lastBlockTime: latestBlock ? latestBlock.timestamp : null
    };
}

// ============================================
// EXPORTA (agora com initialize!)
// ============================================
module.exports = {
    initialize,                  // ✅ server.js precisa
    createTransaction,
    sendTransaction,
    getTransactionByHash,
    verifyTransactionSignature,
    getWalletTransactions,
    getTransactionStats
};
