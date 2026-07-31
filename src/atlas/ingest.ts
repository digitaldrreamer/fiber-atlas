/**
 * Gossip graph ingest — SPEC-ATLAS §7.
 *
 * Upserts nodes and channels by primary key and advances `last_seen`. Records are
 * never deleted: disappearance is signal, not absence of data.
 */

import { FiberRpc, type GraphChannel, type GraphNode } from './graph.ts';
import { fiberOutPointToKey } from '../ckb/outpoint.ts';
import type { Store } from '../db.ts';

export interface IngestResult {
  nodes: number;
  channels: number;
  /** Channels whose packed outpoint could not be parsed — never silently dropped. */
  malformedOutpoints: number;
  directionsWithUpdate: number;
  directionsMissing: number;
}

export async function ingestGraph(rpc: FiberRpc, store: Store): Promise<IngestResult> {
  const result: IngestResult = {
    nodes: 0,
    channels: 0,
    malformedOutpoints: 0,
    directionsWithUpdate: 0,
    directionsMissing: 0,
  };

  for await (const page of rpc.nodes()) {
    store.transaction(() => {
      for (const n of page as GraphNode[]) {
        store.upsertNode({
          pubkey: n.pubkey,
          node_name: n.node_name,
          version: n.version,
          addresses_json: JSON.stringify(n.addresses ?? []),
          features_json: JSON.stringify(n.features ?? []),
          chain_hash: n.chain_hash,
          auto_accept_min_ckb: n.auto_accept_min_ckb_funding_amount,
          udt_cfg_json: JSON.stringify(n.udt_cfg_infos ?? null),
          last_announced: Number(n.timestamp),
        });
        result.nodes++;
      }
    });
  }

  for await (const page of rpc.channels()) {
    store.transaction(() => {
      for (const c of page as GraphChannel[]) {
        // Fiber packs the outpoint as tx_hash ‖ index-LE; the L1 scanner keys on
        // "0x<tx_hash>:<index>". Normalising here is what makes the join work at all.
        const key = fiberOutPointToKey(c.channel_outpoint);
        if (!key) {
          result.malformedOutpoints++;
          continue;
        }

        store.upsertChannelGossip({
          channel_outpoint: key,
          node1_pubkey: c.node1,
          node2_pubkey: c.node2,
          gossip_capacity: c.capacity,
          gossip_udt_type_script: c.udt_type_script ? JSON.stringify(c.udt_type_script) : null,
          created_timestamp: Number(c.created_timestamp),
        });
        result.channels++;

        // A null direction gets no row: "unknown" must stay distinguishable from
        // "disabled" (SPEC-ATLAS §3).
        for (const [dir, info] of [
          [1, c.update_info_of_node1],
          [2, c.update_info_of_node2],
        ] as const) {
          if (!info) {
            result.directionsMissing++;
            continue;
          }
          store.upsertChannelUpdate({
            channel_outpoint: key,
            direction: dir,
            timestamp: Number(info.timestamp),
            enabled: info.enabled ? 1 : 0,
            fee_rate: info.fee_rate,
            tlc_minimum_value: info.tlc_minimum_value,
            tlc_expiry_delta: info.tlc_expiry_delta,
          });
          result.directionsWithUpdate++;
        }
      }
    });
  }

  store.recordGossipSync(result.nodes, result.channels);
  return result;
}
