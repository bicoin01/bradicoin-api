// models/User.js
// ============================================
// Schema do Usuário - Bradicoin
// ============================================

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
    {
        email: {
            type: String,
            required: [true, 'Email é obrigatório'],
            unique: true,
            lowercase: true,
            trim: true,
            match: [/^\S+@\S+\.\S+$/, 'Email inválido']
        },

        password: {
            type: String,
            required: [true, 'Senha é obrigatória'],
            minlength: [6, 'Senha deve ter no mínimo 6 caracteres'],
            select: false
        },

        username: {
            type: String,
            required: [true, 'Username é obrigatório'],
            unique: true,
            trim: true,
            minlength: [3, 'Username deve ter no mínimo 3 caracteres'],
            maxlength: [30, 'Username deve ter no máximo 30 caracteres']
        },

        walletAddress: {
            type: String,
            default: null,
            index: true
        },

        status: {
            type: String,
            enum: ['active', 'suspended', 'deleted'],
            default: 'active'
        },

        role: {
            type: String,
            enum: ['user', 'admin', 'validator'],
            default: 'user'
        },

        lastLogin: {
            type: Date,
            default: null
        },

        metadata: {
            userAgent: String,
            ip: String,
            country: String
        },

        twoFactorEnabled: {
            type: Boolean,
            default: false
        },

        twoFactorSecret: {
            type: String,
            default: null,
            select: false
        }
    },
    {
        timestamps: true,
        toJSON: {
            transform(doc, ret) {
                delete ret.password;
                delete ret.twoFactorSecret;
                delete ret.__v;
                return ret;
            }
        }
    }
);

// ============================================
// HOOKS
// ============================================

// Antes de salvar: hashear senha
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();

    try {
        const salt = await bcrypt.genSalt(12);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// ============================================
// MÉTODOS
// ============================================

// Comparar senha
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Retornar dados públicos (sem senha)
userSchema.methods.toPublic = function () {
    return {
        id: this._id,
        email: this.email,
        username: this.username,
        walletAddress: this.walletAddress,
        role: this.role,
        status: this.status,
        createdAt: this.createdAt,
        lastLogin: this.lastLogin
    };
};

// ============================================
// ÍNDICES
// ============================================

userSchema.index({ email: 1 });
userSchema.index({ username: 1 });
userSchema.index({ walletAddress: 1 });

module.exports = mongoose.model('User', userSchema);
