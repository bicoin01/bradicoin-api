// models/User.js
// ============================================
// Schema do Usuário - Bradicoin (v2.0)
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
            maxlength: [254, 'Email muito longo'],
            match: [/^\S+@\S+\.\S+$/, 'Email inválido']
        },

        password: {
            type: String,
            required: [true, 'Senha é obrigatória'],
            minlength: [10, 'Senha deve ter no mínimo 10 caracteres'],
            validate: {
                validator: function (v) {
                    // Pelo menos 1 letra e 1 número
                    return /[a-zA-Z]/.test(v) && /\d/.test(v);
                },
                message: 'Senha deve conter pelo menos uma letra e um número'
            },
            select: false
        },

        username: {
            type: String,
            required: [true, 'Username é obrigatório'],
            unique: true,
            trim: true,
            lowercase: true,
            minlength: [3, 'Username deve ter no mínimo 3 caracteres'],
            maxlength: [30, 'Username deve ter no máximo 30 caracteres'],
            match: [/^[a-zA-Z0-9_]+$/, 'Username só pode ter letras, números e _']
        },

        walletAddress: {
            type: String,
            default: null,
            index: true,
            sparse: true, // permite vários null
            validate: {
                validator: function (v) {
                    if (v === null || v === undefined) return true;
                    return /^Br[a-fA-F0-9]{38}$/.test(v);
                },
                message: 'Endereço de carteira inválido'
            }
        },

        status: {
            type: String,
            enum: ['active', 'suspended', 'deleted'],
            default: 'active',
            index: true
        },

        role: {
            type: String,
            enum: ['user', 'admin', 'validator'],
            default: 'user',
            index: true
        },

        // ============================================
        // 🔐 SEGURANÇA — CAMPOS CRÍTICOS
        // ============================================

        // Usado para invalidar todos os JWT do usuário (logout real)
        tokenVersion: {
            type: Number,
            default: 0,
            select: false
        },

        // Última troca de senha (invalidar tokens antigos)
        lastPasswordChange: {
            type: Date,
            default: Date.now,
            select: false
        },

        // Brute-force protection
        failedLoginAttempts: {
            type: Number,
            default: 0,
            select: false
        },

        lockedUntil: {
            type: Date,
            default: null,
            select: false
        },

        // ============================================
        // 📊 METADADOS
        // ============================================

        lastLogin: {
            type: Date,
            default: null
        },

        metadata: {
            userAgent: { type: String, maxlength: 500 },
            ip: { type: String, maxlength: 45 }, // IPv6
            country: { type: String, maxlength: 2 }
        },

        // ============================================
        // 🔐 2FA
        // ============================================

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

        // Remove campos sensíveis ao converter para JSON
        toJSON: {
            transform(doc, ret) {
                delete ret.password;
                delete ret.twoFactorSecret;
                delete ret.tokenVersion;
                delete ret.lastPasswordChange;
                delete ret.failedLoginAttempts;
                delete ret.lockedUntil;
                delete ret.__v;
                return ret;
            }
        },

        // Remove campos sensíveis ao converter para Object (mesma coisa)
        toObject: {
            transform(doc, ret) {
                delete ret.password;
                delete ret.twoFactorSecret;
                delete ret.tokenVersion;
                delete ret.lastPasswordChange;
                delete ret.failedLoginAttempts;
                delete ret.lockedUntil;
                delete ret.__v;
                return ret;
            }
        }
    }
);

// ============================================
// HOOKS
// ============================================

// Hash da senha antes de salvar
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();

    try {
        const salt = await bcrypt.genSalt(12);
        this.password = await bcrypt.hash(this.password, salt);
        this.lastPasswordChange = new Date();
        next();
    } catch (error) {
        next(error);
    }
});

// ============================================
// MÉTODOS DE INSTÂNCIA
// ============================================

// Compara senha
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Verifica se conta está bloqueada por brute-force
userSchema.methods.isLocked = function () {
    return this.lockedUntil && this.lockedUntil > Date.now();
};

// Registra tentativa falhada (bloqueia após 5)
userSchema.methods.registerFailedLogin = async function () {
    this.failedLoginAttempts = (this.failedLoginAttempts || 0) + 1;

    if (this.failedLoginAttempts >= 5) {
        // Bloqueia por 15 minutos
        this.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    }

    await this.save();
};

// Reseta tentativas após login bem-sucedido
userSchema.methods.resetFailedLogins = async function () {
    this.failedLoginAttempts = 0;
    this.lockedUntil = null;
    this.lastLogin = new Date();
    await this.save();
};

// Incrementa tokenVersion (invalida todos os JWT)
userSchema.methods.revokeAllTokens = async function () {
    this.tokenVersion = (this.tokenVersion || 0) + 1;
    await this.save();
    return this.tokenVersion;
};

// Retorna dados públicos
userSchema.methods.toPublic = function () {
    return {
        id: this._id,
        email: this.email,
        username: this.username,
        walletAddress: this.walletAddress,
        role: this.role,
        status: this.status,
        twoFactorEnabled: this.twoFactorEnabled,
        createdAt: this.createdAt,
        lastLogin: this.lastLogin
    };
};

// ============================================
// ÍNDICES
// ============================================

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ walletAddress: 1 }, { sparse: true });
userSchema.index({ status: 1 });
userSchema.index({ role: 1 });

module.exports = mongoose.model('User', userSchema);
