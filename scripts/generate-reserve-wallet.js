// scripts/generate-reserve-wallet.js
// ============================================
// Gera carteira REAL compatível com Bradicoin
// ============================================
// Uso: node scripts/generate-reserve-wallet.js
// ============================================

require('dotenv').config();

const crypto = require('crypto');
const secp256k1 = require('@noble/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils');

function generateWallet() {
    // 1. Private key: 32 bytes (256 bits de entropia)
    const privateKeyBytes = crypto.randomBytes(32);
    const privateKeyHex = bytesToHex(privateKeyBytes);

    // 2. Public key comprimida (33 bytes = 66 hex)
    const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);
    const publicKeyHex = bytesToHex(publicKeyBytes);

    // 3. Endereço: Br + keccak256(pubkey).slice(-19).hex
    const hash = keccak_256(publicKeyBytes);
    const addressBytes = hash.slice(-19);
    const addressHex = bytesToHex(addressBytes).toLowerCase();
    const address = 'Br' + addressHex;

    return { address, privateKey: privateKeyHex, publicKey: publicKeyHex };
}

function validate(wallet) {
    const ADDRESS_REGEX = /^Br[a-fA-F0-9]{38}$/;
    const PUBKEY_REGEX = /^[a-fA-F0-9]{66}$/;
    const PRIVKEY_REGEX = /^[a-fA-F0-9]{64}$/;

    const errors = [];

    if (!ADDRESS_REGEX.test(wallet.address)) errors.push(`❌ Endereço inválido: ${wallet.address}`);
    if (!PUBKEY_REGEX.test(wallet.publicKey)) errors.push(`❌ Public key inválida`);
    if (!PRIVKEY_REGEX.test(wallet.privateKey)) errors.push(`❌ Private key inválida`);

    // Confirma que address corresponde à publicKey
    const pubKeyBytes = hexToBytes(wallet.publicKey);
    const hash = keccak_256(pubKeyBytes);
    const derivedAddress = 'Br' + bytesToHex(hash.slice(-19)).toLowerCase();

    if (derivedAddress !== wallet.address) {
        errors.push(`❌ Endereço não corresponde à public key!`);
        errors.push(`   Esperado: ${derivedAddress}`);
        errors.push(`   Recebido: ${wallet.address}`);
    }

    return errors;
}

console.log('');
console.log('════════════════════════════════════════════════════');
console.log('  🔐 BRADICOIN — GERADOR DE CARTEIRA DO RESERVE');
console.log('════════════════════════════════════════════════════');
console.log('');

const wallet = generateWallet();
const errors = validate(wallet);

if (errors.length > 0) {
    console.error('❌ ERROS NA GERAÇÃO:');
    errors.forEach(e => console.error(e));
    process.exit(1);
}

console.log('✅ Carteira gerada com sucesso!');
console.log('');
console.log('════════════════════════════════════════════════════');
console.log('  📋 COPIE ISSO PARA O .env');
console.log('════════════════════════════════════════════════════');
console.log('');
console.log(`RESERVE_ADDRESS=${wallet.address}`);
console.log(`RESERVE_PRIVATE_KEY=${wallet.privateKey}`);
console.log('');
console.log('════════════════════════════════════════════════════');
console.log('  🔍 DADOS COMPLETOS');
console.log('════════════════════════════════════════════════════');
console.log('');
console.log(`Endereço:    ${wallet.address}`);
console.log(`Public Key:  ${wallet.publicKey}`);
console.log(`Private Key: ${wallet.privateKey}`);
console.log('');
console.log('════════════════════════════════════════════════════');
console.log('  ⚠️  AVISOS DE SEGURANÇA');
console.log('════════════════════════════════════════════════════');
console.log('');
console.log('1. NUNCA compartilhe a PRIVATE KEY com ninguém');
console.log('2. NUNCA commite a private key no git');
console.log('3. Faça backup da private key em local seguro');
console.log('4. Se perder, perde acesso à carteira');
console.log('');
console.log('💡 Próximo: node scripts/init-reserve-balance.js');
console.log('');
