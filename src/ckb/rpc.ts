/**
 * Minimal CKB JSON-RPC client (node + indexer methods).
 *
 * Note: the public testnet endpoint rejects requests without a User-Agent (403),
 * so one is always sent.
 */

export interface Script {
  code_hash: string;
  hash_type: 'type' | 'data' | 'data1' | 'data2';
  args: string;
}

export interface OutPoint {
  tx_hash: string;
  index: string;
}

export interface CellOutput {
  capacity: string;
  lock: Script;
  type: Script | null;
}

export interface Transaction {
  hash: string;
  inputs: { previous_output: OutPoint; since: string }[];
  outputs: CellOutput[];
  outputs_data: string[];
  witnesses: string[];
}

/** One row of `get_transactions` with `group_by_transaction: true`. */
export interface GroupedTx {
  block_number: string;
  tx_hash: string;
  tx_index: string;
  /** `[io_type, io_index]` pairs — io_type is "input" or "output". */
  cells: [ioType: 'input' | 'output', ioIndex: string][];
}

/** Block header. `timestamp` is milliseconds since the epoch, hex-encoded. */
export interface Header {
  number: string;
  hash: string;
  timestamp: string;
}

export interface SearchKey {
  script: Script;
  script_type: 'lock' | 'type';
  script_search_mode?: 'prefix' | 'exact';
  group_by_transaction?: boolean;
}

export class RpcError extends Error {
  readonly method: string;
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (code ${code})`);
    this.name = 'RpcError';
    this.method = method;
    this.code = code;
  }
}

export class CkbRpc {
  #id = 0;
  readonly #url: string;
  readonly #opts: { retries?: number; timeoutMs?: number };

  constructor(url: string, opts: { retries?: number; timeoutMs?: number } = {}) {
    this.#url = url;
    this.#opts = opts;
  }

  /** POST one JSON-RPC body — single object or batch array — with retry. */
  async #send(method: string, body: unknown): Promise<unknown> {
    const retries = this.#opts.retries ?? 12;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff, capped at 60s. A full backfill is a multi-hour crawl
        // over a residential link; a brief connectivity drop must not end it. With
        // these defaults the client rides out roughly ten minutes of outage before
        // giving up, and the scan resumes from its persisted cursor regardless.
        await sleep(Math.min(500 * 2 ** attempt, 60_000));
      }
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.#opts.timeoutMs ?? 60_000);
        try {
          const res = await fetch(this.#url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'fiber-atlas/0.1',
            },
            body: JSON.stringify(body),
            signal: ac.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          return await res.json();
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        // A JSON-RPC application error is deterministic — retrying re-sends a bad
        // request. Only transport-level failures are worth another attempt.
        if (err instanceof RpcError) throw err;
        lastErr = err;
      }
    }
    throw new Error(`${method} failed after ${retries + 1} attempts: ${String(lastErr)}`);
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const body = (await this.#send(method, {
      id: ++this.#id,
      jsonrpc: '2.0',
      method,
      params,
    })) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new RpcError(method, body.error.code, body.error.message);
    return body.result as T;
  }

  /**
   * One method, many parameter sets, one round trip.
   *
   * The block-time backfill needs a header per referenced block — 81k of them on
   * testnet. Sent individually that is 81k round trips against a public endpoint,
   * which is hours of pure latency and a good way to get rate-limited. Batched at
   * 100 it is ~815 requests.
   *
   * Batch is standard JSON-RPC, but a proxy in front of a node may not implement
   * it, and the failure is silent-ish: a non-array reply. `supportsBatch` lets the
   * caller probe once and fall back to `call` rather than discover it 800 requests
   * in. Responses are matched by `id`, never by position — the spec permits a
   * server to reorder them.
   */
  async callBatch<T>(method: string, paramsList: unknown[][]): Promise<T[]> {
    if (paramsList.length === 0) return [];
    const ids = paramsList.map(() => ++this.#id);
    const reply = await this.#send(
      method,
      paramsList.map((params, i) => ({ id: ids[i], jsonrpc: '2.0', method, params })),
    );
    if (!Array.isArray(reply)) {
      throw new Error(`${method}: endpoint did not answer a JSON-RPC batch with an array`);
    }
    const byId = new Map<number, { result?: T; error?: { code: number; message: string } }>();
    for (const r of reply as { id: number }[]) byId.set(r.id, r as never);
    return ids.map((id, i) => {
      const r = byId.get(id);
      if (!r) throw new Error(`${method}: batch reply missing id ${id} (request ${i})`);
      if (r.error) throw new RpcError(method, r.error.code, r.error.message);
      return r.result as T;
    });
  }

  /** Probe batch support once, cheaply, so a fallback is a decision and not a surprise. */
  async supportsBatch(): Promise<boolean> {
    try {
      const r = await this.callBatch<unknown>('get_blockchain_info', [[]]);
      return r.length === 1;
    } catch {
      return false;
    }
  }

  async getTransaction(hash: string): Promise<Transaction | null> {
    const res = await this.call<{ transaction: Transaction | null } | null>('get_transaction', [hash]);
    return res?.transaction ?? null;
  }

  /** One page of `get_transactions`. `after` is the previous page's `last_cursor`. */
  async getTransactionsPage(
    searchKey: SearchKey,
    order: 'asc' | 'desc',
    limit: number,
    after?: string,
  ): Promise<{ objects: GroupedTx[]; last_cursor: string }> {
    const params: unknown[] = [searchKey, order, `0x${limit.toString(16)}`];
    if (after) params.push(after);
    return this.call('get_transactions', params);
  }

  /** Header only — the cheapest way to get a block's wall-clock time. */
  async getHeaderByNumber(blockNumber: number): Promise<Header | null> {
    return this.call('get_header_by_number', [`0x${blockNumber.toString(16)}`]);
  }

  /** `getHeaderByNumber` for many blocks in one round trip. See `callBatch`. */
  async getHeadersByNumber(blockNumbers: readonly number[]): Promise<(Header | null)[]> {
    return this.callBatch(
      'get_header_by_number',
      blockNumbers.map((n) => [`0x${n.toString(16)}`]),
    );
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i] as T, i);
    }
  });
  await Promise.all(runners);
  return results;
}
