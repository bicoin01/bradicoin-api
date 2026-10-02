// p2p/test-network.js — 3 nós em memória
const path = require('path');
const EventEmitter = require('events');

function makeFakeBlockchain() {
  const bc = new EventEmitter();
  bc.chain = [{
    index: 0, hash: 'genesis', previousHash: '0'.repeat(64),
    timestamp: new Date().toISOString(), nonce: 0, difficulty: 3,
    transactions: [],
  }];
  bc.pendingTransactions = [];
  bc.getLatestBlock = () => bc.chain[bc.chain.length - 1];
  bc.getBlockByIndexOrNull = async (i) => bc.chain[i] || null;
  bc.getBlockByHashOrNull = async (h) =>
    bc.chain.find(b => b.hash === h) || null;
  bc.getChainwork = () => String(bc.chain.length);
  bc.getCurrentDifficulty = () => 3;
  bc.addTransaction = async (tx) => {
    bc.pendingTransactions.push(tx);
    bc.emit('tx:new', tx);
  };
  bc.acceptBlockFromPeer = async (blk) => {
    const tip = bc.getLatestBlock();
    if (blk.previousHash !== tip.hash) {
      throw new Error(`previousHash não bate (bloco ${blk.index})`);
    }
    bc.chain.push(blk);
    bc.emit('block:new', blk);
  };
  return bc;
}

async function boot(idx, port) {
  process.env.P2P_PORT = String(port);
  process.env.BRADICOIN_IDENTITY_PATH = path.join(
    process.cwd(), 'data', `test-node-${idx}.key`
  );

  for (const m of ['./identity','./node','./index','./status','./gossip','./ibd','./discovery']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }

  const blockchain = makeFakeBlockchain();
  const { startP2P } = require('./index');
  const { node } = await startP2P({ blockchain, port });
  return { node, blockchain, port };
}

(async () => {
  console.log('=== 3 nós Bradicoin ===\n');

  const a = await boot(1, 4101);
  const b = await boot(2, 4102);
  const c = await boot(3, 4103);

  console.log('\n=== Conectando A <- B <- C ===\n');
  const { dialPeer } = require('./node');
  await dialPeer(b.node, a.node.getMultiaddrs()[0].toString());
  await dialPeer(c.node, b.node.getMultiaddrs()[0].toString());

  setTimeout(async () => {
    console.log('\n=== Encerrando ===');
    for (const n of [a, b, c]) await n.node.stop();
    process.exit(0);
  }, 5000);
})();
