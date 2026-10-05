// atomic-swap/security/timelock.js
// ============================================
// Timelock validator — regras de segurança
// ============================================
// REGRA DE OURO: T_taker < T_maker
// Quem recebe primeiro (taker) tem menos tempo.
// ============================================

const GAP_MIN_SECONDS = 2 * 60 * 60;   // gap mínimo: 2h
const GAP_MAX_SECONDS = 24 * 60 * 60;  // gap máximo: 24h
const MIN_TIMELOCK = 1 * 60 * 60;      // timelock mínimo: 1h
const MAX_TIMELOCK = 7 * 24 * 60 * 60; // timelock máximo: 7 dias

function validatePair(timelockMaker, timelockTaker) {
    const now = Math.floor(Date.now() / 1000);

    if (!Number.isFinite(timelockMaker) || !Number.isFinite(timelockTaker)) {
        return { ok: false, reason: 'timelocks devem ser números' };
    }

    if (timelockMaker <= now) {
        return { ok: false, reason: 'timelockMaker já expirou' };
    }
    if (timelockTaker <= now) {
        return { ok: false, reason: 'timelockTaker já expirou' };
    }

    const deltaMaker = timelockMaker - now;
    const deltaTaker = timelockTaker - now;

    if (deltaMaker < MIN_TIMELOCK || deltaMaker > MAX_TIMELOCK) {
        return { ok: false, reason: `timelockMaker fora do range [${MIN_TIMELOCK}s, ${MAX_TIMELOCK}s]` };
    }
    if (deltaTaker < MIN_TIMELOCK || deltaTaker > MAX_TIMELOCK) {
        return { ok: false, reason: `timelockTaker fora do range [${MIN_TIMELOCK}s, ${MAX_TIMELOCK}s]` };
    }

    // ⚠️ REGRA CRÍTICA: taker < maker
    if (timelockTaker >= timelockMaker) {
        return { ok: false, reason: 'timelockTaker deve ser MENOR que timelockMaker' };
    }

    const gap = timelockMaker - timelockTaker;
    if (gap < GAP_MIN_SECONDS) {
        return { ok: false, reason: `gap entre timelocks muito pequeno (${gap}s < ${GAP_MIN_SECONDS}s)` };
    }
    if (gap > GAP_MAX_SECONDS) {
        return { ok: false, reason: `gap entre timelocks muito grande (${gap}s > ${GAP_MAX_SECONDS}s)` };
    }

    return { ok: true, gap };
}

module.exports = {
    GAP_MIN_SECONDS,
    GAP_MAX_SECONDS,
    MIN_TIMELOCK,
    MAX_TIMELOCK,
    validatePair
};
