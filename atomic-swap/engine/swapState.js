// atomic-swap/engine/swapState.js
// ============================================
// SwapState — Máquina de estados do swap
// ============================================
// Fluxo determinístico:
//
//   open → matched → maker_locked → taker_locked
//        → completed | refunded | expired
//
// Regras:
//   - maker_locked só avança quando HTLC maker confirma
//   - taker_locked só avança quando HTLC taker confirma
//   - completed só quando ambos os HTLCs foram claimed
//   - refunded quando um HTLC foi refundado
//   - expired quando timelock passou sem claim
// ============================================

const VALID_TRANSITIONS = {
    open:            ['matched', 'cancelled', 'expired'],
    matched:         ['maker_locked', 'cancelled', 'expired'],
    maker_locked:    ['taker_locked', 'refunded', 'expired'],
    taker_locked:    ['completed', 'refunded', 'expired'],
    completed:       [],  // estado final
    refunded:        [],  // estado final
    cancelled:       [],  // estado final
    expired:         []   // estado final
};

const FINAL_STATES = ['completed', 'refunded', 'cancelled', 'expired'];

class SwapStateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SwapStateError';
    }
}

function canTransition(from, to) {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed) return false;
    return allowed.includes(to);
}

function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw new SwapStateError(`Transição inválida: ${from} → ${to}`);
    }
}

function isFinal(state) {
    return FINAL_STATES.includes(state);
}

function isActive(state) {
    return !isFinal(state);
}

// Estados que ainda esperam ação de alguma parte
function awaitingAction(state) {
    switch (state) {
        case 'open':         return 'taker_accept';
        case 'matched':      return 'maker_lock';
        case 'maker_locked': return 'taker_lock';
        case 'taker_locked': return 'reveal_preimage';
        default:             return null;
    }
}

module.exports = {
    VALID_TRANSITIONS,
    FINAL_STATES,
    SwapStateError,
    canTransition,
    assertTransition,
    isFinal,
    isActive,
    awaitingAction
};
