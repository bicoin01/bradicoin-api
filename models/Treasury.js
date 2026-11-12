// models/Treasury.js
// ============================================
// Controle contábil da tesouraria BRD
// ============================================
// Reserva de 5.000.000.000 BRD (= US$ 50 bi a US$ 10/BRD)
// Decrementa a cada compra confirmada.
// O crédito real é feito via blockchain.addTransaction
// (fromAddress=null) e o saldo do usuário é atualizado pelo
// próprio Blockchain.applyTransactions.
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

const treasurySchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: 'brd_main'
        },

        // Saldo disponível para venda (decrementa a cada compra)
        balance: {
            type: Decimal128,
            required: true,
            default: () => Decimal128.fromString('0')
        },

        // Saldo inicial (auditoria)
        initialBalance: {
            type: Decimal128,
            required: true,
            default: () => Decimal128.fromString('0')
        },

        totalSold: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        totalCredited: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        lowBalanceAlertAt: {
            type: Date,
            default: null
        },
        lowBalanceThreshold: {
            type: Decimal128,
            default: () => Decimal128.fromString('1000000') // 1M BRD
        },

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        }
    },
    {
        timestamps: true,
        toJSON: {
            transform(doc, ret) {
                delete ret.__v;
                if (ret.balance) ret.balance = ret.balance.toString();
                if (ret.initialBalance) ret.initialBalance = ret.initialBalance.toString();
                if (ret.totalSold) ret.totalSold = ret.totalSold.toString();
                if (ret.totalCredited) ret.totalCredited = ret.totalCredited.toString();
                if (ret.lowBalanceThreshold) ret.lowBalanceThreshold = ret.lowBalanceThreshold.toString();
                return ret;
            }
        }
    }
);

// ============================================
// MÉTODOS ESTÁTICOS
// ============================================
treasurySchema.statics.getMain = async function () {
    let doc = await this.findOne({ key: 'brd_main' });
    if (!doc) {
        doc = await this.create({
            key: 'brd_main',
            balance: Decimal128.fromString('0'),
            initialBalance: Decimal128.fromString('0')
        });
    }
    return doc;
};

// Debita da tesouraria de forma ATÔMICA
treasurySchema.statics.debit = async function (amountStr) {
    const amount = Decimal128.fromString(amountStr.toString());

    const updated = await this.findOneAndUpdate(
        {
            key: 'brd_main',
            $expr: {
                $gte: [{ $toDecimal: '$balance' }, { $toDecimal: amount }]
            }
        },
        {
            $inc: {
                balance: `-${amountStr}`,
                totalSold: amountStr
            }
        },
        { new: true }
    );

    if (!updated) {
        const exists = await this.findOne({ key: 'brd_main' });
        if (!exists) {
            throw new Error('Tesouraria não inicializada. Rode: node scripts/seedTreasury.js');
        }
        throw new Error(`Saldo insuficiente na tesouraria (necessário: ${amountStr})`);
    }

    const currentBalance = parseFloat(updated.balance.toString());
    const threshold = parseFloat(updated.lowBalanceThreshold?.toString() || '0');
    if (threshold > 0 && currentBalance < threshold && !updated.lowBalanceAlertAt) {
        updated.lowBalanceAlertAt = new Date();
        await updated.save();
        console.warn(
            `⚠️ [Treasury] Saldo baixo: ${currentBalance.toFixed(8)} BRD (threshold: ${threshold})`
        );
    }

    return updated;
};

treasurySchema.statics.markCredited = async function (amountStr) {
    return this.findOneAndUpdate(
        { key: 'brd_main' },
        { $inc: { totalCredited: amountStr } },
        { new: true }
    );
};

const Treasury = mongoose.model('Treasury', treasurySchema);

module.exports = Treasury;
