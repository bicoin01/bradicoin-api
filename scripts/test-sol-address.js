require('dotenv').config();
const deposit = require('../services/buy/depositAddress');

const start = parseInt(process.env.BUY_HD_INDEX_START || '1000', 10);

console.log('');
console.log('🧪 TESTE — depositAddress Solana');
console.log('');

try {
    console.log('EVM  índice ' + start + ' →', deposit.deriveEvmAddress(start));
    console.log('SOL  índice ' + start + ' →', deposit.deriveSolAddress(start));
    console.log('SOL  índice ' + (start + 1) + ' →', deposit.deriveSolAddress(start + 1));

    // Compara com derivação manual
    const bip39 = require('bip39');
    const { derivePath } = require('ed25519-hd-key');
    const { Keypair } = require('@solana/web3.js');

    const mnemonic = process.env.BUY_MASTER_SEED;
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const seedHex = Buffer.from(seed).toString('hex');
    const path = `m/44'/501'/${start}'/0'`;
    const derived = derivePath(path, seedHex);
    const expected = Keypair.fromSeed(derived.key).publicKey.toBase58();

    if (expected !== deposit.deriveSolAddress(start)) {
        console.error('❌ SOL não bate com derivação manual');
        console.error('   esperado:', expected);
        process.exit(1);
    }

    console.log('');
    console.log('🎉 SOL derivação OK');
    console.log('');
} catch (err) {
    console.error('❌ FALHOU:', err.message);
    process.exit(1);
}
