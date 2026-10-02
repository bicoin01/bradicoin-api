// p2p/rateLimit.js
// Rate limit por peer — janela deslizante simples.
'use strict';

const WINDOW_MS   = 1000;   // janela de 1s
const MAX_PER_SEC = 50;     // máx mensagens por segundo por peer
const MAX_BURST   = 100;    // picos curtos permitidos

// peerId.toString() → { timestamps: [ms, ms, ...] }
const _buckets = new Map();

function now() { return Date.now(); }

/**
 * Retorna true se a mensagem deve ser processada.
 * Retorna false se deve ser descartada (rate excedido).
 */
function allow(peerId) {
  const key = peerId.toString();
  const t = now();

  let bucket = _buckets.get(key);
  if (!bucket) {
    bucket = [];
    _buckets.set(key, bucket);
  }

  // Remove timestamps fora da janela
  const cutoff = t - WINDOW_MS;
  while (bucket.length && bucket[0] < cutoff) {
    bucket.shift();
  }

  // Excedeu?
  if (bucket.length >= MAX_PER_SEC) {
    return false;
  }

  bucket.push(t);

  // Limite de burst absoluto (evita crescimento infinito do array)
  if (bucket.length > MAX_BURST) {
    bucket.splice(0, bucket.length - MAX_BURST);
  }

  return true;
}

// Limpeza periódica de peers desconectados
setInterval(() => {
  const cutoff = now() - 60_000; // 1 min sem atividade
  for (const [key, bucket] of _buckets) {
    if (!bucket.length || bucket[bucket.length - 1] < cutoff) {
      _buckets.delete(key);
    }
  }
}, 60_000).unref();

module.exports = { allow, MAX_PER_SEC, WINDOW_MS };
