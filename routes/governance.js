// routes/governance.js
const express = require('express');
const crypto = require('crypto');
const Proposal = require('../models/Proposal');
const { asyncHandler, AppError } = require('../middleware/error');
const { logger } = require('../middleware/error');

const router = express.Router();

// ============================================
// HELPER — Hash do votante (IP + UA)
// ============================================
function getVoterHash(req) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';
    return crypto
        .createHash('sha256')
        .update(`${ip}::${ua}::${process.env.JWT_SECRET}`)
        .digest('hex')
        .substring(0, 32);
}

// ============================================
// GET /api/v1/governance/proposals — Listar
// ============================================
router.get('/proposals', asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const proposals = await Proposal.find()
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit);

    const total = await Proposal.countDocuments();

    res.json({
        success: true,
        data: proposals.map((p) => p.toPublic()),
        total,
        limit,
        offset
    });
}));

// ============================================
// GET /api/v1/governance/proposals/:id — Detalhe
// ============================================
router.get('/proposals/:id', asyncHandler(async (req, res) => {
    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) throw new AppError('Proposta não encontrada', 404);

    res.json({ success: true, data: proposal.toPublic() });
}));

// ============================================
// GET /api/v1/governance/stats — Estatísticas
// ============================================
router.get('/stats', asyncHandler(async (req, res) => {
    const stats = await Proposal.getStats();
    res.json({ success: true, data: stats });
}));

// ============================================
// POST /api/v1/governance/proposals — Criar
// ============================================
router.post('/proposals', asyncHandler(async (req, res) => {
    const { title, description, options } = req.body;

    if (!title || !description || !options) {
        throw new AppError('Título, descrição e opções são obrigatórios', 400);
    }

    if (!Array.isArray(options) || options.length < 2) {
        throw new AppError('Mínimo de 2 opções', 400);
    }

    // Deduplica e limpa
    const cleanOptions = [...new Set(options.map((o) => String(o).trim()).filter((o) => o))];
    if (cleanOptions.length < 2) {
        throw new AppError('Opções duplicadas ou vazias', 400);
    }

    // Rate limit por IP: máx 3 propostas por hora
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await Proposal.countDocuments({
        creatorIp: getVoterHash(req),
        createdAt: { $gte: oneHourAgo }
    });

    if (recentCount >= 3) {
        throw new AppError('Limite de 3 propostas por hora atingido', 429);
    }

    const proposal = new Proposal({
        title: title.trim().substring(0, 200),
        description: description.trim().substring(0, 2000),
        options: cleanOptions,
        votes: {},
        voters: [],
        creator: '0xQ' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        creatorIp: getVoterHash(req)
    });

    await proposal.save();
    logger.info(`⚛️ Proposta criada: ${proposal._id} - "${proposal.title}"`);

    res.status(201).json({
        success: true,
        message: 'Proposta criada com sucesso',
        data: proposal.toPublic()
    });
}));

// ============================================
// POST /api/v1/governance/proposals/:id/vote — Votar
// ============================================
router.post('/proposals/:id/vote', asyncHandler(async (req, res) => {
    const { option } = req.body;
    if (!option) throw new AppError('Opção é obrigatória', 400);

    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) throw new AppError('Proposta não encontrada', 404);

    const voterHash = getVoterHash(req);

    try {
        await proposal.vote(voterHash, option);
        logger.info(`🗳️ Voto: ${proposal._id} → "${option}"`);

        res.json({
            success: true,
            message: 'Voto registrado',
            data: proposal.toPublic()
        });
    } catch (err) {
        throw new AppError(err.message, 400);
    }
}));

// ============================================
// POST /api/v1/governance/proposals/:id/end — Encerrar
// ============================================
router.post('/proposals/:id/end', asyncHandler(async (req, res) => {
    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) throw new AppError('Proposta não encontrada', 404);

    try {
        await proposal.end();
        logger.info(`🔒 Proposta encerrada: ${proposal._id}`);

        res.json({
            success: true,
            message: 'Proposta encerrada',
            data: proposal.toPublic()
        });
    } catch (err) {
        throw new AppError(err.message, 400);
    }
}));

module.exports = router;
