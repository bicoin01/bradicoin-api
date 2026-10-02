// p2p/messageSize.js
// Limite de tamanho por mensagem recebida via pubsub.
'use strict';

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;   // 2 MB
const MAX_TX_BYTES      = 64 * 1024;         // 64 KB (transação individual)
const MAX_BLOCK_BYTES   = 2 * 1024 * 1024;   // 2 MB (bloco inteiro)

function getSize(data) {
  if (!data) return 0;
  if (typeof data.length === 'number') return data.length;
  if (data.byteLength !== undefined) return data.byteLength;
  return 0;
}

function check(data) {
  const size = getSize(data);
  if (size === 0) return { ok: false, reason: 'empty', size };
  if (size > MAX_MESSAGE_BYTES) {
    return { ok: false, reason: 'too-large', size, limit: MAX_MESSAGE_BYTES };
  }
  return { ok: true, size };
}

// Checagens mais finas depois de parsear (opcional)
function checkTx(tx) {
  const size = getSize(Buffer.from(JSON.stringify(tx)));
  if (size > MAX_TX_BYTES) {
    return { ok: false, reason: 'tx-too-large', size, limit: MAX_TX_BYTES };
  }
  return { ok: true, size };
}

function checkBlock(block) {
  const size = getSize(Buffer.from(JSON.stringify(block)));
  if (size > MAX_BLOCK_BYTES) {
    return { ok: false, reason: 'block-too-large', size, limit: MAX_BLOCK_BYTES };
  }
  return { ok: true, size };
}

module.exports = {
  check,
  checkTx,
  checkBlock,
  MAX_MESSAGE_BYTES,
  MAX_TX_BYTES,
  MAX_BLOCK_BYTES,
};
