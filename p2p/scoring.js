// p2p/scoring.js
const scores = new Map();
const INITIAL = 100, MAX = 500, MIN = -1000;

function ensure(peerId) {
  const k = peerId.toString();
  if (!scores.has(k)) scores.set(k, INITIAL);
  return k;
}
function reward(peerId, amount = 5) {
  const k = ensure(peerId);
  scores.set(k, Math.min(MAX, scores.get(k) + amount));
}
function penalize(peerId, amount = 20, reason = '') {
  const k = ensure(peerId);
  const v = Math.max(MIN, scores.get(k) - amount);
  scores.set(k, v);
  console.log(`⚠️  ${k.substring(0, 12)}... (-${amount}) ${reason} → ${v}`);
  return v;
}
function shouldBan(peerId) { return scores.get(peerId.toString()) <= MIN; }
function get(peerId) { return scores.get(peerId.toString()) ?? INITIAL; }

module.exports = { reward, penalize, shouldBan, get };
