// p2p/gossip.js
const { gossipsub } = require('@chainsafe/libp2p-gossipsub');

const TOPIC_TX = '/bradicoin/mainnet/tx/1.0.0';
const TOPIC_BLOCK = '/bradicoin/mainnet/block/1.0.0';

function buildGossipService() {
  return gossipsub({
    allowPublishToZeroTopicPeers: true,
    emitSelf: false,
    gossipIncoming: true,
    fallbackToFloodsub: true,
    floodPublish: true,
    doPX: true,
    D: 6, Dlo: 4, Dhi: 12,
  });
}

async function wireGossip(node, blockchain) {
  node.services.pubsub.subscribe(TOPIC_TX);
  node.services.pubsub.subscribe(TOPIC_BLOCK);

  node.services.pubsub.addEventListener('message', async (evt) => {
    const { topic, data } = evt.detail;
    if (topic !== TOPIC_TX && topic !== TOPIC_BLOCK) return;

    try {
      const payload = JSON.parse(new TextDecoder().decode(data));

      if (topic === TOPIC_TX) {
        if (blockchain.pendingTransactions.find(t => t.hash === payload.hash)) return;
        await blockchain.addTransaction(payload);
        console.log(`📥 TX recebida: ${payload.hash.substring(0, 12)}...`);
      }

      if (topic === TOPIC_BLOCK) {
        const latest = blockchain.getLatestBlock();
        if (latest && payload.hash === latest.hash) return;
        await blockchain.acceptBlockFromPeer(payload);
        console.log(`📥 Bloco recebido: #${payload.index}`);
      }
    } catch (e) {
      console.error('[gossip] erro:', e.message);
    }
  });

  blockchain.on('tx:new', (tx) => {
    try {
      node.services.pubsub.publish(
        TOPIC_TX, new TextEncoder().encode(JSON.stringify(tx))
      );
    } catch {}
  });

  blockchain.on('block:new', (block) => {
    try {
      node.services.pubsub.publish(
        TOPIC_BLOCK, new TextEncoder().encode(JSON.stringify(block))
      );
    } catch {}
  });

  console.log(`📢 gossip ativo em ${TOPIC_TX} e ${TOPIC_BLOCK}`);
}

module.exports = { buildGossipService, wireGossip, TOPIC_TX, TOPIC_BLOCK };
