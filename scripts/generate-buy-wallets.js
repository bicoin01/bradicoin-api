// scripts/generate-buy-wallets.js
// ============================================
// Gera BUY_MASTER_SEED (BIP39) + endereços das redes suportadas
// ============================================
// Uso:
//   node scripts/generate-buy-wallets.js
//
// O que faz:
//   1. Gera uma seed BIP39 válida (12 palavras, 128 bits entropy)
//   2. Deriva o endereço HD índice BUY_HD_INDEX_START (padrão 1000)
//      para cada rede ativa
//   3. Imprime tudo no terminal pra você copiar pro .env
//
// ⚠️ A seed imprime UMA VEZ. Guarde em local seguro OFFLINE.
// ⚠️ Se vazar, qualquer um deriva TODOS os endereços e rouba fundos.
// ============================================

const crypto = require('crypto');
const { ethers } = require('ethers');

// ============================================
// BIP39 — gerar mnemonic de 12 palavras (128 bits)
// ============================================
function generateMnemonic() {
    // 128 bits de entropia = 12 palavras BIP39
    const entropy = crypto.randomBytes(16);
    return ethers.Mnemonic.fromEntropy(entropy).phrase;
}

// ============================================
// Derivação HD por rede
// ============================================
// Padrões BIP44:
//   BTC:  m/44'/0'/0'/0/{index}
//   ETH:  m/44'/60'/0'/0/{index}
//   BNB:  m/44'/60'/0'/0/{index}  (mesma do ETH, BSC usa mesmo path)
// ============================================

function deriveEthAddress(mnemonic, index) {
    const path = `m/44'/60'/0'/0/${index}`;
    const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path);
    return wallet.address;
}

// BSC usa mesmo path do ETH (coin type 60)
function deriveBnbAddress(mnemonic, index) {
    return deriveEthAddress(mnemonic, index);
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log('  🔐 GERADOR DE SEED — BradiCoin BUY (Fase 1)');
    console.log('════════════════════════════════════════════════════════');
    console.log('');

    // 1. Gera a mnemonic
    const mnemonic = generateMnemonic();
    const words = mnemonic.split(' ');
    console.log('📝 SEED (BIP39 — 12 palavras):');
    console.log('');
    words.forEach((w, i) => {
        console.log(`   ${String(i + 1).padStart(2, '0')}. ${w}`);
    });
    console.log('');

    // 2. Valida que é BIP39 válida
    if (!ethers.Mnemonic.isValidMnemonic(mnemonic)) {
        console.error('❌ ERRO: mnemonic inválida. Abortando.');
        process.exit(1);
    }
    console.log('✅ Mnemonic BIP39 válida');
    console.log('');

    // 3. Deriva endereços nos índices BUY_HD_INDEX_START (padrão 1000)
    const startIndex = parseInt(process.env.BUY_HD_INDEX_START || '1000', 10);
    console.log(`📌 Derivando endereços no índice ${startIndex}:`);
    console.log('');

    // BNB nativo (BSC)
    const bnbAddr = deriveBnbAddress(mnemonic, startIndex);
    console.log(`   BNB nativo  → ${bnbAddr}`);
    console.log(`                  (chain 56, BSC)`);

    // USDT-BEP20 (mesma address do BNB — contrato USDT, mas o "deposit address"
    // é o mesmo EOA; o monitor rastreia evento Transfer pro mesmo endereço)
    console.log(`   USDT-BEP20  → ${bnbAddr}  (mesma carteira, contrato USDT)`);
    console.log('');

    // ETH (opcional — só se quiser ligar depois)
    const ethAddr = deriveEthAddress(mnemonic, startIndex);
    console.log(`   ETH nativo  → ${ethAddr}`);
    console.log(`                  (chain 1, Ethereum)`);
    console.log(`   USDT-ERC20  → ${ethAddr}  (mesma carteira, contrato USDT)`);
    console.log('');

    // 4. Verifica se a carteira já tem saldo (só leitura — não gasta nada)
    console.log('🔍 Verificando saldo das carteiras na mainnet (só leitura)...');
    console.log('');
    try {
        const bscProvider = new ethers.JsonRpcProvider(
            'https://bsc-dataseed.binance.org',
            { chainId: 56, name: 'bsc' },
            { staticNetwork: true }
        );
        const bnbBalance = await bscProvider.getBalance(bnbAddr);
        console.log(`   BNB:  ${ethers.formatEther(bnbBalance)} BNB`);

        const USDT_BEP20 = '0x55d398326f99059fF775485246999027B3197955';
        const usdtAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
        const usdt = new ethers.Contract(USDT_BEP20, usdtAbi, bscProvider);
        const usdtBal = await usdt.balanceOf(bnbAddr);
        console.log(`   USDT: ${ethers.formatUnits(usdtBal, 18)} USDT-BEP20`);
    } catch (err) {
        console.log(`   ⚠️ Não consegui checar saldo: ${err.message}`);
        console.log(`   (pode ser RPC fora do ar — não impede nada)`);
    }
    console.log('');

    // 5. Instruções finais
    console.log('════════════════════════════════════════════════════════');
    console.log('📋 PRÓXIMOS PASSOS');
    console.log('════════════════════════════════════════════════════════');
    console.log('');
    console.log('1. Copie a seed acima e cole no seu .env em:');
    console.log('');
    console.log(`   BUY_MASTER_SEED="${mnemonic}"`);
    console.log('');
    console.log('2. Se o índice for diferente, ajuste:');
    console.log(`   BUY_HD_INDEX_START=${startIndex}`);
    console.log('');
    console.log('3. Habilite os monitores:');
    console.log('   BUY_BNB_ENABLED=true');
    console.log('   BUY_USDT_BEP20_ENABLED=true');
    console.log('');
    console.log('4. ⚠️ TESTE DA SEED: rode este script DE NOVO,');
    console.log('   apague a seed nova gerada, e confira se os');
    console.log('   endereços BNB/USDT batem com os de cima.');
    console.log('   Se baterem → seed foi copiada certa.');
    console.log('');
    console.log('5. ⚠️ BACKUP OFFLINE OBRIGATÓRIO:');
    console.log('   - Escreva a seed num PAPEL');
    console.log('   - Guarde em cofre / local seguro');
    console.log('   - NUNCA fotografe, NUNCA salve em nuvem');
    console.log('');
    console.log('6. ⚠️ NUNCA COMMITE o .env com BUY_MASTER_SEED.');
    console.log('   Confirme: git check-ignore .env');
    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log('');

    // 6. Aviso de segurança
    console.log('🔴 AVISO:');
    console.log('   Se alguém obtiver esta seed, pode derivar TODOS os');
    console.log('   endereços de depósito e roubar fundos em trânsito.');
    console.log('');
    console.log('   Se a seed for exposta (foto, print, chat, git, etc.):');
    console.log('   1. Gere uma nova com este script');
    console.log('   2. Atualize BUY_MASTER_SEED no .env');
    console.log('   3. Reconfigure os monitores');
    console.log('   4. NÃO reutilize a seed antiga');
    console.log('');
}

main().catch((err) => {
    console.error('❌ ERRO FATAL:', err);
    process.exit(1);
});
