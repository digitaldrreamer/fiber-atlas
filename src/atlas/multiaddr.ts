/**
 * Multiaddr parsing, only as far as this project needs it.
 *
 * Fiber nodes announce addresses as libp2p multiaddrs:
 *   /ip4/43.198.254.225/tcp/8226/p2p/QmZnh...
 *   /ip6/2001:db8::1/tcp/8226/ws/p2p/Qm...
 *   /dns4/node.example/tcp/8226/p2p/Qm...
 *
 * Two facts are extracted: the transport a peer would actually dial, and whether
 * the address is routable at all. Fiber nodes routinely announce private addresses
 * alongside public ones — an AWS host broadcasts its 172.31.x interface as readily
 * as its elastic IP — and treating those as locations would be wrong twice over:
 * they resolve to nothing, and they would inflate any per-node address count.
 */

export interface ParsedAddress {
  readonly raw: string;
  readonly kind: 'ip4' | 'ip6' | 'dns' | 'unknown';
  readonly host: string | null;
  readonly port: number | null;
  /** False for private, loopback, link-local and unspecified ranges. */
  readonly routable: boolean;
}

export function parseMultiaddr(raw: string): ParsedAddress {
  const parts = raw.split('/').filter(Boolean);
  let kind: ParsedAddress['kind'] = 'unknown';
  let host: string | null = null;
  let port: number | null = null;

  for (let i = 0; i < parts.length - 1; i++) {
    const proto = parts[i] as string;
    const value = parts[i + 1] as string;
    if (proto === 'ip4' && host === null) { kind = 'ip4'; host = value; }
    else if (proto === 'ip6' && host === null) { kind = 'ip6'; host = value; }
    else if ((proto === 'dns' || proto === 'dns4' || proto === 'dns6' || proto === 'dnsaddr') && host === null) {
      kind = 'dns';
      host = value;
    } else if (proto === 'tcp' && port === null) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) port = n;
    }
  }
  return { raw, kind, host, port, routable: host !== null && isRoutable(kind, host) };
}

/** RFC1918 / loopback / link-local / ULA. Cheap string checks; no dependency. */
export function isRoutable(kind: ParsedAddress['kind'], host: string): boolean {
  if (kind === 'dns') return true;
  if (kind === 'ip4') {
    const o = host.split('.').map((x) => Number.parseInt(x, 10));
    if (o.length !== 4 || o.some((n) => !Number.isFinite(n))) return false;
    const [a, b] = o as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }
  if (kind === 'ip6') {
    const h = host.toLowerCase();
    if (h === '::' || h === '::1') return false;
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return false;
    if (h.startsWith('fc') || h.startsWith('fd')) return false;
    return true;
  }
  return false;
}

/** Every distinct routable IP a node's announced addresses resolve to, in order. */
export function routableIps(addressesJson: string | null): string[] {
  if (!addressesJson) return [];
  let list: unknown;
  try {
    list = JSON.parse(addressesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const a of list) {
    if (typeof a !== 'string') continue;
    const p = parseMultiaddr(a);
    // DNS names are left alone: resolving them would be a second network dependency
    // and would attribute a location to whatever the resolver happened to answer.
    if (p.routable && p.host && (p.kind === 'ip4' || p.kind === 'ip6')) out.add(p.host);
  }
  return [...out];
}
