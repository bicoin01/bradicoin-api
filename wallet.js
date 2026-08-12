// wallet.js
const crypto = require('crypto');
const blockchain = require('./blockchain');
const transactions = require('./transactions');

// ============================================
// FUNÇÕES DE CARTEIRA
// ============================================

// ============================================
// CRIAR CARTEIRA
// ============================================
async function createWallet(username) {
    if (!username || username.length < 3) {
        throw new Error('Username deve ter pelo menos 3 caracteres');
    }

    // Gera endereço único
    const address = 'Br' + crypto.randomBytes(10).toString('hex').toUpperCase();
    
    // Gera par de chaves (simplificado)
    const privateKey = crypto.randomBytes(32).toString('hex');
    const publicKey = crypto
        .createHash('sha256')
        .update(privateKey + address)
        .digest('hex');

    // Verifica se já existe
    const existingBalance = blockchain.getBalance(address);
    if (existingBalance > 0) {
        throw new Error('Endereço já existe');
    }

    // Cria a carteira com saldo inicial
    const initialBalance = parseInt(process.env.INITIAL_BALANCE) || 1000;
    blockchain.balances[address] = initialBalance;
    
    // Adiciona transação de criação
    const tx = {
        from: 'system',
        to: address,
        amount: initialBalance,
        type: 'wallet_creation',
        timestamp: Date.now(),
        hash: crypto.randomBytes(32).toString('hex')
    };
    blockchain.addTransaction(tx);

    // Salva
    blockchain.saveToDisk();

    return {
        address,
        username,
        publicKey,
        privateKey,
        balance: initialBalance,
        createdAt: new Date().toISOString()
    };
}

// ============================================
// CONSULTAR SALDO
// ============================================
async function getBalance(address) {
    if (!address || !address.startsWith('Br')) {
        throw new Error('Endereço inválido');
    }

    const balance = blockchain.getBalance(address);
    const exists = blockchain.balances[address] !== undefined;

    // Busca transações recentes
    const recentTxs = await getHistory(address, 5);

    return {
        address,
        balance,
        exists,
        transactions: recentTxs.length,
        lastActivity: recentTxs.length > 0 ? recentTxs[0].timestamp : null
    };
}

// ============================================
// HISTÓRICO DE TRANSAÇÕES
// ============================================
async function getHistory(address, limit = 50) {
    if (!address || !address.startsWith('Br')) {
        throw new Error('Endereço inválido');
    }

    const history = [];
    
    for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
            if (tx.from === address || tx.to === address) {
                history.push({
                    ...tx,
                    blockIndex: block.index,
                    blockHash: block.hash,
                    timestamp: block.timestamp,
                    confirmed: true
                });
            }
        }
    }

    // Ordena por timestamp (mais recente primeiro)
    history.sort((a, b) => b.timestamp - a.timestamp);

    // Limita resultados
    return history.slice(0, limit);
}

// ============================================
// VALIDAR ENDEREÇO
// ============================================
function isValidAddress(address) {
    if (!address) return false;
    if (typeof address !== 'string') return false;
    if (!address.startsWith('Br')) return false;
    if (address.length < 3) return false;
    return true;
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    createWallet,
    getBalance,
    getHistory,
    isValidAddress
};
