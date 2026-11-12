// scripts/seedTreasury.js
// ============================================
// Inicializa a tesouraria BRD com 5.000.000.000 BRD
// ============================================
// VALOR: 5.000.000.000 BRD (= US$ 50 bilhões a US$ 10/BRD)
//
// USO:
//   node scripts/seedTreasury.js
//
// É IDEMPOTENTE: se já existir, não duplica.
// ============================================

require('dotenv').config();
const mongoose = require('mongoose');
const Decimal128 = mongoose.Types.Decimal128;

const Treasury = require('../models/Treasury');

// ⚠️ 5 BILHÕES de BRD = US$ 50 bilhões (a US$ 10/BRD)
const INITIAL_TREASURY = '5000000000';

async function main() {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('❌ MONGODB_URI / MONGO_URI não configurado no .env');
        process.exit(1);
    }

    console.log('🔌 Conectando ao MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Conectado');

    try {
        const existing = await Treasury.findOne({ key: 'brd_main' });

        if (existing) {
            const bal = existing.balance.toString();
            console.log(`ℹ️  Tesouraria já existe. Saldo atual: ${bal} BRD`);
            console.log(`    Initial:   ${existing.initialBalance.toString()} BRD`);
            console.log(`    Vendido:   ${existing.totalSold.toString()} BRD`);
            console.log(`    Creditado: ${existing.totalCredited.toString()} BRD`);

            if (parseFloat(bal) === 0 && parseFloat(existing.initialBalance.toString()) === 0) {
                console.log(`⚙️  Atualizando saldo inicial para ${INITIAL_TREASURY} BRD...`);
                existing.balance = Decimal128.fromString(INITIAL_TREASURY);
                existing.initialBalance = Decimal128.fromString(INITIAL_TREASURY);
                await existing.save();
                console.log('✅ Saldo atualizado!');
            } else {
                console.log('ℹ️  Nada a fazer (não sobrescrevo saldo existente).');
            }
        } else {
            console.log(`🌱 Criando tesouraria com ${INITIAL_TREASURY} BRD...`);
            const created = await Treasury.create({
                key: 'brd_main',
                balance: Decimal128.fromString(INITIAL_TREASURY),
                initialBalance: Decimal128.fromString(INITIAL_TREASURY),
                totalSold: Decimal128.fromString('0'),
                totalCredited: Decimal128.fromString('0'),
                lowBalanceThreshold: Decimal128.fromString('1000000'),
                metadata: {
                    seededAt: new Date().toISOString(),
                    seededBy: 'scripts/seedTreasury.js',
                    brdPriceUsd: 10,
                    totalValueUsd: 50000000000
                }
            });
            console.log('✅ Tesouraria criada!');
            console.log(`   ID:    ${created._id}`);
            console.log(`   Saldo: ${created.balance.toString()} BRD`);
        }

        const final = await Treasury.findOne({ key: 'brd_main' });
        const balNum = parseFloat(final.balance.toString());
        console.log('\n📊 ESTADO FINAL DA TESOURARIA:');
        console.log(`   Saldo disponível: ${final.balance.toString()} BRD`);
        console.log(`   Valor em USD:     US$ ${(balNum * 10).toLocaleString('en-US')}`);
        console.log(`   Total vendido:    ${final.totalSold.toString()} BRD`);
        console.log(`   Total creditado:  ${final.totalCredited.toString()} BRD`);
    } catch (err) {
        console.error('❌ Erro:', err.message);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Desconectado');
    }
}

main();
