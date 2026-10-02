// p2p/messageHandlers.js
// Integra P2P ↔ blockchain.js ↔ consensus/ ↔ Fork Choice/
// Regra de ouro: NUNCA confie no peer. Valide tudo. Puna se mentir.

const { MSG, envelope } = require('./messages');
const { blockchain }     = require('../blockchain');       // TODO: ajustar export
const consensus          = require('../consensus');         // TODO: ajustar
const forkChoice         = require('../Fork Choice');       // TODO: ajustar (nome com espaço)
const gossip             = require('./gossip');

// ---- Política de reputação ----
const POLICY = {
  MIN_SCORE_TO_RELAY:   50,   // abaixo disso, ignora mensagens
  REWARD_VALID_BLOCK:   5,
  REWARD_NEW_BLOCK:     10,
  PUNISH_INVALID_BLOCK: 50,
  PUNISH_BAD_CONSENSUS: 30,
  PUNISH_SPAM:          15,
  BAN_SECONDS_INVALID:  3600, // 1h
  BAN_SECONDS_SPAM:     600,  // 10min
};

// ---- Cache anti-loop (evita reprocessar a mesma msg) ----
const seenBlocks = new Map();   // blockHash -> timestamp
const seenTxs    = new Map();   // txHash    -> timestamp
const SEEN_TTL   = 60 * 60 * 1000; // 1h

function markSeen(map, hash) {
  map.set(hash, Date.now());
  // GC preguiçoso
  if (map.size > 10000) {
    const cutoff = Date.now() - SEEN_TTL;
    for (const [k, t] of map) if (t < cutoff) map.delete(k);
  }
}

function alreadySeen(map, hash) {
  const t = map.get(hash);
  return t && Date.now() - t < SEEN_TTL;
}

// ============================================================
//  HANDLER PRINCIPAL
// ============================================================
async function handleMessage(peer, raw, ctx) {
  const { peerManager, broadcast } = ctx;
  const msg = require('./messages').parse(raw);
  if (!msg) {
    peerManager.punish(peer.addr, POLICY.PUNISH_SPAM, POLICY.BAN_SECONDS_SPAM);
    return;
  }

  // Sanidade: se score caiu demais, ignora
  if (peer.score < POLICY.MIN_SCORE_TO_RELAY && msg.type !== MSG.PING) {
    return;
  }

  try {
    switch (msg.type) {
      case MSG.HELLO:      return onHello(peer, msg, ctx);
      case MSG.HELLO_ACK:  return onHelloAck(peer, msg, ctx);
      case MSG.BLOCK:      return onBlock(peer, msg, ctx);
      case MSG.PROPOSAL:   return onProposal(peer, msg, ctx);
      case MSG.VOTE:       return onVote(peer, msg, ctx);
      case MSG.TX:         return onTx(peer, msg, ctx);
      case MSG.GET_BLOCK:  return onGetBlock(peer, msg, ctx);
      case MSG.GET_BLOCKS: return onGetBlocks(peer, msg, ctx);
      case MSG.GETADDR:    return onGetAddr(peer, msg, ctx);
      case MSG.ADDR:       return onAddr(peer, msg, ctx);
      case MSG.PING:       return peer.send(envelope(MSG.PONG));
      case MSG.PONG:       return peerManager.reward(peer.addr, 1);
      default:
        peerManager.punish(peer.addr, 1);
    }
  } catch (err) {
    // Nunca deixe uma exceção derrubar o loop P2P
    console.error(`[P2P] handler ${msg.type} falhou:`, err.message);
    peerManager.punish(peer.addr, 5);
  }
}

// ============================================================
//  HANDSHAKE
// ============================================================
function onHello(peer, msg, { peerManager }) {
  const { version, genesisHash, height, bestHash } = msg.payload;

  // 1. Mesma rede?
  if (genesisHash !== blockchain.getGenesisHash()) {
    peerManager.punish(peer.addr, 100, 86400); // ban 24h — rede errada
    peer.disconnect();
    return;
  }

  // 2. Versão compatível?
  if (!isCompatibleVersion(version)) {
    peerManager.punish(peer.addr, 20, 3600);
    peer.disconnect();
    return;
  }

  peer.version    = version;
  peer.height     = height;
  peer.bestHash   = bestHash;
  peer.handshaked = true;

  peer.send(envelope(MSG.HELLO_ACK, {
    version:     blockchain.VERSION,
    genesisHash: blockchain.getGenesisHash(),
    height:      blockchain.getHeight(),
    bestHash:    blockchain.getBestHash(),
  }));

  peerManager.reward(peer.addr, 5);

  // Se peer está atrás, oferecemos sync (ele pode pedir via GET_BLOCKS)
  // Se peer está à frente, pedimos sync
  if (height > blockchain.getHeight()) {
    requestSyncFrom(peer);
  }
}

function onHelloAck(peer, msg, { peerManager }) {
  if (!peer.handshaked) {
    peerManager.punish(peer.addr, 20);
    return;
  }
  peer.height   = msg.payload.height;
  peer.bestHash = msg.payload.bestHash;
  peerManager.reward(peer.addr, 5);
}

function isCompatibleVersion(v) {
  // TODO: sua regra de compatibilidade
  return typeof v === 'string' && v.startsWith('1.');
}

// ============================================================
//  BLOCO — pipeline crítico
// ============================================================
async function onBlock(peer, msg, ctx) {
  const { peerManager, broadcast } = ctx;
  const block = msg.payload.block;

  if (!block || !block.hash) {
    peerManager.punish(peer.addr, POLICY.PUNISH_SPAM);
    return;
  }

  // 1. Já vimos? (evita loops de gossip)
  if (alreadySeen(seenBlocks, block.hash)) {
    peerManager.reward(peer.addr, 1);
    return;
  }

  // 2. Validação estrutural + criptográfica
  //    (blockchain.js deve checar: hash, merkle root, assinatura do proposer,
  //     tamanho, timestamp dentro da janela, etc.)
  const structure = blockchain.validateBlock(block);
  if (!structure.ok) {
    peerManager.punish(peer.addr, POLICY.PUNISH_INVALID_BLOCK, POLICY.BAN_SECONDS_INVALID);
    console.warn(`[P2P] bloco inválido de ${peer.addr}: ${structure.reason}`);
    return;
  }

  // 3. Consenso (PoS: assinaturas de validadores, quorum 2/3, etc.)
  const consensusCheck = consensus.verifyBlock(block, {
    parent: blockchain.getBlockByHash(block.parentHash),
  });
  if (!consensusCheck.ok) {
    peerManager.punish(peer.addr, POLICY.PUNISH_BAD_CONSENSUS);
    console.warn(`[P2P] consenso falhou p/ ${block.hash}: ${consensusCheck.reason}`);
    return;
  }

  // 4. Fork Choice — decide se este bloco vira novo head
  const fc = await forkChoice.applyBlock(block, {
    currentHead: blockchain.getBestHash(),
    getBlock:    h => blockchain.getBlockByHash(h),
  });

  if (fc.accepted) {
    // 5. Persiste + atualiza estado
    blockchain.addBlock(block);        // TODO: ajustar nome real
    peerManager.reward(peer.addr, fc.isNewHead
      ? POLICY.REWARD_NEW_BLOCK
      : POLICY.REWARD_VALID_BLOCK);

    markSeen(seenBlocks, block.hash);

    // 6. Propaga (gossip) para os outros, exceto quem mandou
    gossip.broadcast(ctx, envelope(MSG.BLOCK, { block }), { except: peer });
  } else {
    // Bloco era válido mas perdeu o fork choice
    peerManager.reward(peer.addr, 1);
    markSeen(seenBlocks, block.hash); // não precisamos reprocessar
  }
}

// ============================================================
//  PROPOSAL — bloco proposto por validador (PoS)
// ============================================================
async function onProposal(peer, msg, ctx) {
  const { peerManager } = ctx;
  const { block, proposer, signature } = msg.payload;

  if (!block || !proposer || !signature) {
    peerManager.punish(peer.addr, POLICY.PUNISH_SPAM);
    return;
  }

  // 1. Proposer é validador ativo para esta altura?
  const isValidator = consensus.isActiveValidator(proposer, block.height);
  if (!isValidator.ok) {
    peerManager.punish(peer.addr, POLICY.PUNISH_BAD_CONSENSUS);
    return;
  }

  // 2. Assinatura confere com o bloco?
  const sig = consensus.verifyProposerSignature(block, proposer, signature);
  if (!sig.ok) {
    peerManager.punish(peer.addr, POLICY.PUNISH_INVALID_BLOCK, POLICY.BAN_SECONDS_INVALID);
    return;
  }

  // 3. Delega para o mesmo pipeline do BLOCK
  return onBlock(peer, { payload: { block } }, ctx);
}

// ============================================================
//  VOTE — voto de validador (PoS BFT-style)
// ============================================================
async function onVote(peer, msg, ctx) {
  const { peerManager } = ctx;
  const { blockHash, height, signature, validator } = msg.payload;

  // 1. Validador ativo?
  const isValidator = consensus.isActiveValidator(validator, height);
  if (!isValidator.ok) {
    peerManager.punish(peer.addr, POLICY.PUNISH_BAD_CONSENSUS);
    return;
  }

  // 2. Assinatura válida?
  const ok = consensus.verifyVote({ blockHash, height, validator, signature });
  if (!ok) {
    peerManager.punish(peer.addr, POLICY.PUNISH_BAD_CONSENSUS, POLICY.BAN_SECONDS_SPAM);
    return;
  }

  // 3. Entrega ao consenso (que agrega votos e checa quorum)
  consensus.ingestVote({ blockHash, height, validator, signature });

  // 4. Se atingiu quorum, finaliza o bloco no fork choice
  if (consensus.hasQuorum(blockHash, height)) {
    forkChoice.finalize(blockHash);
  }

  peerManager.reward(peer.addr, 2);
}

// ============================================================
//  TRANSAÇÃO
// ============================================================
function onTx(peer, msg, ctx) {
  const { peerManager } = ctx;
  const tx = msg.payload.tx;

  if (!tx || !tx.hash) {
    peerManager.punish(peer.addr, POLICY.PUNISH_SPAM);
    return;
  }
  if (alreadySeen(seenTxs, tx.hash)) {
    peerManager.reward(peer.addr, 1);
    return;
  }

  const valid = blockchain.validateTransaction(tx); // TODO: ajustar
  if (!valid.ok) {
    peerManager.punish(peer.addr, POLICY.PUNISH_SPAM);
    return;
  }

  blockchain.getMempool().add(tx); // TODO: ajustar
  markSeen(seenTxs, tx.hash);

  gossip.broadcast(ctx, envelope(MSG.TX, { tx }), { except: peer });
  peerManager.reward(peer.addr, 2);
}

// ============================================================
//  SYNC / DISCOVERY
// ============================================================
function onGetBlock(peer, msg, { peerManager }) {
  const block = blockchain.getBlockByHash(msg.payload.hash);
  if (block) {
    peer.send(envelope(MSG.BLOCK, { block }));
    peerManager.reward(peer.addr, 1);
  } else {
    peerManager.punish(peer.addr, 5);
  }
}

function onGetBlocks(peer, msg, { peerManager }) {
  const { fromHeight, count = 100 } = msg.payload;
  const blocks = blockchain.getBlocksRange(fromHeight, Math.min(count, 500));
  for (const b of blocks) {
    peer.send(envelope(MSG.BLOCK, { block: b }));
  }
  peerManager.reward(peer.addr, 3);
}

function onGetAddr(peer, msg, { peerManager }) {
  const peers = peerManager.bestPeers(20).map(p => ({ host: p.host, port: p.port }));
  peer.send(envelope(MSG.ADDR, { peers }));
  peerManager.reward(peer.addr, 2);
}

function onAddr(peer, msg, { peerManager }) {
  const list = msg.payload.peers || [];
  let added = 0;
  for (const { host, port } of list.slice(0, 50)) {
    if (isValidHost(host) && isValidPort(port)) {
      peerManager.addPeer(host, port);
      added++;
    }
  }
  // Reward proporcional, mas com teto (evita farm de score)
  peerManager.reward(peer.addr, Math.min(added, 5));
}

function isValidHost(h) {
  return typeof h === 'string' && h.length < 255 && !/[\s<>]/.test(h);
}
function isValidPort(p) {
  return Number.isInteger(p) && p > 0 && p < 65536;
}

// ============================================================
//  SYNC helper (Passo 3 será expandido)
// ============================================================
function requestSyncFrom(peer) {
  const from = blockchain.getHeight() + 1;
  peer.send(envelope(MSG.GET_BLOCKS, { fromHeight: from, count: 200 }));
}

module.exports = {
  handleMessage,
  POLICY,
  seenBlocks,
  seenTxs,
};
