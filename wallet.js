// wallet.js
const crypto = require('crypto');
const blockchain = require('./blockchain');

// ============================================
// GERAR PAR DE CHAVES (RSA)
// ============================================
function generateWalletKeys() {
    try {
        // Tenta gerar chaves RSA reais
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { 
                type: 'spki', 
                format: 'pem' 
            },
            privateKeyEncoding: { 
                type: 'pkcs8', 
                format: 'pem' 
            }
        });
        
        console.log('🔑 Par de chaves RSA gerado com sucesso!');
        return { privateKey, publicKey };
        
    } catch (error) {
        console.warn('⚠️ Erro ao gerar chaves RSA, usando fallback:', error.message);
        
        // Fallback: gera chaves simuladas (para desenvolvimento)
        const privateKey = crypto.randomBytes(32).toString('hex');
        const publicKey = crypto
            .createHash('sha256')
            .update(privateKey + 'bradicoin')
            .digest('hex');
        
        console.log('🔑 Chaves simuladas geradas (modo desenvolvimento)');
        return { privateKey, publicKey };
    }
}

// ============================================
// FUNÇÕES DE CARTEIRA
// ============================================

// ============================================
// CRIAR CARTEIRA COM CHAVES
// ============================================
async function createWallet(username) {
    if (!username || username.length < 3) {
        throw new Error('Username deve ter pelo menos 3 caracteres');
    }

    // Gera endereço único
    const address = 'Br' + crypto.randomBytes(10).toString('hex').toUpperCase();
    
    // Gera par de chaves
    const keys = generateWalletKeys();
    
    // Verifica se já existe
    const existingBalance = blockchain.getBalance(address);
    if (existingBalance > 0) {
        throw new Error('Endereço já existe');
    }

    // Cria a carteira com saldo inicial
    const initialBalance = parseInt(process.env.INITIAL_BALANCE) || 1000;
    blockchain.balances[address] = initialBalance;
    
    // Adiciona transação de criação (agora com publicKey)
    const tx = {
        from: 'system',
        to: address,
        amount: initialBalance,
        type: 'wallet_creation',
        timestamp: Date.now(),
        hash: crypto.randomBytes(32).toString('hex'),
        publicKey: keys.publicKey,  // 🔐 ADICIONADO
        signature: 'system'          // 🔐 ADICIONADO
    };
    
    // Usa o novo método addTransaction que valida a transação
    blockchain.addTransaction(tx);
    blockchain.saveToDisk();

    console.log(`👤 Carteira criada: ${username} (${address})`);
    console.log(`💰 Saldo inicial: ${initialBalance} BRD`);

    return {
        address,
        username,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey, // ⚠️ Em produção, NUNCA exponha a chave privada!
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
        lastActivity: recentTxs.length > 0 ? recentTxs[0].timestamp : null,
        publicKey: recentTxs.length > 0 ? recentTxs[0].publicKey : null
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
// BUSCAR CHAVE PÚBLICA DE UMA CARTEIRA
// ============================================
async function getPublicKey(address) {
    if (!address || !address.startsWith('Br')) {
        throw new Error('Endereço inválido');
    }

    // Procura a primeira transação da carteira para pegar a chave pública
    for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
            if (tx.to === address && tx.publicKey) {
                return tx.publicKey;
            }
        }
    }
    
    return null;
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    createWallet,
    getBalance,
    getHistory,
    isValidAddress,
    getPublicKey,
    generateWalletKeys
};
