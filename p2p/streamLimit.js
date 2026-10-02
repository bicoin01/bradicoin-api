// p2p/streamLimit.js
// Limita streams simultâneos por peer.
'use strict';

const MAX_STREAMS_PER_PEER   = 20;  // streams abertos ao mesmo tempo
const MAX_STREAMS_PER_WINDOW = 100; // streams por minuto (rotatividade)
const WINDOW_MS              = 60_000;

// peerId.toString() → { active: Set<streamId>, opened: [ts, ts, ...] }
const _state = new Map();

function key(peerId) { return peerId.toString(); }

function getOrCreate(peerId) {
  const k = key(peerId);
  let s = _state.get(k);
  if (!s) {
    s = { active: new Set(), opened: [] };
    _state.set(k, s);
  }
  return s;
}

/**
 * Verifica se o peer pode abrir mais um stream.
 * Retorna { ok: true, streamId } ou { ok: false, reason, ... }
 */
function canOpen(peerId) {
  const s = getOrCreate(peerId);
  const now = Date.now();

  // Limpa janela antiga
  const cutoff = now - WINDOW_MS;
  while (s.opened.length && s.opened[0] < cutoff) {
    s.opened.shift();
  }

  // 1. Streams simultâneos
  if (s.active.size >= MAX_STREAMS_PER_PEER) {
    return {
      ok: false,
      reason: 'too-many-active',
      active: s.active.size,
      max: MAX_STREAMS_PER_PEER,
    };
  }

  // 2. Streams por minuto (rotatividade alta)
  if (s.opened.length >= MAX_STREAMS_PER_WINDOW) {
    return {
      ok: false,
      reason: 'too-many-opened',
      opened: s.opened.length,
      max: MAX_STREAMS_PER_WINDOW,
    };
  }

  // Registra
  const streamId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  s.active.add(streamId);
  s.opened.push(now);

  return { ok: true, streamId };
}

/**
 * Chamado quando um stream fecha.
 */
function close(peerId, streamId) {
  const s = _state.get(key(peerId));
  if (!s) return;
  s.active.delete(streamId);
}

/**
 * Chamado quando o peer desconecta — limpa tudo.
 */
function clear(peerId) {
  _state.delete(key(peerId));
}

/**
 * Diagnóstico.
 */
function stats() {
  const out = {};
  for (const [k, s] of _state) {
    out[k.substring(0, 16)] = {
      active: s.active.size,
      openedLastMin: s.opened.length,
    };
  }
  return out;
}

// GC periódico — remove peers inativos
setInterval(() => {
  const now = Date.now();
  const cutoff = now - 5 * 60_000; // 5min sem atividade
  for (const [k, s] of _state) {
    if (s.active.size === 0 && (!s.opened.length || s.opened[s.opened.length - 1] < cutoff)) {
      _state.delete(k);
    }
  }
}, 60_000).unref();

module.exports = {
  canOpen,
  close,
  clear,
  stats,
  MAX_STREAMS_PER_PEER,
  MAX_STREAMS_PER_WINDOW,
  WINDOW_MS,
};
