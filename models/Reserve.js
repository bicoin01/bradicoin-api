// models/Reserve.js
// ============================================
// Fundo de Reserva - Bradicoin (v2.0)
// ============================================

const mongoose = require('mongoose');
const { Decimal128 } = mongoose.Schema.Types;

// 🔴 CRÍTICO: falhar se não configurado (não usar fallback hardcoded)
const RESERVE_ADDRESS = process.env.RESERVE_ADDRESS;
if (!RESERVE_ADDRESS) {
    throw new Error('❌ RESERVE_ADDRESS não configurado no .env');
}

if (!/^Br[a-fA-F0-9]{38}$/.test(RESERVE_ADDRESS)) {
    throw new Error('❌ RESERVE_ADDRESS inválido (deve ser Br + 38 hex)');
}

// Supply máximo fixo (nunca ultrapassa)
// ⚠️ Defina no .env: MAX_SUPPLY=1000000000 (1 bilhão)
const MAX_SUPPLY_STR = process.env.MAX_SUPPLY || '1000000000';
const MAX_SUPPLY = Decimal128.fromString(MAX_SUPPLY_STR);

// Saldo inicial (opcional, para seed inicial)
const INITIAL_BALANCE_STR = process.env.RESERVE_INITIAL_BALANCE || '0';
const INITIAL_BALANCE = Decimal128.fromString(INITIAL_BALANCE_STR);

// ============================================
// SCHEMA
// ============================================

const reserveSchema = new mongoose.Schema(
    {
        address: {
            type: String,
            required: true,
            unique: true,
            default: RESERVE_ADDRESS,
            validate: {
                validator: function (v) {
                    return /^Br[a-fA-F0-9]{38}$/.test(v);
                },
                message: 'Endereço do Reserve inválido'
            }
        },

        // ============================================
        // 💰 SALDOS
        // ============================================
        // Saldo atual (disponível para distribuir)
        balance: {
            type: Decimal128,
            default: () => Decimal128.fromString('0'),
            required: true
        },

        // Total já emitido (nunca diminui, só aumenta até MAX_SUPPLY)
        totalSupply: {
            type: Decimal128,
            default: () => Decimal128.fromString('0'),
            required: true
        },

        // Supply máximo (imutável)
        maxSupply: {
            type: Decimal128,
            default: () => MAX_SUPPLY,
            required: true
        },

        // ============================================
        // 📊 ESTATÍSTICAS ACUMULADAS
        // ============================================
        totalMinted: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        totalBurned: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        totalRewardsPaid: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        totalAirdropsPaid: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        totalStakesReceived: {
            type: Decimal128,
            default: () => Decimal128.fromString('0')
        },

        // ============================================
        // 🚦 CONTROLE
        // ============================================
        // ❌ REMOVIDO 'autoReplenish' (causava inflação infinita)
        // Agora, mint só com autorização explícita de admin

        // Se true, ninguém pode mintar (modo lockdown)
        mintingLocked: {
            type: Boolean,
            default: false
        },

        lastActivity: {
            type: Date,
            default: Date.now
        }
    },
    {
        timestamps: true,

        toJSON: {
            transform(doc, ret) {
                delete ret.__v;
                if (ret.balance) ret.balance = ret.balance.toString();
                if (ret.totalSupply) ret.totalSupply = ret.totalSupply.toString();
                if (ret.maxSupply) ret.maxSupply = ret.maxSupply.toString();
                if (ret.totalMinted) ret.totalMinted = ret.totalMinted.toString();
                if (ret.totalBurned) ret.totalBurned = ret.totalBurned.toString();
                if (ret.totalRewardsPaid) ret.totalRewardsPaid = ret.totalRewardsPaid.toString();
                if (ret.totalAirdropsPaid) ret.totalAirdropsPaid = ret.totalAirdropsPaid.toString();
                if (ret.totalStakesReceived) ret.totalStakesReceived = ret.totalStakesReceived.toString();
                return ret;
            }
        },

        toObject: {
            transform(doc, ret) {
                delete ret.__v;
                if (ret.balance) ret.balance = ret.balance.toString();
                if (ret.totalSupply) ret.totalSupply = ret.totalSupply.toString();
                if (ret.maxSupply) ret.maxSupply = ret.maxSupply.toString();
                if (ret.totalMinted) ret.totalMinted = ret.totalMinted.toString();
                if (ret.totalBurned) ret.totalBurned = ret.totalBurned.toString();
                if (ret.totalRewardsPaid) ret.totalRewardsPaid = ret.totalRewardsPaid.toString();
                if (ret.totalAirdropsPaid) ret.totalAirdropsPaid = ret.totalAirdropsPaid.toString();
                if (ret.totalStakesReceived) ret.totalStakesReceived = ret.totalStakesReceived.toString();
                return ret;
            }
        }
    }
);

// ============================================
// MÉTODOS DE INSTÂNCIA
// ============================================

reserveSchema.methods.toPublic = function () {
    return {
        address: this.address,
        balance: this.balance.toString(),
        totalSupply: this.totalSupply.toString(),
        maxSupply: this.maxSupply.toString(),
        totalMinted: this.totalMinted.toString(),
        totalBurned: this.totalBurned.toString(),
        totalRewardsPaid: this.totalRewardsPaid.toString(),
        totalAirdropsPaid: this.totalAirdropsPaid.toString(),
        totalStakesReceived: this.totalStakesReceived.toString(),
        mintingLocked: this.mintingLocked,
        lastActivity: this.lastActivity,
        createdAt: this.createdAt
    };
};

// Retorna saldo como number (para cálculos)
reserveSchema.methods.getBalanceNumber = function () {
    return parseFloat(this.balance.toString());
};

// Verifica se pode mintar mais
reserveSchema.methods.canMint = function (amountStr) {
    const amount = Decimal128.fromString(amountStr.toString());
    const newTotal = Decimal128.fromString(
        (parseFloat(this.totalSupply.toString()) + parseFloat(amountStr)).toString()
    );
    return (
        !this.mintingLocked &&
        parseFloat(newTotal.toString()) <= parseFloat(this.maxSupply.toString())
    );
};

// ============================================
// MÉTODOS ESTÁTICOS
// ============================================

// Pega (ou cria) o documento único do fundo
reserveSchema.statics.getReserve = async function () {
    let reserve = await this.findOne({ address: RESERVE_ADDRESS });

    if (!reserve) {
        reserve = await this.create({
            address: RESERVE_ADDRESS,
            balance: INITIAL_BALANCE,
            totalSupply: INITIAL_BALANCE,
            maxSupply: MAX_SUPPLY
        });
        console.log('🏦 Fundo de Reserva criado:', RESERVE_ADDRESS);
        console.log('💰 Saldo inicial:', INITIAL_BALANCE.toString(), 'BRD');
        console.log('📊 Max supply:', MAX_SUPPLY.toString(), 'BRD');
    }

    return reserve;
};

// ============================================
// MINT (cunhar novos tokens)
// ============================================
// 🔐 Só admin pode chamar. Respeita MAX_SUPPLY.
reserveSchema.statics.mint = async function (amountStr, adminId) {
    if (!adminId) {
        throw new Error('adminId obrigatório');
    }

    const amountNum = parseFloat(amountStr);
    if (isNaN(amountNum) || amountNum <= 0) {
        throw new Error('Valor deve ser positivo');
    }

    const amount = Decimal128.fromString(amountStr.toString());

    // Busca reserve primeiro para checar
    const reserve = await this.getReserve();

    if (reserve.mintingLocked) {
        throw new Error('Minting está bloqueado');
    }

    const currentSupply = parseFloat(reserve.totalSupply.toString());
    const maxSupply = parseFloat(reserve.maxSupply.toString());

    if (currentSupply + amountNum > maxSupply) {
        throw new Error(
            `Supply máximo excedido: ${currentSupply + amountNum} > ${maxSupply}`
        );
    }

    // 🔐 Atomic update
    const updated = await this.findOneAndUpdate(
        {
            address: RESERVE_ADDRESS,
            mintingLocked: false
        },
        {
            $inc: {
                balance: amount,
                totalSupply: amount,
                totalMinted: amount
            },
            $set: { lastActivity: new Date() }
        },
        { new: true }
    );

    if (!updated) {
        throw new Error('Falha ao mintar (reserve não encontrado ou bloqueado)');
    }

    console.log(`🪙 Minted ${amountStr} BRD por admin ${adminId}`);
    return updated;
};

// ============================================
// DEBIT (gastar do fundo — para rewards, airdrops)
// ============================================
reserveSchema.statics.debit = async function (amountStr, reason = 'unknown') {
    const amountNum = parseFloat(amountStr);
    if (isNaN(amountNum) || amountNum <= 0) {
        throw new Error('Valor deve ser positivo');
    }

    const amount = Decimal128.fromString(amountStr.toString());
    const negativeAmount = Decimal128.fromString(`-${amountStr}`);

    // 🔐 Atomic: só debita se tiver saldo
    const incObj = {
        balance: negativeAmount
    };

    if (reason === 'reward') {
        incObj.totalRewardsPaid = amount;
    } else if (reason === 'airdrop') {
        incObj.totalAirdropsPaid = amount;
    }

    const reserve = await this.findOneAndUpdate(
        {
            address: RESERVE_ADDRESS,
            balance: { $gte: amount }
        },
        {
            $inc: incObj,
            $set: { lastActivity: new Date() }
        },
        { new: true }
    );

    if (!reserve) {
        throw new Error('Fundo de Reserva sem saldo suficiente');
    }

    return reserve;
};

// ============================================
// BURN (queimar tokens)
// ============================================
reserveSchema.statics.burn = async function (amountStr) {
    const amountNum = parseFloat(amountStr);
    if (isNaN(amountNum) || amountNum <= 0) {
        throw new Error('Valor deve ser positivo');
    }

    const amount = Decimal128.fromString(amountStr.toString());
    const negativeAmount = Decimal128.fromString(`-${amountStr}`);

    const reserve = await this.findOneAndUpdate(
        {
            address: RESERVE_ADDRESS,
            balance: { $gte: amount }
        },
        {
            $inc: {
                balance: negativeAmount,
                totalBurned: amount,
                totalSupply: negativeAmount  // supply diminui
            },
            $set: { lastActivity: new Date() }
        },
        { new: true }
    );

    if (!reserve) {
        throw new Error('Saldo insuficiente para queimar');
    }

    console.log(`🔥 Burned ${amountStr} BRD`);
    return reserve;
};

// ============================================
// RECEBER STAKE (quando usuário faz stake)
// ============================================
reserveSchema.statics.receiveStake = async function (amountStr) {
    const amount = Decimal128.fromString(amountStr.toString());

    const reserve = await this.findOneAndUpdate(
        { address: RESERVE_ADDRESS },
        {
            $inc: {
                balance: amount,
                totalStakesReceived: amount
            },
            $set: { lastActivity: new Date() }
        },
        { new: true }
    );

    if (!reserve) {
        throw new Error('Reserve não encontrado');
    }

    return reserve;
};

// ============================================
// GET INFO
// ============================================
reserveSchema.statics.getInfo = async function () {
    const reserve = await this.getReserve();

    const currentSupply = parseFloat(reserve.totalSupply.toString());
    const maxSupply = parseFloat(reserve.maxSupply.toString());

    return {
        address: reserve.address,
        balance: reserve.balance.toString(),
        totalSupply: reserve.totalSupply.toString(),
        maxSupply: reserve.maxSupply.toString(),
        circulatingSupplyPercent: ((currentSupply / maxSupply) * 100).toFixed(2) + '%',
        totalMinted: reserve.totalMinted.toString(),
        totalBurned: reserve.totalBurned.toString(),
        totalRewardsPaid: reserve.totalRewardsPaid.toString(),
        totalAirdropsPaid: reserve.totalAirdropsPaid.toString(),
        totalStakesReceived: reserve.totalStakesReceived.toString(),
        mintingLocked: reserve.mintingLocked,
        lastActivity: reserve.lastActivity
    };
};

// ============================================
// TOGGLE MINTING
// ============================================
reserveSchema.statics.toggleMinting = async function (locked, adminId) {
    if (!adminId) {
        throw new Error('adminId obrigatório');
    }

    const reserve = await this.findOneAndUpdate(
        { address: RESERVE_ADDRESS },
        {
            $set: {
                mintingLocked: locked,
                lastActivity: new Date()
            }
        },
        { new: true }
    );

    console.log(`🔒 Minting ${locked ? 'BLOQUEADO' : 'LIBERADO'} por admin ${adminId}`);
    return reserve;
};

// ============================================
// ÍNDICES
// ============================================
reserveSchema.index({ address: 1 }, { unique: true });

// ============================================
// EXPORTS
// ============================================
const ReserveModel = mongoose.model('Reserve', reserveSchema);

module.exports = {
    ReserveModel,
    RESERVE_ADDRESS,
    MAX_SUPPLY,
    INITIAL_BALANCE
};
