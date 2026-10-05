// scripts/deploy-evm-htlc.js
// ============================================
// Deploy do contrato evmHTLC.sol
// ============================================
// Uso: node scripts/deploy-evm-htlc.js <chainKey>
// Ex:  node scripts/deploy-evm-htlc.js ethereum
// ============================================

require('dotenv').config();

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const EVM_CHAINS = require('../atomic-swap/chains/evmAdapter').EVM_CHAINS;

async function main() {
    const chainKey = process.argv[2];
    if (!chainKey || !EVM_CHAINS[chainKey]) {
        console.error('Uso: node scripts/deploy-evm-htlc.js <chainKey>');
        console.error('Chains: ' + Object.keys(EVM_CHAINS).join(', '));
        process.exit(1);
    }

    const cfg = EVM_CHAINS[chainKey];
    const networkName = process.env[`${cfg.envKey}_NETWORK`] || 'sepolia';
    const rpcUrl = process.env[`${cfg.envKey}_RPC_URL`];
    const privateKey = process.env[`${cfg.envKey}_PRIVATE_KEY`];

    if (!rpcUrl || !privateKey) {
        console.error(`❌ ${cfg.envKey}_RPC_URL e ${cfg.envKey}_PRIVATE_KEY são obrigatórios`);
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log('');
    console.log('════════════════════════════════════════');
    console.log(`🚀 Deploy ${cfg.name} HTLC`);
    console.log('════════════════════════════════════════');
    console.log(`Network:    ${networkName}`);
    console.log(`Deployer:   ${wallet.address}`);

    const balance = await provider.getBalance(wallet.address);
    console.log(`Balance:    ${ethers.formatEther(balance)} ${cfg.symbol}`);
    console.log('');

    if (balance === 0n) {
        console.error('❌ Sem saldo. Fundeie o endereço primeiro.');
        process.exit(1);
    }

    // Carrega bytecode compilado
    const bytecodePath = path.join(__dirname, '..', 'atomic-swap', 'contracts', 'evmHTLC.bytecode.json');

    if (!fs.existsSync(bytecodePath)) {
        console.error('');
        console.error('❌ Bytecode não encontrado em:');
        console.error(`   ${bytecodePath}`);
        console.error('');
        console.error('Compile o contrato primeiro:');
        console.error('   1. Instale solc: npm install -g solc');
        console.error('   2. Compile: node scripts/compile-evm-htlc.js');
        console.error('');
        process.exit(1);
    }

    const { abi, bytecode } = JSON.parse(fs.readFileSync(bytecodePath, 'utf8'));

    console.log('📦 Deployando contrato...');
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    const contract = await factory.deploy();
    const receipt = await contract.deploymentTransaction().wait();

    const contractAddress = await contract.getAddress();

    console.log('');
    console.log('✅ Contrato deployado!');
    console.log(`   Address: ${contractAddress}`);
    console.log(`   Tx:      ${receipt.hash}`);
    console.log(`   Block:   ${receipt.blockNumber}`);
    console.log('');

    const explorerBase = cfg.explorer[networkName] || cfg.explorer.mainnet;
    console.log(`🔍 Explorer: ${explorerBase}/address/${contractAddress}`);
    console.log('');

    console.log('Cole no .env:');
    console.log('────────────────────────────────────────');
    console.log(`${cfg.envKey}_HTLC_CONTRACT=${contractAddress}`);
    console.log('────────────────────────────────────────');
}

main().catch(e => {
    console.error('❌ Erro:', e);
    process.exit(1);
});
