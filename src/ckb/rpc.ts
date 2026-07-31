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

  async call<T>(method: string, params: unknown[]): Promise<T> {
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
            body: JSON.stringify({ id: ++this.#id, jsonrpc: '2.0', method, params }),
            signal: ac.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
          if (body.error) throw new RpcError(method, body.error.code, body.error.message);
          return body.result as T;
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
