// p2p/ibd.js
const { pipe } = require('it-pipe');
const { lp } = require('it-length-prefixed');
const { queryStatus } = require('./status');

const PROTOCOL = '/bradicoin/ibd/1.0.0';
const BATCH_HEADERS = 2000;
const BATCH_BLOCKS = 128;

function registerIBDProtocol(node, blockchain) {
  node.handle(PROTOCOL, async ({ stream, connection }) => {
    const streamLimit = require('./streamLimit');
    const scoring = require('./scoring');
    const peerId = connection.remotePeer;

    // ── LIMITE DE STREAMS ─────────────────────────────
    const check = streamLimit.canOpen(peerId);
    if (!check.ok) {
      console.warn(
        `🚫 stream-block: ${peerId.toString().substring(0, 16)}... ` +
        `(${check.reason}: ${check.active || check.opened}/${check.max})`
      );
      scoring.penalize(peerId, 20, `stream-limit:${check.reason}`);
      if (scoring.get(peerId) < 30) {
        node.hangUp(peerId).catch(() => {});
      }
      try { stream.abort?.(); } catch {}
      try { stream.close?.(); } catch {}
      return;
    }
    const streamId = check.streamId;
    // ──────────────────────────────────────────────────

    try {
      await pipe(
        stream.source,
        lp.decode(),
        async function* (source) {
          for await (const msg of source) {
            let req;
            try { req = JSON.parse(new TextDecoder().decode(msg.slice())); }
            catch { continue; }

            let resp = null;
            if (req.type === 'getheaders') {
              resp = await handleGetHeaders(blockchain, req);
            } else if (req.type === 'getblocks') {
              resp = await handleGetBlocks(blockchain, req);
            } else {
              resp = { error: 'unknown' };
            }
            yield new TextEncoder().encode(JSON.stringify(resp));
          }
        },
        lp.encode(),
        stream.sink
      );
    } catch (e) {
      console.error('[ibd] handler:', e.message);
    } finally {
      // ── LIBERA O STREAM ─────────────────────────────
      streamLimit.close(peerId, streamId);
    }
  });
  console.log(`📡 protocolo ${PROTOCOL} registrado`);
}

async function handleGetHeaders(blockchain, req) {
  const locator = req.locator || [];
  let startIndex = 0;

  for (const hash of locator) {
    const blk = await blockchain.getBlockByHashOrNull(hash);
    if (blk) { startIndex = blk.index + 1; break; }
  }

  const headers = [];
  for (let i = startIndex; i < startIndex + BATCH_HEADERS; i++) {
    const blk = await blockchain.getBlockByIndexOrNull(i);
    if (!blk) break;
    headers.push({
      index: blk.index,
      hash: blk.hash,
      previousHash: blk.previousHash,
      timestamp: blk.timestamp,
      nonce: blk.nonce,
      difficulty: blk.difficulty || null,
      txHashes: (blk.transactions || []).map(t => t.hash),
      minerAddress: blk.minerAddress,
    });
  }
  return { type: 'headers', headers };
}

async function handleGetBlocks(blockchain, req) {
  const { from, to } = req;
  const blocks = [];
  for (let i = from; i <= Math.min(to, from + BATCH_BLOCKS - 1); i++) {
    const blk = await blockchain.getBlockByIndexOrNull(i);
    if (!blk) break;
    blocks.push(blk);
  }
  return { type: 'blocks', blocks };
}

// ── TIMEOUT WRAPPER ────────────────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms)
    ),
  ]);
}

const IBD_TIMEOUTS = {
  STATUS:  10_000,   // 10s pra peer responder status
  DIAL:    10_000,   // 10s pra abrir stream
  BATCH:   30_000,   // 30s pra peer devolver um batch de blocos
  TOTAL:   10 * 60_000, // 10min no máximo pro IBD inteiro
};

async function runIBD(node, blockchain, peerId) {
  const scoring = require('./scoring');
  const startAt = Date.now();
  console.log(`🔄 IBD com ${peerId.toString().substring(0, 16)}...`);

  let remoteStatus;
  try {
    remoteStatus = await withTimeout(
      queryStatus(node, peerId),
      IBD_TIMEOUTS.STATUS,
      'queryStatus'
    );
  } catch (e) {
    console.warn(`⏱️  IBD abortado: ${e.message}`);
    scoring.penalize(peerId, 20, 'ibd-status-timeout');
    return false;
  }
  if (!remoteStatus) return false;

  const localLatest = blockchain.getLatestBlock();
  const localHeight = localLatest ? localLatest.index : -1;

  console.log(`   local=${localHeight} remoto=${remoteStatus.height}`);
  if (remoteStatus.height <= localHeight) return true;

  let stream;
  try {
    stream = await withTimeout(
      node.dialProtocol(peerId, PROTOCOL),
      IBD_TIMEOUTS.DIAL,
      'dialProtocol'
    );
  } catch (e) {
    console.warn(`⏱️  IBD abortado: ${e.message}`);
    scoring.penalize(peerId, 20, 'ibd-dial-timeout');
    return false;
  }

  let from = localHeight + 1;
  const target = remoteStatus.height;

  while (from <= target) {
    // Timeout total (protege contra peer que responde devagar mas sempre responde)
    if (Date.now() - startAt > IBD_TIMEOUTS.TOTAL) {
      console.warn(`⏱️  IBD abortado: timeout total (${IBD_TIMEOUTS.TOTAL}ms)`);
      scoring.penalize(peerId, 30, 'ibd-total-timeout');
      try { stream.close?.(); } catch {}
      return false;
    }

    const to = Math.min(from + BATCH_BLOCKS - 1, target);

    let blocks;
    try {
      blocks = await withTimeout(
        requestBlocks(stream, from, to),
        IBD_TIMEOUTS.BATCH,
        `batch ${from}-${to}`
      );
    } catch (e) {
      console.warn(`⏱️  IBD abortado: ${e.message}`);
      scoring.penalize(peerId, 30, 'ibd-batch-timeout');
      try { stream.close?.(); } catch {}
      return false;
    }

    // Se peer não devolveu nada → consideramos mentiroso
    if (!blocks || blocks.length === 0) {
      console.warn(`⚠️  IBD: peer não devolveu blocos em ${from}-${to}`);
      scoring.penalize(peerId, 40, 'ibd-empty-batch');
      try { stream.close?.(); } catch {}
      return false;
    }

    for (const blk of blocks) {
      try {
        await blockchain.acceptBlockFromPeer(blk);
      } catch (e) {
        console.error(`  bloco ${blk.index} rejeitado:`, e.message);
      }
    }

    console.log(`   IBD: ${to}/${target}`);
    from = to + 1;
  }

  console.log(`✅ IBD concluído. Altura: ${blockchain.getLatestBlock()?.index}`);
  try { stream.close?.(); } catch {}
  return true;
}

async function requestBlocks(stream, from, to) {
  const results = [];
  await pipe(
    [new TextEncoder().encode(JSON.stringify({ type: 'getblocks', from, to }))],
    lp.encode(),
    stream,
    lp.decode(),
    async function (source) {
      for await (const msg of source) {
        const resp = JSON.parse(new TextDecoder().decode(msg.slice()));
        if (resp.type === 'blocks') results.push(...resp.blocks);
        break;
      }
    }
  );
  return results;
}

module.exports = { registerIBDProtocol, runIBD, PROTOCOL };
