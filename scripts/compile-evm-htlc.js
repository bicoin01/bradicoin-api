// scripts/compile-evm-htlc.js
// ============================================
// Compila evmHTLC.sol → ABI + bytecode
// ============================================
// Uso: node scripts/compile-evm-htlc.js
// ============================================

const fs = require('fs');
const path = require('path');
const solc = require('solc');

function findImports(importPath) {
    try {
        const fullPath = path.resolve(__dirname, '..', 'node_modules', importPath);
        return { contents: fs.readFileSync(fullPath, 'utf8') };
    } catch (e) {
        return { error: 'File not found: ' + importPath };
    }
}

function main() {
    const contractPath = path.join(__dirname, '..', 'atomic-swap', 'contracts', 'evmHTLC.sol');
    const source = fs.readFileSync(contractPath, 'utf8');

    console.log('🔨 Compilando evmHTLC.sol...');

    const input = {
        language: 'Solidity',
        sources: {
            'evmHTLC.sol': { content: source }
        },
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            },
            outputSelection: {
                '*': {
                    '*': ['abi', 'evm.bytecode.object']
                }
            }
        }
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

    // Erros
    if (output.errors) {
        const errors = output.errors.filter(e => e.severity === 'error');
        if (errors.length > 0) {
            console.error('❌ Erros de compilação:');
            errors.forEach(e => console.error(e.formattedMessage));
            process.exit(1);
        }
        const warnings = output.errors.filter(e => e.severity === 'warning');
        warnings.forEach(w => console.warn('⚠️  ' + w.formattedMessage));
    }

    const contract = output.contracts['evmHTLC.sol']['BradicoinHTLC'];
    const abi = contract.abi;
    const bytecode = '0x' + contract.evm.bytecode.object;

    // Salva
    const abiPath = path.join(__dirname, '..', 'atomic-swap', 'contracts', 'evmHTLC.abi.json');
    const bytecodePath = path.join(__dirname, '..', 'atomic-swap', 'contracts', 'evmHTLC.bytecode.json');

    fs.writeFileSync(abiPath, JSON.stringify(abi, null, 2));
    fs.writeFileSync(bytecodePath, JSON.stringify({ abi, bytecode }, null, 2));

    console.log('');
    console.log('✅ Compilado!');
    console.log(`   ABI:      ${abiPath}`);
    console.log(`   Bytecode: ${bytecodePath}`);
    console.log('');
    console.log('Agora rode:');
    console.log(`   node scripts/deploy-evm-htlc.js ethereum`);
}

main();
