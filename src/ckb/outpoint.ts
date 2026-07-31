/**
 * Outpoint representation — and the one conversion the whole join depends on.
 *
 * The two data sources spell the same outpoint differently:
 *
 *   CKB L1 (`get_transaction`)  { tx_hash: "0xabc…", index: "0x0" }
 *   Fiber gossip (`graph_channels`)  "0xabc…00000000"   (36 bytes: tx_hash ‖ index u32-LE)
 *
 * `channel_outpoint` is the join key between Faultline and Atlas (SPEC-ATLAS §2.2,
 * SPEC-FAULTLINE §1), so a mismatch here does not throw — it silently produces a 0%
 * join rate that reads as "the gossip graph has never heard of these channels."
 * Everything is normalised to the canonical `"0x<tx_hash>:<index>"` form on the way in.
 */

/** Canonical internal form: `0x<64 hex tx_hash>:<decimal index>`. */
export function outPointKey(txHash: string, index: number): string {
  return `${txHash}:${index}`;
}

export function parseOutPointKey(key: string): { txHash: string; index: number } {
  const at = key.lastIndexOf(':');
  return { txHash: key.slice(0, at), index: Number(key.slice(at + 1)) };
}

/**
 * Convert Fiber's packed 36-byte `channel_outpoint` to the canonical form.
 *
 * Layout: 32-byte tx_hash followed by a little-endian u32 output index.
 * Returns null on a malformed value rather than guessing, since a silently wrong
 * key is worse than a visibly missing one.
 */
export function fiberOutPointToKey(packed: string): string | null {
  const hex = packed.startsWith('0x') ? packed.slice(2) : packed;
  if (hex.length !== 72 || !/^[0-9a-fA-F]+$/.test(hex)) return null;

  const txHash = `0x${hex.slice(0, 64)}`;
  const indexLe = hex.slice(64, 72);
  // little-endian: reverse the four bytes before parsing
  const bytes = indexLe.match(/../g);
  if (!bytes) return null;
  const index = Number.parseInt(bytes.reverse().join(''), 16);
  if (Number.isNaN(index)) return null;

  return outPointKey(txHash, index);
}

/** Inverse of {@link fiberOutPointToKey}, for querying Fiber by a canonical key. */
export function keyToFiberOutPoint(key: string): string {
  const { txHash, index } = parseOutPointKey(key);
  const le = (index >>> 0)
    .toString(16)
    .padStart(8, '0')
    .match(/../g)!
    .reverse()
    .join('');
  return `${txHash}${le}`;
}
