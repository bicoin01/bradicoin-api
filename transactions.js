// transactions.js
const crypto = require('crypto');
const blockchain = require('./blockchain');
const wallet = require('./wallet');

// ============================================
// FUNÇÕES DE TRANSAÇÃO
// ============================================

// ============================================
// CRIAR TRANSAÇÃO COM ASSINATURA DIGITAL
// ============================================
function createTransaction(from, to, amount, privateKey, fee = 0, type = 'transfer') {
    // Validações básicas
    if (!from || !to || !amount) {
        throw new Error('Dados incompletos: from, to e amount são obrigatórios');
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

    if (!privateKey) {
        throw new Error('Chave privada é obrigatória para assinar a transação');
    }

    // Cria o objeto da transação
    const transaction = {
        from,
        to,
        amount,
        fee,
        type,
        timestamp: Date.now(),
        status: 'pending',
        hash: null,
        signature: null,
        publicKey: null
    };

    // Gera o hash da transação
    const txString = from + to + amount + fee + transaction.timestamp + type;
    transaction.hash = crypto.createHash('sha256').update(txString).digest('hex');

    try {
        // 🔐 CRIA A ASSINATURA DIGITAL
        const signer = crypto.createSign('SHA256');
        const message = from + to + amount + fee + transaction.timestamp + type;
        signer.update(message);
        transaction.signature = signer.sign(privateKey, 'hex');

        // Deriva a chave pública da chave privada
        transaction.publicKey = derivePublicKeyFromPrivate(privateKey);
        
        console.log(`🔐 Transação assinada: ${transaction.hash.substring(0, 10)}...`);
        
    } catch (error) {
        console.error('❌ Erro ao assinar transação:', error.message);
        throw new Error(`Falha ao assinar transação: ${error.message}`);
    }

    return transaction;
}

// ============================================
// DERIVAR CHAVE PÚBLICA DA CHAVE PRIVADA
// ============================================
function derivePublicKeyFromPrivate(privateKey) {
    try {
        // Tenta extrair a chave pública da chave privada (RSA)
        // Em produção, isso seria feito com uma biblioteca adequada
        // Por enquanto, usamos um hash da chave privada como identificador público
        
        const hash = crypto.createHash('sha256');
        hash.update(privateKey + 'bradicoin-public');
        return hash.digest('hex');
        
    } catch (error) {
        console.error('❌ Erro ao derivar chave pública:', error.message);
        // Fallback
        return crypto.createHash('sha256').update(privateKey).digest('hex');
    }
}

// ============================================
// ENVIAR TRANSAÇÃO COM ASSINATURA
// ============================================
async function sendTransaction(from, to, amount, privateKey, fee = 0, type = 'transfer') {
    try {
        console.log(`📤 Iniciando transação: ${amount} BRD de ${from} para ${to}`);

        // 1. Validações iniciais
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

        if (!privateKey) {
            throw new Error('Chave privada é obrigatória');
        }

        // 2. Verifica saldo
        const senderBalance = blockchain.getBalance(from);
        const totalCost = amount + fee;
        
        console.log(`💰 Saldo do remetente: ${senderBalance} BRD`);
        console.log(`💸 Custo total: ${totalCost} BRD (${amount} + ${fee} de taxa)`);

        if (senderBalance < totalCost) {
            throw new Error(`Saldo insuficiente: ${senderBalance} < ${totalCost}`);
        }

        // 3. Cria a transação com assinatura
        const transaction = createTransaction(from, to, amount, privateKey, fee, type);
        
        console.log(`📝 Transação criada: ${transaction.hash}`);

        // 4. 🔐 ADICIONA À BLOCKCHAIN (JÁ VALIDA A ASSINATURA)
        const result = blockchain.addTransaction(transaction);
        
        console.log(`✅ Transação adicionada à fila de pendentes`);

        // 5. Salva no disco
        blockchain.saveToDisk();

        // 6. Tenta minerar automaticamente (se houver transações suficientes)
        try {
            if (blockchain.pendingTransactions.length >= 1) {
                console.log('⛏️ Tentando minerar bloco...');
                // Usa o primeiro validador disponível ou cria um automático
                let minerAddress = 'BrAutoMiner';
                
                // Verifica se já existe um minerador automático
                const existingMiner = blockchain.validators.find(v => v.address === minerAddress);
                if (!existingMiner) {
                    // Cria o minerador automático
                    blockchain.balances[minerAddress] = 0;
                    blockchain.validators.push({
                        address: minerAddress,
                        stake: 1000,
                        blocksProposed: 0,
                        rewards: 0,
                        joined: Date.now(),
                        active: true
                    });
                    console.log('🤖 Minerador automático criado');
                }
                
                // Tenta minerar
                const newBlock = await blockchain.minePendingTransactions(minerAddress);
                if (newBlock) {
                    console.log(`⛏️ Bloco ${newBlock.index} minerado com sucesso!`);
                }
            }
        } catch (miningError) {
            console.log('⏳ Mineração automática não disponível:', miningError.message);
            console.log('💡 As transações serão mineradas no próximo ciclo');
        }

        return {
            success: true,
            transaction,
            status: 'pending',
            message: `✅ Transação de ${amount} BRD enviada com sucesso!`,
            hash: transaction.hash,
            blockIndex: null // Será preenchido quando for minerado
        };

    } catch (error) {
        console.error('❌ Erro ao enviar transação:', error.message);
        return {
            success: false,
            error: error.message,
            status: 'failed'
        };
    }
}

// ============================================
// BUSCAR TRANSAÇÃO POR HASH
// ============================================
async function getTransactionByHash(hash) {
    if (!hash) {
        throw new Error('Hash é obrigatório');
    }

    console.log(`🔍 Buscando transação: ${hash}`);

    // 1. Procura em todos os blocos (transações confirmadas)
    for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
            if (tx.hash === hash) {
                console.log(`✅ Transação encontrada no bloco ${block.index}`);
                return {
                    ...tx,
                    blockIndex: block.index,
                    blockHash: block.hash,
                    confirmed: true,
                    timestamp: block.timestamp,
                    status: 'confirmed'
                };
            }
        }
    }

    // 2. Procura em transações pendentes
    for (const tx of blockchain.pendingTransactions) {
        if (tx.hash === hash) {
            console.log(`⏳ Transação encontrada na fila de pendentes`);
            return {
                ...tx,
                confirmed: false,
                status: 'pending'
            };
        }
    }

    console.log(`❌ Transação não encontrada: ${hash}`);
    throw new Error('Transação não encontrada');
}

// ============================================
// VALIDAR TRANSAÇÃO (VERIFICA ASSINATURA)
// ============================================
function verifyTransactionSignature(transaction) {
    try {
        if (!transaction) {
            throw new Error('Transação é obrigatória');
        }

        if (!transaction.signature || !transaction.publicKey) {
            console.log('❌ Transação sem assinatura ou chave pública');
            return false;
        }

        // Verifica se a transação tem todos os campos necessários
        if (!transaction.from || !transaction.to || !transaction.amount || !transaction.timestamp) {
            console.log('❌ Transação incompleta');
            return false;
        }

        // Usa o método do blockchain para verificar
        const isValid = blockchain.verifyTransaction(transaction);
        
        if (isValid) {
            console.log(`✅ Assinatura da transação ${transaction.hash.substring(0, 10)}... é válida`);
        } else {
            console.log(`❌ Assinatura da transação ${transaction.hash.substring(0, 10)}... é inválida`);
        }
        
        return isValid;

    } catch (error) {
        console.error('❌ Erro ao verificar assinatura:', error.message);
        return false;
    }
}

// ============================================
// BUSCAR TRANSAÇÕES DE UMA CARTEIRA
// ============================================
async function getWalletTransactions(address, limit = 50, offset = 0) {
    if (!address || !address.startsWith('Br')) {
        throw new Error('Endereço inválido');
    }

    console.log(`🔍 Buscando transações da carteira: ${address}`);

    const transactions = [];

    // Busca em todos os blocos
    for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
            if (tx.from === address || tx.to === address) {
                transactions.push({
                    ...tx,
                    blockIndex: block.index,
                    blockHash: block.hash,
                    confirmed: true,
                    timestamp: block.timestamp
                });
            }
        }
    }

    // Busca em transações pendentes
    for (const tx of blockchain.pendingTransactions) {
        if (tx.from === address || tx.to === address) {
            transactions.push({
                ...tx,
                confirmed: false,
                status: 'pending'
            });
        }
    }

    // Ordena por timestamp (mais recente primeiro)
    transactions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Aplica paginação
    const paginated = transactions.slice(offset, offset + limit);

    console.log(`📊 Encontradas ${transactions.length} transações, retornando ${paginated.length}`);

    return {
        address,
        total: transactions.length,
        transactions: paginated,
        limit,
        offset,
        hasMore: offset + limit < transactions.length
    };
}

// ============================================
// ESTATÍSTICAS DE TRANSAÇÕES
// ============================================
async function getTransactionStats() {
    let total = 0;
    let volume = 0;
    let uniqueAddresses = new Set();

    for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
            total++;
            volume += tx.amount || 0;
            if (tx.from && tx.from !== 'system') uniqueAddresses.add(tx.from);
            if (tx.to && tx.to !== 'system') uniqueAddresses.add(tx.to);
        }
    }

    // Calcula taxa média
    let totalFee = 0;
    let feeCount = 0;
    for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
            if (tx.fee !== undefined) {
                totalFee += tx.fee || 0;
                feeCount++;
            }
        }
    }

    const avgFee = feeCount > 0 ? totalFee / feeCount : 0;

    return {
        totalTransactions: total,
        totalVolume: volume,
        averageFee: avgFee,
        pending: blockchain.pendingTransactions.length,
        blocks: blockchain.chain.length,
        uniqueAddresses: uniqueAddresses.size,
        lastBlockTime: blockchain.lastBlockTime ? new Date(blockchain.lastBlockTime).toISOString() : null
    };
}

// ============================================
// CRIAR TRANSAÇÃO DE TESTE (PARA DESENVOLVIMENTO)
// ============================================
async function createTestTransaction(from, to, amount, privateKey) {
    console.log('🧪 Criando transação de teste...');
    
    // Verifica se a carteira existe
    const senderExists = blockchain.balances[from] !== undefined;
    const receiverExists = blockchain.balances[to] !== undefined;

    if (!senderExists) {
        console.log(`⚠️ Remetente ${from} não existe, criando...`);
        await wallet.createWallet(from);
    }

    if (!receiverExists) {
        console.log(`⚠️ Destinatário ${to} não existe, criando...`);
        await wallet.createWallet(to);
    }

    return await sendTransaction(from, to, amount, privateKey);
}

// ============================================
// EXPORTA
// ============================================
module.exports = {
    createTransaction,
    sendTransaction,
    getTransactionByHash,
    verifyTransactionSignature,
    getWalletTransactions,
    getTransactionStats,
    createTestTransaction,
    derivePublicKeyFromPrivate
};
