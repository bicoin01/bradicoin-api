// p2p/identity.js
// ============================================
// Identidade persistente do nó Bradicoin (libp2p)
// ============================================
// Cada nó tem UMA chave Ed25519 que gera um PeerID.
// Essa chave fica salva em disco e sobrevive a restarts.
// É o "CPF" do nó na rede descentralizada.
// ============================================

const fs = require('fs');
const path = require('path');
const { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } =
  require('@libp2p/crypto/keys');
const { peerIdFromPrivateKey } = require('@libp2p/peer-id');

const IDENTITY_PATH = process.env.BRADICOIN_IDENTITY_PATH
  || path.join(process.cwd(), 'data', 'p2p-identity.key');

async function loadOrCreateIdentity() {
  const dir = path.dirname(IDENTITY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let privateKey;

  if (fs.existsSync(IDENTITY_PATH)) {
    const buf = fs.readFileSync(IDENTITY_PATH);
    privateKey = privateKeyFromProtobuf(buf);
  } else {
    privateKey = await generateKeyPair('Ed25519');
    const buf = privateKeyToProtobuf(privateKey);
    fs.writeFileSync(IDENTITY_PATH, buf, { mode: 0o600 });
    console.log('[p2p] nova identidade criada em', IDENTITY_PATH);
  }

  const peerId = peerIdFromPrivateKey(privateKey);
  return { privateKey, peerId };
}

module.exports = { loadOrCreateIdentity, IDENTITY_PATH };
