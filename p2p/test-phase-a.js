// p2p/test-phase-a.js
// Sobe 2 nós em portas diferentes e conecta um no outro.
// Se aparecer "🔗 Peer conectado" nos dois lados = Fase A OK.

const { createP2PNode, dialPeer, stopP2PNode } = require('./node');

(async () => {
  // Nó A na 4001
  process.env.P2P_PORT = '4001';
  process.env.BRADICOIN_IDENTITY_PATH = './data/test-a.key';
  const nodeA = await createP2PNode();

  // Nó B na 4002 (identidade separada)
  process.env.P2P_PORT = '4002';
  process.env.BRADICOIN_IDENTITY_PATH = './data/test-b.key';

  // Truque: limpa módulos pra não reaproveitar a mesma identity em cache
  delete require.cache[require.resolve('./identity')];
  delete require.cache[require.resolve('./node')];
  const { createP2PNode: createB } = require('./node');
  const nodeB = await createB();

  console.log('\n--- Conectando B -> A ---');
  const addrA = nodeA.getMultiaddrs()[0];
  await dialPeer(nodeB, addrA.toString());

  console.log('\n--- Peers do B ---');
  for (const p of nodeB.getPeers()) console.log('  ', p.toString());

  setTimeout(async () => {
    await stopP2PNode(nodeA);
    await stopP2PNode(nodeB);
    process.exit(0);
  }, 3000);
})();
