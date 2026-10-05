// scripts/test-evm-htlc.js
// ============================================
// Teste E2E: lock → claim em Ethereum Sepolia
// ============================================
// Uso: node scripts/test-evm-htlc.js [chainKey]
// Ex:  node scripts/test-evm-htlc.js ethereum
// ============================================

require('dotenv').config();

const crypto = require('crypto');
const { sha256 } = require('@noble/hashes/sha2');
const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils');
const { ethers } = require('ethers');

const EvmAdapter = require('../atomic-swap/chains/evmAdapter');

async function main() {
    const chainKey = process.argv[2] || 'ethereum';
    console.log(`🧪 Teste EVM HTLC — ${chainKey}\n`);

    const adapter = new EvmAdapter(chainKey);
    const info = adapter.getInfo();

    console.log('Info:');
    console.log(`  Network:  ${info.network}`);
    console.log(`  ChainId:  ${info.chainId}`);
    console.log(`  Signer:   ${info.address}`);
    console.log(`  Contract: ${info.contract}`);
    console.log('');

    if (!adapter.wallet) {
        console.error('❌ PRIVATE_KEY não configurada');
        process.exit(1);
    }
    if (!adapter.htlcContract) {
        console.error(`❌ Contrato HTLC não configurado. Rode:`);
        console.error(`   node scripts/deploy-evm-htlc.js ${chainKey}`);
        process.exit(1);
    }

    const balance = await adapter.getBalance(adapter.wallet.address);
    console.log(`💰 Balance: ${balance.balance} ${balance.symbol}`);

    if (balance.balance < 0.001) {
        console.error(`❌ Saldo baixo. Faucet:`);
        console.error(`   Sepolia: https://sepoliafaucet.com`);
        process.exit(1);
    }

    // 1. Gera secret + hashlock
    const secret = crypto.randomBytes(32).toString('hex');
    const hashlock = bytesToHex(sha256(utf8ToBytes(secret)));
    console.log(`🔐 Secret:   ${secret}`);
    console.log(`🔒 Hashlock: ${hashlock}`);

    // 2. Timelock +30 min
    const timelock = Math.floor(Date.now() / 1000) + 30 * 60 + 60;
    console.log(`⏰ Timelock: ${timelock} (${new Date(timelock * 1000).toISOString()})`);

    // 3. Gera swapId
    const swapId = `test_${Date.now()}`;
    console.log(`🆔 swapId:   ${swapId}`);
    console.log('');

    // 4. LOCK
    console.log('📡 Locking HTLC...');
    const lockResult = await adapter.lockHtlc({
        sender: adapter.wallet.address,
        receiver: adapter.wallet.address,  // self-swap
        amount: '0.0001',
        hashlock,
        timelock,
        swapId
    });

    console.log('✅ HTLC locked:');
    console.log(`   htlcId:  ${lockResult.htlcId}`);
    console.log(`   txHash:  ${lockResult.txHash}`);
    console.log(`   swapId:  ${lockResult.swapId}`);
    console.log(`   block:   ${lockResult.blockNumber}`);
    console.log(`🔍 ${lockResult.explorerUrl}`);
    console.log('');

    // 5. Status
    console.log('📊 Status on-chain:');
    const status = await adapter.getHtlcStatus(lockResult.swapId);
    console.log(`   sender:   ${status.sender}`);
    console.log(`   receiver: ${status.receiver}`);
    console.log(`   amount:   ${status.amount} ${adapter.symbol}`);
    console.log(`   status:   ${status.status}`);
    console.log('');

    // 6. Aguarda confirmações
    console.log(`⏳ Aguardando ${adapter.confirmations} confirmações...`);
    await adapter.waitForConfirmations(lockResult.txHash, adapter.confirmations);
    console.log('✅ Confirmado!');
    console.log('');

    // 7. CLAIM
    console.log('💰 Claim com preimage...');
    const claimResult = await adapter.claimHtlc({
        htlcId: lockResult.htlcId,
        swapId: lockResult.swapId,
        preimage: secret,
        claimer: adapter.wallet.address
    });

    console.log('✅ HTLC claimed:');
    console.log(`   txHash: ${claimResult.txHash}`);
    console.log(`   block:  ${claimResult.blockNumber}`);
    console.log(`🔍 ${claimResult.explorerUrl}`);
    console.log('');

    // 8. Status final
    const finalStatus = await adapter.getHtlcStatus(lockResult.swapId);
    console.log(`📊 Status final: ${finalStatus.status}`);
    console.log(`   preimage on-chain: ${finalStatus.preimage}`);

    console.log('\n🎉 Teste completo!');
}

main().catch(e => {
    console.error('❌ Erro:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
});
