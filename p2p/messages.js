// p2p/messages.js
// Tipos de mensagem P2P da Bradicoin

const MSG = {
  // Handshake
  HELLO:      'HELLO',       // { version, genesisHash, height, bestHash }
  HELLO_ACK:  'HELLO_ACK',   // { version, genesisHash, height, bestHash }

  // Blocos
  BLOCK:      'BLOCK',       // { block }
  GET_BLOCK:  'GET_BLOCK',   // { hash }
  GET_BLOCKS: 'GET_BLOCKS',  // { fromHeight, count }

  // Transações
  TX:         'TX',          // { tx }
  GET_TX:     'GET_TX',      // { hash }

  // Consenso (PoS)
  VOTE:       'VOTE',        // { blockHash, height, signature, validator }
  PROPOSAL:   'PROPOSAL',    // { block, proposer, signature }

  // Descoberta
  GETADDR:    'GETADDR',
  ADDR:       'ADDR',        // { peers: [{host, port}] }
  PING:       'PING',
  PONG:       'PONG',
};

// Envelope padrão — todas as mensagens trafegam assim
function envelope(type, payload = {}, nodeId = null) {
  return JSON.stringify({
    type,
    payload,
    nodeId,
    ts: Date.now(),
    nonce: Math.random().toString(36).slice(2), // anti-replay básico
  });
}

function parse(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg.type) throw new Error('missing type');
    return msg;
  } catch (e) {
    return null;
  }
}

module.exports = { MSG, envelope, parse };
