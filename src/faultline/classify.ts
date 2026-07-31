/**
 * On-chain event classification — SPEC-FAULTLINE.md §2.
 *
 * Every rule here is derived from the deployed contract source or from observed
 * mainnet/testnet transaction shapes, never from field-name inference. Where a
 * rule encodes a contract detail, the source is cited inline, because a silent
 * change upstream would otherwise turn this file into confidently wrong output.
 */

import type { Transaction } from '../ckb/rpc.ts';

export type CloseKind = 'cooperative' | 'force_close';
export type CommitmentSpendKind = 'penalty' | 'settlement';

/**
 * `EMPTY_WITNESS_ARGS` — the 16-byte prefix every commitment-lock unlock witness
 * must start with.
 *
 * commitment-lock/src/main.rs:81
 *   const EMPTY_WITNESS_ARGS: [u8; 16] = [16,0,0,0, 16,0,0,0, 16,0,0,0, 16,0,0,0];
 */
const EMPTY_WITNESS_ARGS_HEX = '10000000100000001000000010000000';

/** Byte offset of `unlock_count`: immediately after the 16-byte witness-args prefix. */
const UNLOCK_COUNT_BYTE_OFFSET = 16;

/** commitment-lock args are a fixed 57 bytes (main.rs:172 — `if args.len() != 57`). */
export const COMMITMENT_LOCK_ARGS_BYTES = 57;

/**
 * Classify how a funding cell was spent.
 *
 * A force close leaves at least one `commitment-lock` output (the delay/revocation
 * structure); a cooperative close pays both parties out directly. Observed on CKB
 * testnet: cooperative closes have 2 plain outputs, force closes have 1 commitment
 * output.
 */
export function classifyClose(
  closeTx: Transaction,
  commitmentLockCodeHash: string,
): { kind: CloseKind; commitmentOutputIndices: number[] } {
  const commitmentOutputIndices = closeTx.outputs.flatMap((out, i) =>
    out.lock.code_hash === commitmentLockCodeHash ? [i] : [],
  );
  return {
    kind: commitmentOutputIndices.length > 0 ? 'force_close' : 'cooperative',
    commitmentOutputIndices,
  };
}

export interface CommitmentSpend {
  kind: CommitmentSpendKind;
  unlockCount: number;
}

/**
 * Classify a spend of a `commitment-lock` cell as a penalty or an ordinary settlement.
 *
 * commitment-lock/src/main.rs:176-233
 *   let mut witness = load_witness(0, Source::GroupInput)?;
 *   witness.drain(0..EMPTY_WITNESS_ARGS.len())   // 16 bytes
 *   let unlock_count = witness.remove(0);
 *   if unlock_count == 0x00 { ... revocation unlock process ... }
 *   else { ... settlement unlock process ... }
 *
 * `unlock_count == 0x00` selects the revocation branch: a revoked commitment was
 * broadcast and swept by the counterparty. That is the penalty — provable
 * misbehaviour, and the strongest negative signal Faultline has.
 *
 * The contract requires exactly one group input (main.rs:162, `Error::MultipleInputs`),
 * so the witness index equals the input index of the commitment cell being spent.
 *
 * Returns null when the witness is absent or malformed — an unclassifiable spend is
 * reported as such rather than defaulted to `settlement`, since defaulting would
 * silently under-count penalties, the one thing this feed exists to find.
 */
export function classifyCommitmentSpend(
  spendTx: Transaction,
  inputIndex: number,
): CommitmentSpend | null {
  const witness = spendTx.witnesses[inputIndex];
  if (!witness || !witness.startsWith('0x')) return null;

  const hex = witness.slice(2);
  if (!hex.toLowerCase().startsWith(EMPTY_WITNESS_ARGS_HEX)) return null;

  const unlockCountHex = hex.slice(UNLOCK_COUNT_BYTE_OFFSET * 2, UNLOCK_COUNT_BYTE_OFFSET * 2 + 2);
  if (unlockCountHex.length !== 2) return null;

  const unlockCount = Number.parseInt(unlockCountHex, 16);
  if (Number.isNaN(unlockCount)) return null;

  return {
    kind: unlockCount === 0x00 ? 'penalty' : 'settlement',
    unlockCount,
  };
}

export function outPointKey(txHash: string, index: number): string {
  return `${txHash}:${index}`;
}

export function parseOutPointKey(key: string): { txHash: string; index: number } {
  const at = key.lastIndexOf(':');
  return { txHash: key.slice(0, at), index: Number(key.slice(at + 1)) };
}
