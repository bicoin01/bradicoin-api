// routes/auth.js
// ============================================
// Rotas de autenticação - Bradicoin (v2.1)
// ============================================
// 🆕 v2.1 — LIMITE RÍGIDO DE 2 CONTAS (uso pessoal)
// ============================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

const User = require('../models/User');
const WalletModel = require('../models/Wallet');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');

// ============================================
// CONSTANTES
// ============================================
const MAX_ACCOUNTS = 2;   // 🚨 limite rígido

// ============================================
// RATE LIMITERS
// ============================================

// Login: 5 tentativas a cada 15 min (por IP)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    message: {
        success: false,
        error: 'Muitas tentativas de login. Tente novamente em 15 minutos.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Register: 🆕 agora limitado a 2/hora (era 3)
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: MAX_ACCOUNTS,
    message: {
        success: false,
        error: `Limite de ${MAX_ACCOUNTS} contas atingido nesta hora.`
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Forgot password: 3 tentativas por hora
const forgotLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    message: {
        success: false,
        error: 'Muitas solicitações. Tente novamente em 1 hora.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// ============================================
// HELPERS
// ============================================

function generateToken(user) {
    return jwt.sign(
        {
            id: user._id,
            v: user.tokenVersion || 0
        },
        process.env.JWT_SECRET,
        {
            expiresIn: process.env.JWT_EXPIRES_IN || '7d',
            issuer: 'bradicoin-api',
            audience: 'bradicoin-clients'
        }
    );
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUsername(username) {
    return /^[a-zA-Z0-9_]{3,30}$/.test(username);
}

function validatePassword(password) {
    if (typeof password !== 'string') return { ok: false, msg: 'Senha inválida' };
    if (password.length < 10) return { ok: false, msg: 'Senha deve ter no mínimo 10 caracteres' };
    if (!/[a-zA-Z]/.test(password)) return { ok: false, msg: 'Senha deve ter pelo menos uma letra' };
    if (!/\d/.test(password)) return { ok: false, msg: 'Senha deve ter pelo menos um número' };
    if (password.length > 200) return { ok: false, msg: 'Senha muito longa' };
    return { ok: true };
}

function errorRes(res, status, message) {
    return res.status(status).json({ success: false, error: message });
}

// ============================================
// GET /api/v1/auth/can-register
// ============================================
// 🆕 Retorna se ainda dá pra criar conta (pra UI mostrar/esconder botão)
//
router.get(
    '/can-register',
    asyncHandler(async (req, res) => {
        const count = await User.countDocuments({ status: { $ne: 'deleted' } });
        res.json({
            success: true,
            data: {
                canRegister: count < MAX_ACCOUNTS,
                currentCount: count,
                maxAccounts: MAX_ACCOUNTS,
                remaining: Math.max(0, MAX_ACCOUNTS - count)
            }
        });
    })
);

// ============================================
// POST /api/v1/auth/register
// ============================================
router.post(
    '/register',
    registerLimiter,
    asyncHandler(async (req, res) => {
        const { email, password, username } = req.body;

        // 1. Campos obrigatórios
        if (!email || !password || !username) {
            return errorRes(res, 400, 'Email, senha e username são obrigatórios');
        }

        // 2. Validações
        if (!validateEmail(email)) {
            return errorRes(res, 400, 'Email inválido');
        }

        if (!validateUsername(username)) {
            return errorRes(res, 400, 'Username deve ter 3-30 caracteres (letras, números, _)');
        }

        const pwdCheck = validatePassword(password);
        if (!pwdCheck.ok) {
            return errorRes(res, 400, pwdCheck.msg);
        }

        // ============================================
        // 🚨 3. LIMITE RÍGIDO DE 2 CONTAS
        // ============================================
        const currentCount = await User.countDocuments({ status: { $ne: 'deleted' } });

        if (currentCount >= MAX_ACCOUNTS) {
            return errorRes(
                res,
                403,
                `Limite de ${MAX_ACCOUNTS} contas atingido. Este sistema é de uso pessoal.`
            );
        }

        // 4. Verifica se já existe
        const existing = await User.findOne({
            $or: [
                { email: email.toLowerCase() },
                { username: username.toLowerCase() }
            ]
        });

        if (existing) {
            const field = existing.email === email.toLowerCase() ? 'Email' : 'Username';
            return errorRes(res, 409, `${field} já está em uso`);
        }

        // 5. Cria usuário
        const user = await User.create({
            email: email.toLowerCase(),
            password,
            username: username.toLowerCase(),
            status: 'active',
            role: 'user',
            tokenVersion: 0,
            emailVerified: false,
            metadata: {
                userAgent: (req.headers['user-agent'] || '').substring(0, 500),
                ip: req.ip
            }
        });

        // 6. Gera token
        const token = generateToken(user);

        // 7. Retorna
        res.status(201).json({
            success: true,
            message: `Conta criada com sucesso (${currentCount + 1}/${MAX_ACCOUNTS})`,
            data: {
                user: user.toPublic(),
                token,
                expiresIn: process.env.JWT_EXPIRES_IN || '7d',
                accountCount: currentCount + 1,
                maxAccounts: MAX_ACCOUNTS
            }
        });
    })
);

// ============================================
// POST /api/v1/auth/login
// ============================================
router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
        const { email, password, twoFACode } = req.body;

        if (!email || !password) {
            return errorRes(res, 400, 'Email e senha são obrigatórios');
        }

        const user = await User.findOne({ email: email.toLowerCase() })
            .select('+password +failedLoginAttempts +lockedUntil +tokenVersion +twoFactorSecret');

        if (!user) {
            return errorRes(res, 401, 'Email ou senha incorretos');
        }

        if (user.isLocked()) {
            const minutesLeft = Math.ceil((user.lockedUntil - Date.now()) / 60000);
            return errorRes(res, 429, `Conta bloqueada. Tente novamente em ${minutesLeft} minutos.`);
        }

        if (user.status !== 'active') {
            return errorRes(res, 403, 'Conta suspensa ou inativa');
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            await user.registerFailedLogin();
            return errorRes(res, 401, 'Email ou senha incorretos');
        }

        // 2FA
        if (user.twoFactorEnabled && user.twoFactorSecret) {
            if (!twoFACode) {
                return res.status(200).json({
                    success: false,
                    requires2FA: true,
                    error: 'Código 2FA obrigatório'
                });
            }

            const verified = speakeasy.totp.verify({
                secret: user.twoFactorSecret,
                encoding: 'base32',
                token: twoFACode,
                window: 1
            });

            if (!verified) {
                await user.registerFailedLogin();
                return errorRes(res, 401, 'Código 2FA inválido');
            }
        }

        await user.resetFailedLogins();

        const token = generateToken(user);

        res.json({
            success: true,
            message: 'Login realizado com sucesso',
            data: {
                user: user.toPublic(),
                token,
                expiresIn: process.env.JWT_EXPIRES_IN || '7d'
            }
        });
    })
);

// ============================================
// GET /api/v1/auth/me
// ============================================
router.get(
    '/me',
    authenticate,
    asyncHandler(async (req, res) => {
        res.json({
            success: true,
            data: {
                user: req.user.toPublic()
            }
        });
    })
);

// ============================================
// POST /api/v1/auth/logout
// ============================================
router.post(
    '/logout',
    authenticate,
    asyncHandler(async (req, res) => {
        await req.user.revokeAllTokens();

        res.json({
            success: true,
            message: 'Logout realizado com sucesso'
        });
    })
);

// ============================================
// PUT /api/v1/auth/change-password
// ============================================
router.put(
    '/change-password',
    authenticate,
    asyncHandler(async (req, res) => {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return errorRes(res, 400, 'Senha atual e nova senha são obrigatórias');
        }

        const pwdCheck = validatePassword(newPassword);
        if (!pwdCheck.ok) {
            return errorRes(res, 400, pwdCheck.msg);
        }

        const user = await User.findById(req.userId).select('+password +tokenVersion');

        if (!user) {
            return errorRes(res, 404, 'Usuário não encontrado');
        }

        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            return errorRes(res, 401, 'Senha atual incorreta');
        }

        if (currentPassword === newPassword) {
            return errorRes(res, 400, 'Nova senha deve ser diferente da atual');
        }

        user.password = newPassword;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();

        const newToken = generateToken(user);

        res.json({
            success: true,
            message: 'Senha alterada com sucesso. Todos os outros dispositivos foram desconectados.',
            data: {
                token: newToken
            }
        });
    })
);

// ============================================
// POST /api/v1/auth/forgot-password
// ============================================
router.post(
    '/forgot-password',
    forgotLimiter,
    asyncHandler(async (req, res) => {
        const { email } = req.body;

        if (!email) {
            return errorRes(res, 400, 'Email é obrigatório');
        }

        const user = await User.findOne({ email: email.toLowerCase() });

        const response = {
            success: true,
            message: 'Se o email estiver cadastrado, você receberá instruções para redefinir a senha.'
        };

        if (!user) {
            return res.json(response);
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

        user.resetPasswordToken = resetTokenHash;
        user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
        await user.save();

        if (process.env.NODE_ENV !== 'production') {
            console.log(`🔑 Reset token para ${email}: ${resetToken}`);
            response.devResetToken = resetToken;
        }

        res.json(response);
    })
);

// ============================================
// POST /api/v1/auth/reset-password
// ============================================
router.post(
    '/reset-password',
    asyncHandler(async (req, res) => {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return errorRes(res, 400, 'Token e nova senha são obrigatórios');
        }

        const pwdCheck = validatePassword(newPassword);
        if (!pwdCheck.ok) {
            return errorRes(res, 400, pwdCheck.msg);
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const user = await User.findOne({
            resetPasswordToken: tokenHash,
            resetPasswordExpires: { $gt: new Date() }
        }).select('+tokenVersion +resetPasswordToken +resetPasswordExpires');

        if (!user) {
            return errorRes(res, 400, 'Token inválido ou expirado');
        }

        user.password = newPassword;
        user.resetPasswordToken = null;
        user.resetPasswordExpires = null;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();

        res.json({
            success: true,
            message: 'Senha redefinida com sucesso. Faça login novamente.'
        });
    })
);

// ============================================
// POST /api/v1/auth/verify-email
// ============================================
router.post(
    '/verify-email',
    authenticate,
    asyncHandler(async (req, res) => {
        const user = await User.findById(req.userId);

        if (!user) {
            return errorRes(res, 404, 'Usuário não encontrado');
        }

        user.emailVerified = true;
        await user.save();

        res.json({
            success: true,
            message: 'Email verificado com sucesso'
        });
    })
);

// ============================================
// 2FA — SETUP
// ============================================
router.post(
    '/2fa/setup',
    authenticate,
    asyncHandler(async (req, res) => {
        const user = await User.findById(req.userId).select('+twoFactorSecret');

        if (!user) {
            return errorRes(res, 404, 'Usuário não encontrado');
        }

        if (user.twoFactorEnabled) {
            return errorRes(res, 400, '2FA já está ativado');
        }

        const secret = speakeasy.generateSecret({
            name: `BradiCoin (${user.email})`,
            issuer: 'BradiCoin',
            length: 32
        });

        user.twoFactorSecret = secret.base32;
        await user.save();

        const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);

        res.json({
            success: true,
            message: 'Escaneie o QR code no Google Authenticator',
            data: {
                secret: secret.base32,
                qrCode: qrCodeDataUrl
            }
        });
    })
);

// ============================================
// 2FA — VERIFY
// ============================================
router.post(
    '/2fa/verify',
    authenticate,
    asyncHandler(async (req, res) => {
        const { code } = req.body;

        if (!code) {
            return errorRes(res, 400, 'Código é obrigatório');
        }

        const user = await User.findById(req.userId).select('+twoFactorSecret');

        if (!user) {
            return errorRes(res, 404, 'Usuário não encontrado');
        }

        if (!user.twoFactorSecret) {
            return errorRes(res, 400, '2FA não foi configurado. Chame /2fa/setup primeiro.');
        }

        const verified = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token: code,
            window: 1
        });

        if (!verified) {
            return errorRes(res, 401, 'Código inválido');
        }

        user.twoFactorEnabled = true;
        await user.save();

        res.json({
            success: true,
            message: '2FA ativado com sucesso'
        });
    })
);

// ============================================
// 2FA — DISABLE
// ============================================
router.post(
    '/2fa/disable',
    authenticate,
    asyncHandler(async (req, res) => {
        const { code } = req.body;

        if (!code) {
            return errorRes(res, 400, 'Código é obrigatório');
        }

        const user = await User.findById(req.userId).select('+twoFactorSecret');

        if (!user) {
            return errorRes(res, 404, 'Usuário não encontrado');
        }

        if (!user.twoFactorEnabled) {
            return errorRes(res, 400, '2FA não está ativado');
        }

        const verified = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token: code,
            window: 1
        });

        if (!verified) {
            return errorRes(res, 401, 'Código inválido');
        }

        user.twoFactorEnabled = false;
        user.twoFactorSecret = null;
        await user.save();

        res.json({
            success: true,
            message: '2FA desativado'
        });
    })
);

// ============================================
// POST /api/v1/auth/refresh
// ============================================
router.post(
    '/refresh',
    authenticate,
    asyncHandler(async (req, res) => {
        const token = generateToken(req.user);

        res.json({
            success: true,
            data: {
                token,
                expiresIn: process.env.JWT_EXPIRES_IN || '7d'
            }
        });
    })
);

// ============================================
// EXPORTS
// ============================================
module.exports = router;
