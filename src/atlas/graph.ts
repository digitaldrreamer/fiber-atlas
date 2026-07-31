/**
 * Fiber gossip graph client — SPEC-ATLAS §2.
 *
 * Field names and shapes verified against fnn v0.8.1 (`crates/fiber-json-types/src/graph.rs`)
 * and against a live testnet node. Notably the node identity field is `pubkey`, not
 * `node_id` — renamed in v0.8.0 by PR #1154.
 */

export interface Script {
  code_hash: string;
  hash_type: string;
  args: string;
}

export interface GraphNode {
  node_name: string;
  version: string;
  addresses: string[];
  features: string[];
  /** Identity public key (secp256k1 compressed hex). Primary key. */
  pubkey: string;
  timestamp: string;
  chain_hash: string;
  auto_accept_min_ckb_funding_amount: string;
  udt_cfg_infos: unknown;
}

/**
 * Per-direction channel policy.
 *
 * `outbound_liquidity` is deliberately absent from this type. fnn populates it only
 * for channels the querying node is itself a party to, so it is null for every
 * third-party channel; SPEC-ATLAS §5.1 forbids consuming or serving it. Leaving it
 * out of the type makes that non-negotiable rather than a matter of discipline.
 */
export interface ChannelUpdateInfo {
  timestamp: string;
  enabled: boolean;
  fee_rate: string;
  tlc_minimum_value: string;
  tlc_expiry_delta: string;
}

export interface GraphChannel {
  /** Packed 36-byte outpoint: tx_hash ‖ index u32-LE. Normalise before joining. */
  channel_outpoint: string;
  node1: string;
  node2: string;
  created_timestamp: string;
  /** Null when that direction has never announced an update — NOT the same as disabled. */
  update_info_of_node1: ChannelUpdateInfo | null;
  update_info_of_node2: ChannelUpdateInfo | null;
  capacity: string;
  chain_hash: string;
  udt_type_script: Script | null;
}

export class FiberRpc {
  #id = 0;
  readonly #url: string;

  constructor(url: string) {
    this.#url = url;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.#url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ++this.#id, jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`fiber rpc HTTP ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`fiber rpc ${method}: ${body.error.message} (${body.error.code})`);
    return body.result as T;
  }

  /**
   * Page through a graph endpoint.
   *
   * Responses are envelopes (`{ nodes | channels, last_cursor }`), not bare arrays —
   * treating them as arrays yields an empty graph that looks like a quiet network.
   */
  async *paginate<T>(
    method: 'graph_nodes' | 'graph_channels',
    field: 'nodes' | 'channels',
    pageSize = 500,
  ): AsyncGenerator<T[]> {
    let after: string | undefined;
    for (;;) {
      const params: Record<string, unknown> = { limit: `0x${pageSize.toString(16)}` };
      if (after) params['after'] = after;
      const res = await this.call<Record<string, unknown>>(method, [params]);
      const items = (res[field] ?? []) as T[];
      if (items.length === 0) return;
      yield items;
      after = res['last_cursor'] as string;
      if (!after || items.length < pageSize) return;
    }
  }

  nodes(pageSize?: number): AsyncGenerator<GraphNode[]> {
    return this.paginate<GraphNode>('graph_nodes', 'nodes', pageSize);
  }

  channels(pageSize?: number): AsyncGenerator<GraphChannel[]> {
    return this.paginate<GraphChannel>('graph_channels', 'channels', pageSize);
  }
}
