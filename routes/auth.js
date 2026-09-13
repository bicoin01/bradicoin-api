// routes/auth.js
// ============================================
// Rotas de autenticação - Bradicoin
// ============================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');

// ============================================
// HELPERS
// ============================================

function generateToken(userId) {
    return jwt.sign(
        { id: userId },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
}

function validateEmail(email) {
    return /^\S+@\S+\.\S+$/.test(email);
}

function validateUsername(username) {
    return /^[a-zA-Z0-9_]{3,30}$/.test(username);
}

// ============================================
// POST /api/v1/auth/register
// Cria nova conta
// ============================================

router.post(
    '/register',
    asyncHandler(async (req, res) => {
        const { email, password, username } = req.body;

        if (!email || !password || !username) {
            return res.status(400).json({
                success: false,
                error: 'Email, senha e username são obrigatórios'
            });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({
                success: false,
                error: 'Email inválido'
            });
        }

        if (!validateUsername(username)) {
            return res.status(400).json({
                success: false,
                error: 'Username deve ter 3-30 caracteres (letras, números, _)'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                error: 'Senha deve ter no mínimo 6 caracteres'
            });
        }

        const existing = await User.findOne({
            $or: [
                { email: email.toLowerCase() },
                { username: username.toLowerCase() }
            ]
        });

        if (existing) {
            const field = existing.email === email.toLowerCase() ? 'Email' : 'Username';
            return res.status(409).json({
                success: false,
                error: `${field} já está em uso`
            });
        }

        const user = await User.create({
            email: email.toLowerCase(),
            password,
            username: username.toLowerCase(),
            metadata: {
                userAgent: req.headers['user-agent'] || null,
                ip: req.ip
            }
        });

        const token = generateToken(user._id);

        res.status(201).json({
            success: true,
            message: 'Conta criada com sucesso',
            data: {
                user: user.toPublic(),
                token,
                expiresIn: process.env.JWT_EXPIRES_IN || '7d'
            }
        });
    })
);

// ============================================
// POST /api/v1/auth/login
// ============================================

router.post(
    '/login',
    asyncHandler(async (req, res) => {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email e senha são obrigatórios'
            });
        }

        const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Email ou senha incorretos'
            });
        }

        if (user.status !== 'active') {
            return res.status(403).json({
                success: false,
                error: 'Conta suspensa ou inativa'
            });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                error: 'Email ou senha incorretos'
            });
        }

        user.lastLogin = new Date();
        await user.save();

        const token = generateToken(user._id);

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
            return res.status(400).json({
                success: false,
                error: 'Senha atual e nova senha são obrigatórias'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                error: 'Nova senha deve ter no mínimo 6 caracteres'
            });
        }

        const user = await User.findById(req.userId).select('+password');

        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                error: 'Senha atual incorreta'
            });
        }

        user.password = newPassword;
        await user.save();

        res.json({
            success: true,
            message: 'Senha alterada com sucesso'
        });
    })
);

// ============================================
// EXPORTS
// ============================================

module.exports = router;
