// p2p/ibd.js
const { pipe } = require('it-pipe');
const { lp } = require('it-length-prefixed');
const { queryStatus } = require('./status');

const PROTOCOL = '/bradicoin/ibd/1.0.0';
const BATCH_HEADERS = 2000;
const BATCH_BLOCKS = 128;

function registerIBDProtocol(node, blockchain) {
  node.handle(PROTOCOL, async ({ stream }) => {
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

async function runIBD(node, blockchain, peerId) {
  console.log(`🔄 IBD com ${peerId.toString()}`);

  const remoteStatus = await queryStatus(node, peerId);
  if (!remoteStatus) return false;

  const localLatest = blockchain.getLatestBlock();
  const localHeight = localLatest ? localLatest.index : -1;

  console.log(`   local=${localHeight} remoto=${remoteStatus.height}`);
  if (remoteStatus.height <= localHeight) return true;

  const stream = await node.dialProtocol(peerId, PROTOCOL);

  let from = localHeight + 1;
  const target = remoteStatus.height;

  while (from <= target) {
    const to = Math.min(from + BATCH_BLOCKS - 1, target);
    const blocks = await requestBlocks(stream, from, to);
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
