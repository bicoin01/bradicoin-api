// scripts/init-reserve-balance.js
// ============================================
// Inicializa a carteira do Reserve com 98 trilhões
// ============================================
// Uso: node scripts/init-reserve-balance.js
//
// ⚠️  Rode DEPOIS de:
//     1. node scripts/generate-reserve-wallet.js
//     2. Colar RESERVE_ADDRESS + RESERVE_PRIVATE_KEY no .env
//     3. Colar MASTER_KEY + ADMIN_KEY no .env
//     4. Ter MONGODB_URI configurado
// ============================================

require('dotenv').config();

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const secp256k1 = require('@noble/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils');

// ============================================
// CONSTANTES
// ============================================
const INITIAL_BALANCE = '98000000000000';   // 98 trilhões
const MAX_SUPPLY      = '100000000000000';  // 100 trilhões

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('');
    console.log('════════════════════════════════════════════════════');
    console.log('  🏦 INICIALIZANDO RESERVE');
    console.log('════════════════════════════════════════════════════');
    console.log('');

    // 1. Valida .env
    const address = process.env.RESERVE_ADDRESS;
    const privateKey = process.env.RESERVE_PRIVATE_KEY;

    if (!address || !/^Br[a-fA-F0-9]{38}$/i.test(address)) {
        console.error('❌ RESERVE_ADDRESS inválido ou não configurado no .env');
        console.error('   Valor atual:', address);
        process.exit(1);
    }

    if (!privateKey || !/^[a-fA-F0-9]{64}$/.test(privateKey)) {
        console.error('❌ RESERVE_PRIVATE_KEY inválida ou não configurada no .env');
        console.error('   (deve ter 64 caracteres hex)');
        process.exit(1);
    }

    if (!process.env.MASTER_KEY || process.env.MASTER_KEY.length < 32) {
        console.error('❌ MASTER_KEY não configurada (min 32 chars)');
        process.exit(1);
    }

    if (!process.env.MONGODB_URI) {
        console.error('❌ MONGODB_URI não configurada');
        process.exit(1);
    }

    // 2. Deriva publicKey da privateKey
    const privateKeyBytes = hexToBytes(privateKey);
    const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);
    const publicKeyHex = bytesToHex(publicKeyBytes);

    // 3. Confirma que publicKey corresponde ao address
    const hash = keccak_256(publicKeyBytes);
    const derivedAddress = 'Br' + bytesToHex(hash.slice(-19)).toLowerCase();

    if (derivedAddress !== address.toLowerCase()) {
        console.error('❌ RESERVE_ADDRESS não corresponde à RESERVE_PRIVATE_KEY!');
        console.error(`   Esperado: ${derivedAddress}`);
        console.error(`   Recebido: ${address}`);
        process.exit(1);
    }

    console.log(`✅ Endereço:   ${address}`);
    console.log(`✅ Public Key: ${publicKeyHex.substring(0, 24)}...`);
    console.log('');

    // 4. Conecta MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000
    });
    console.log('✅ MongoDB conectado');
    console.log('');

    // 5. Importa models DEPOIS de conectar (evita erro de env vars)
    const WalletModel = require('../models/Wallet');
    const { ReserveModel } = require('../models/Reserve');
    const { encrypt } = require('../utils/crypto');

    // 6. Criptografa private key
    const encryptedPrivateKey = encrypt(privateKey);
    console.log('🔐 Private key criptografada');
    console.log('');

    // 7. Atualiza/cria WalletModel do Reserve
    const balanceDecimal = Decimal128.fromString(INITIAL_BALANCE);

    let walletDoc = await WalletModel.findOne({ address }).select('+encryptedPrivateKey');

    if (walletDoc) {
        console.log('ℹ️  Carteira já existia, atualizando...');
        walletDoc.publicKey = publicKeyHex;
        walletDoc.encryptedPrivateKey = encryptedPrivateKey;
        walletDoc.balance = balanceDecimal;
        walletDoc.nonce = 0;
        walletDoc.status = 'active';
        await walletDoc.save();
    } else {
        console.log('🆕 Criando carteira do Reserve...');
        walletDoc = await WalletModel.create({
            address,
            publicKey: publicKeyHex,
            encryptedPrivateKey,
            balance: balanceDecimal,
            nonce: 0,
            status: 'active'
        });
    }

    console.log(`💰 Saldo configurado: ${INITIAL_BALANCE} BRD`);
    console.log('');

    // 8. Cria/atualiza ReserveModel
    let reserveDoc = await ReserveModel.findOne({ address });

    if (reserveDoc) {
        console.log('ℹ️  ReserveModel já existia, atualizando...');
        reserveDoc.balance = balanceDecimal;
        reserveDoc.totalSupply = balanceDecimal;
        reserveDoc.maxSupply = Decimal128.fromString(MAX_SUPPLY);
        reserveDoc.mintingLocked = false;
        reserveDoc.lastActivity = new Date();
        await reserveDoc.save();
    } else {
        console.log('🆕 Criando ReserveModel...');
        reserveDoc = await ReserveModel.create({
            address,
            balance: balanceDecimal,
            totalSupply: balanceDecimal,
            maxSupply: Decimal128.fromString(MAX_SUPPLY),
            mintingLocked: false
        });
    }

    console.log(`📊 Total Supply: ${MAX_SUPPLY} BRD`);
    console.log('');

    // 9. Resumo final
    console.log('════════════════════════════════════════════════════');
    console.log('  ✅ RESERVE INICIALIZADO COM SUCESSO!');
    console.log('════════════════════════════════════════════════════');
    console.log('');
    console.log(`Endereço:  ${address}`);
    console.log(`Saldo:     ${INITIAL_BALANCE} BRD`);
    console.log(`Supply:    ${MAX_SUPPLY} BRD`);
    console.log('');
    console.log('💡 Próximos passos:');
    console.log('   1. npm start');
    console.log('   2. Testar: GET /api/v1/reserve/balance');
    console.log('   3. Testar envio via POST /api/v1/reserve/send');
    console.log('');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('');
    console.error('❌ ERRO FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
