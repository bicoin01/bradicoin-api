// scripts/test-sdk.js
// ============================================
// Testa o Bradicoin SDK end-to-end
// ============================================
// Uso: node scripts/test-sdk.js
// ============================================

require('dotenv').config();

const Bradicoin = require('../bradicoin-sdk');

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function main() {
    console.log('🧪 Testando Bradicoin SDK');
    console.log(`📡 API: ${API_URL}\n`);

    const sdk = new Bradicoin({ apiUrl: API_URL });

    // ============================================
    // 1. HEALTH
    // ============================================
    console.log('1️⃣  Health check...');
    const health = await sdk.health();
    console.log(`   ✅ Status: ${health.status}`);
    console.log('');

    // ============================================
    // 2. WALLET LOCAL
    // ============================================
    console.log('2️⃣  Gera wallet local...');
    const wallet = sdk.wallet.create();
    console.log(`   Address:    ${wallet.address}`);
    console.log(`   PublicKey:  ${wallet.publicKey}`);
    console.log(`   PrivateKey: ${wallet.privateKey.slice(0, 20)}...`);
    console.log('');

    // ============================================
    // 3. ASSINATURA
    // ============================================
    console.log('3️⃣  Assina + verifica mensagem...');
    const msg = 'Hello Bradicoin';
    const sig = sdk.wallet.sign(msg, wallet.privateKey);
    const valid = sdk.wallet.verify(msg, sig, wallet.publicKey);
    console.log(`   Assinatura: ${sig.slice(0, 30)}...`);
    console.log(`   Válida?     ${valid ? '✅ SIM' : '❌ NÃO'}`);
    console.log('');

    // ============================================
    // 4. ATOMIC SWAP — CHAINS
    // ============================================
    console.log('4️⃣  Lista chains do atomic swap...');
    try {
        const chains = await sdk.atomicSwap.listChains();
        console.log(`   ✅ ${chains.length} chains suportadas:`);
        chains.slice(0, 5).forEach(c => {
            console.log(`      • ${c.id.padEnd(12)} ${c.symbol.padEnd(6)} ${c.enabled ? '✅' : '❌'}`);
        });
        if (chains.length > 5) console.log(`      ... e mais ${chains.length - 5}`);
    } catch (e) {
        console.log(`   ❌ Erro: ${e.message}`);
    }
    console.log('');

    // ============================================
    // 5. SECRET — geração client-side
    // ============================================
    console.log('5️⃣  Gera secret client-side...');
    const { secret, hashlock } = sdk.atomicSwap.generateSecret();
    console.log(`   Secret:   ${secret.slice(0, 20)}...`);
    console.log(`   Hashlock: ${hashlock}`);

    const verify = sdk.atomicSwap.verifySecret(secret, hashlock);
    console.log(`   Verifica: ${verify ? '✅ SIM' : '❌ NÃO'}`);
    console.log('');

    // ============================================
    // 6. SECRET — via servidor
    // ============================================
    console.log('6️⃣  Gera secret via servidor...');
    try {
        const remote = await sdk.atomicSwap.generateSecretRemote();
        console.log(`   ✅ Secret:   ${remote.secret?.slice(0, 20)}...`);
        console.log(`   ✅ Hashlock: ${remote.hashlock}`);
    } catch (e) {
        console.log(`   ❌ Erro: ${e.message}`);
    }
    console.log('');

    // ============================================
    // 7. ORDER BOOK STATS
    // ============================================
    console.log('7️⃣  Order book stats...');
    try {
        const stats = await sdk.atomicSwap.getOrderBookStats();
        console.log(`   Ordens:    ${stats.totalOrders}`);
        console.log(`   Pares:     ${stats.totalPairs}`);
        console.log(`   Makers:    ${stats.totalMakers}`);
    } catch (e) {
        console.log(`   ❌ Erro: ${e.message}`);
    }
    console.log('');

    // ============================================
    // 8. GOSSIP STATS
    // ============================================
    console.log('8️⃣  Gossip stats...');
    try {
        const stats = await sdk.atomicSwap.getGossipStats();
        if (stats) {
            console.log(`   Enviadas:  ${stats.sent}`);
            console.log(`   Recebidas: ${stats.received}`);
            console.log(`   Peers:     ${stats.connectedPeers || 0}`);
        } else {
            console.log(`   ⚠️  Gossip não inicializado`);
        }
    } catch (e) {
        console.log(`   ⚠️  ${e.message}`);
    }
    console.log('');

    // ============================================
    // 9. ATOMIC SWAP STATS
    // ============================================
    console.log('9️⃣  Atomic swap stats globais...');
    try {
        const stats = await sdk.atomicSwap.getStats();
        console.log(`   Total:      ${stats.total}`);
        console.log(`   Abertas:    ${stats.open}`);
        console.log(`   Completas:  ${stats.completed}`);
        console.log(`   Refundadas: ${stats.refunded}`);
        console.log(`   Expiradas:  ${stats.expired}`);
        console.log(`   Taxa:       ${stats.successRate}`);
    } catch (e) {
        console.log(`   ❌ Erro: ${e.message}`);
    }
    console.log('');

    // ============================================
    // 10. TOP PAIRS
    // ============================================
    console.log('🔟 Top pairs do order book...');
    try {
        const pairs = await sdk.atomicSwap.getTopPairs(10);
        if (pairs.length === 0) {
            console.log(`   (nenhum par disponível)`);
        } else {
            pairs.forEach(p => {
                console.log(`   • ${p.fromChain}:${p.fromToken} → ${p.toChain}:${p.toToken} (${p.count})`);
            });
        }
    } catch (e) {
        console.log(`   ❌ Erro: ${e.message}`);
    }
    console.log('');

    console.log('🎉 Teste do SDK concluído!');
}

main().catch(e => {
    console.error('❌ Erro:', e);
    process.exit(1);
});
