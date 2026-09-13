// wallet.js
// ============================================
// Bradicoin Blockchain - Wallet
// ============================================

const crypto = require('crypto');
const mongoose = require('mongoose');
const blockchain = require('./blockchain');

// ============================================
// SCHEMA MONGOOSE — CARTEIRAS
// ============================================
const WalletSchema = new mongoose.Schema({
    address: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, index: true },
    publicKey: { type: String, required: true },
    
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true
    },

    createdAt: { type: String, default: () => new Date().toISOString() }
});

const WalletModel = mongoose.model('Wallet', WalletSchema);

// ============================================
// GERAR PAR DE CHAVES (RSA)
// ============================================
function generateWalletKeys() {
    try {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });

        return { privateKey, publicKey };
    } catch (error) {
        console.warn('⚠️ Fallback de chaves:', error.message);

        const privateKey = crypto.randomBytes(32).toString('hex');
        const publicKey = crypto
            .createHash('sha256')
            .update(privateKey + 'bradicoin')
            .digest('hex');

        return { privateKey, publicKey };
    }
}

// ============================================
// INICIALIZAR
// ============================================
async function initialize() {
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGO_URI);
    }
    await WalletModel.init(); // garante índices
    console.log('✅ Wallet inicializada');
}

// ============================================
// CRIAR CARTEIRA (aceita address/publicKey/userId opcionais)
// ============================================
async function createWallet(username, options = {}) {
    const {
        address: presetAddress,
        publicKey: presetPublicKey,
        userId = null
    } = options;

    if (!username || username.length < 3) {
        throw new Error('Username deve ter pelo menos 3 caracteres');
    }

    // Verifica se username já existe
    const usernameExists = await WalletModel.findOne({ username });
    if (usernameExists) {
        throw new Error(`Username "${username}" já está em uso`);
    }

    // Endereço: usa o do frontend se vier, senão gera
    let address = presetAddress;
    if (!address) {
        let attempts = 0;
        do {
            address = 'Br' + crypto.randomBytes(10).toString('hex').toUpperCase();
            attempts++;
            if (attempts > 5) throw new Error('Não foi possível gerar endereço único');
        } while (await WalletModel.findOne({ address }));
    } else {
        if (!isValidAddress(address)) {
            throw new Error('Endereço inválido');
        }
        const addrExists = await WalletModel.findOne({ address });
        if (addrExists) {
            throw new Error('Endereço já está em uso');
        }
    }

    // Gera par de chaves (ou usa a publicKey do frontend)
    const keys = generateWalletKeys();
    const finalPublicKey = presetPublicKey || keys.publicKey;

    // Salva wallet no Mongo — AGORA COM userId
    await WalletModel.create({
        address,
        username,
        publicKey: finalPublicKey,
        userId,
        createdAt: new Date().toISOString()
    });

    // Transação de criação (fromAddress: null = sistema)
    const initialBalance = parseInt(process.env.INITIAL_BALANCE) || 1000;

    const tx = {
        fromAddress: null,
        toAddress: address,
        amount: initialBalance,
        timestamp: new Date().toISOString(),
        type: 'wallet_creation'
    };

    await blockchain.addTransaction(tx);

    console.log(`👤 Carteira criada: ${username} (${address})`);
    console.log(`💰 Saldo inicial pendente: ${initialBalance} BRD`);

    return {
        address,
        username,
        publicKey: finalPublicKey,
        privateKey: keys.privateKey,
        initialBalance,
        createdAt: new Date().toISOString(),
        note: 'Saldo será confirmado quando o próximo bloco for minerado'
    };
}

// ============================================
// CONSULTAR SALDO
// ============================================
async function getBalance(address) {
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }

    // Verifica se a wallet existe no Mongo
    const walletDoc = await WalletModel.findOne({ address });
    const exists = !!walletDoc;

    // Saldo confirmado (chain)
    const confirmedBalance = blockchain.getBalance(address);

    // Saldo pendente (transações não mineradas)
    const pendingBalance = blockchain.pendingTransactions
        .filter((tx) => tx.toAddress === address || tx.fromAddress === address)
        .reduce((acc, tx) => {
            if (tx.toAddress === address) acc += tx.amount;
            if (tx.fromAddress === address) acc -= tx.amount;
            return acc;
        }, 0);

    const recentTxs = await getHistory(address, 5);

    return {
        address,
        username: walletDoc ? walletDoc.username : null,
        exists,
        balance: confirmedBalance,
        pending: pendingBalance,
        total: confirmedBalance + pendingBalance,
        transactions: recentTxs.length,
        lastActivity: recentTxs.length > 0 ? recentTxs[0].timestamp : null,
        publicKey: walletDoc ? walletDoc.publicKey : null
    };
}

// ============================================
// HISTÓRICO
// ============================================
async function getHistory(address, limit = 50) {
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }

    const history = [];

    for (const block of blockchain.chain) {
        if (!Array.isArray(block.transactions)) continue;

        for (const tx of block.transactions) {
            if (tx.fromAddress === address || tx.toAddress === address) {
                history.push({
                    fromAddress: tx.fromAddress,
                    toAddress: tx.toAddress,
                    amount: tx.amount,
                    timestamp: tx.timestamp,
                    blockIndex: block.index,
                    blockHash: block.hash,
                    confirmed: true
                });
            }
        }
    }

    // Pendentes também
    for (const tx of blockchain.pendingTransactions) {
        if (tx.fromAddress === address || tx.toAddress === address) {
            history.push({
                fromAddress: tx.fromAddress,
                toAddress: tx.toAddress,
                amount: tx.amount,
                timestamp: tx.timestamp,
                confirmed: false
            });
        }
    }

    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return history.slice(0, limit);
}

// ============================================
// VALIDAR ENDEREÇO
// ============================================
function isValidAddress(address) {
    if (!address || typeof address !== 'string') return false;
    if (!address.startsWith('Br')) return false;
    if (address.length < 3) return false;
    return true;
}

// ============================================
// BUSCAR CHAVE PÚBLICA
// ============================================
async function getPublicKey(address) {
    if (!isValidAddress(address)) {
        throw new Error('Endereço inválido');
    }
    const walletDoc = await WalletModel.findOne({ address });
    return walletDoc ? walletDoc.publicKey : null;
}

// ============================================
// BUSCAR POR USERNAME
// ============================================
async function getByUsername(username) {
    const walletDoc = await WalletModel.findOne({ username });
    if (!walletDoc) return null;
    return getBalance(walletDoc.address);
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    initialize,
    createWallet,
    getBalance,
    getHistory,
    isValidAddress,
    getPublicKey,
    getByUsername,
    generateWalletKeys,
    WalletModel
};
