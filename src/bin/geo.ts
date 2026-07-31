/**
 * Network-location enrichment for announced node addresses.
 *
 *   node --experimental-sqlite src/bin/geo.ts [--watch] [--interval 3600]
 *
 * Env: CLOUDFLARE_API_TOKEN (required), FIBER_ATLAS_DB, FIBER_NETWORK.
 *
 * Resolves each routable IP a node broadcasts in gossip to a country and AS, via
 * Cloudflare Radar. Three deliberate limits:
 *
 *   - Only addresses the node itself announced publicly are looked up. Nothing is
 *     probed, scanned, or inferred from a connection.
 *   - Private, loopback and link-local addresses are never sent anywhere. Fiber
 *     nodes announce them constantly (an AWS host broadcasts its 172.31 interface)
 *     and they carry no location.
 *   - Keyed by IP and cached permanently, so an IP is looked up once no matter how
 *     many nodes announce it.
 *
 * Without a token this exits 0 having done nothing: geo is an optional enrichment
 * and its absence must not fail a deployment. The API reports coverage either way,
 * so an unresolved node is visibly unresolved rather than silently dropped from a
 * map.
 */

import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { Store } from '../db.ts';
import { routableIps } from '../atlas/multiaddr.ts';
import { sleep } from '../ckb/rpc.ts';

const { values } = parseArgs({
  options: {
    watch: { type: 'boolean', default: false },
    interval: { type: 'string', default: '3600' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`fiber-atlas geo enrichment

  --watch          keep running, resolving newly announced addresses
  --interval SECS  seconds between passes when watching (default 3600)

Requires CLOUDFLARE_API_TOKEN. Exits without error if unset.
`);
  process.exit(0);
}

const token = process.env['CLOUDFLARE_API_TOKEN'];
const cfg = loadConfig();
const store = new Store(cfg.dbPath);

if (!token) {
  console.log('CLOUDFLARE_API_TOKEN unset — skipping geo enrichment (this is not an error).');
  store.close();
  process.exit(0);
}

interface RadarIp {
  ip?: string;
  ipVersion?: string;
  location?: string;
  locationName?: string;
  asn?: string;
  asnName?: string;
  asnOrgName?: string;
}

async function lookup(ip: string): Promise<RadarIp | null> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/radar/entities/ip?ip=${encodeURIComponent(ip)}`,
    { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'fiber-atlas/0.1' } },
  );
  if (res.status === 429) {
    // Rate limited: back off rather than burn the rest of the pass. The next tick
    // picks up whatever is still missing — the work list is derived, not a cursor.
    await sleep(30_000);
    return null;
  }
  if (!res.ok) throw new Error(`radar HTTP ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { success?: boolean; result?: { ip?: RadarIp } };
  return body.result?.ip ?? null;
}

async function once(): Promise<void> {
  const known = store.knownIps();
  const wanted = new Set<string>();
  for (const n of store.nodeAddresses()) {
    for (const ip of routableIps(n.addresses_json)) if (!known.has(ip)) wanted.add(ip);
  }
  if (wanted.size === 0) {
    console.log(`all ${known.size} announced address(es) already resolved.`);
    return;
  }
  console.log(`resolving ${wanted.size} new address(es) (${known.size} cached)`);

  let ok = 0;
  let failed = 0;
  for (const ip of wanted) {
    try {
      const r = await lookup(ip);
      if (!r) {
        failed++;
        continue;
      }
      store.putIpLocation({
        ip,
        ipVersion: r.ipVersion ?? null,
        countryCode: r.location ?? null,
        countryName: r.locationName ?? null,
        asn: r.asn ?? null,
        asnName: r.asnName ?? null,
        asnOrg: r.asnOrgName ?? null,
      });
      ok++;
    } catch (err) {
      failed++;
      console.error(`  ${ip}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Courtesy pacing. The set is tens of addresses, not thousands; there is no
    // reason to be aggressive with someone else's API.
    await sleep(250);
  }
  console.log(`resolved ${ok}, failed ${failed}`);
}

try {
  if (values.watch) {
    const interval = Number(values.interval) * 1000;
    console.log(`watching every ${values.interval}s (ctrl-c to stop)\n`);
    for (;;) {
      try {
        await once();
      } catch (err) {
        console.error(`  pass failed (retrying next tick): ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(interval);
    }
  } else {
    await once();
  }
} catch (err) {
  console.error(`geo failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (!values.watch) store.close();
}
