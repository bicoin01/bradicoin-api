// p2p/status.js
// Handshake: altura, genesis, chainwork.

const { pipe } = require('it-pipe');
const { lp } = require('it-length-prefixed');

const PROTOCOL = '/bradicoin/status/1.0.0';

function buildStatusPayload(blockchain) {
  const latest = blockchain.getLatestBlock();
  return {
    genesisHash: process.env.BRADICOIN_GENESIS_HASH || null,
    height: latest ? latest.index : -1,
    bestHash: latest ? latest.hash : null,
    chainwork: blockchain.getChainwork ? blockchain.getChainwork() : '0',
    difficulty: blockchain.getCurrentDifficulty ? blockchain.getCurrentDifficulty() : null,
    agentVersion: 'bradicoin/4.0.0',
    timestamp: Date.now(),
  };
}

function registerStatusProtocol(node, blockchain) {
  node.handle(PROTOCOL, async ({ stream }) => {
    try {
      await pipe(
        stream.source,
        lp.decode(),
        async function* (source) {
          for await (const msg of source) {
            yield new TextEncoder().encode(
              JSON.stringify(buildStatusPayload(blockchain))
            );
          }
        },
        lp.encode(),
        stream.sink
      );
    } catch (err) {
      console.error('[status] erro:', err.message);
    }
  });
  console.log(`📡 protocolo ${PROTOCOL} registrado`);
}

async function queryStatus(node, peerId) {
  const stream = await node.dialProtocol(peerId, PROTOCOL);
  let response = null;
  await pipe(
    [new TextEncoder().encode(JSON.stringify({ ping: true }))],
    lp.encode(),
    stream,
    lp.decode(),
    async function (source) {
      for await (const msg of source) {
        response = JSON.parse(new TextDecoder().decode(msg.slice()));
        break;
      }
    }
  );
  return response;
}

module.exports = { registerStatusProtocol, queryStatus, buildStatusPayload, PROTOCOL };
