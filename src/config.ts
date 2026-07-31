/**
 * Network configuration.
 *
 * Lock script code hashes are network-specific and are transcribed from the fnn
 * config that ships with the node — see SPEC-FAULTLINE.md §2.1. Pointing a scanner
 * at the wrong network's hashes returns zero results, which is indistinguishable
 * from "this network has no events". `assertNonEmpty` in the scanner exists to
 * turn that silent failure into a loud one.
 *
 * Source: https://github.com/nervosnetwork/fiber/blob/v0.9.0-rc7/config/{testnet,mainnet}/config.yml
 */

export const FNN_VERSION = 'v0.9.0-rc7' as const;

export type NetworkName = 'testnet' | 'mainnet';

export interface NetworkConfig {
  readonly name: NetworkName;
  readonly ckbRpcUrl: string;
  /** Lock on the channel funding cell. Its outpoint is the `channel_outpoint` join key. */
  readonly fundingLockCodeHash: string;
  /** Lock on outputs of a unilateral (force) close. */
  readonly commitmentLockCodeHash: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: 'testnet',
    ckbRpcUrl: 'https://testnet.ckbapp.dev/',
    fundingLockCodeHash: '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c',
    commitmentLockCodeHash: '0x740dee83f87c6f309824d8fd3fbdd3c8380ee6fc9acc90b1a748438afcdf81d8',
  },
  mainnet: {
    name: 'mainnet',
    // No public default: mainnet fnn ships with http://127.0.0.1:8114/, i.e. your own node.
    ckbRpcUrl: 'http://127.0.0.1:8114/',
    fundingLockCodeHash: '0xe45b1f8f21bff23137035a3ab751d75b36a981deec3e7820194b9c042967f4f1',
    commitmentLockCodeHash: '0x2d45c4d3ed3e942f1945386ee82a5d1b7e4bb16d7fe1ab015421174ab747406c',
  },
};

export function loadConfig(): NetworkConfig & { dbPath: string; concurrency: number } {
  const name = (process.env.FIBER_NETWORK ?? 'testnet') as NetworkName;
  const base = NETWORKS[name];
  if (!base) {
    throw new Error(`unknown FIBER_NETWORK "${name}" (expected: testnet | mainnet)`);
  }
  return {
    ...base,
    ckbRpcUrl: process.env.CKB_RPC_URL ?? base.ckbRpcUrl,
    dbPath: process.env.FIBER_ATLAS_DB ?? `./data/fiber-atlas.${name}.db`,
    concurrency: Number(process.env.SCAN_CONCURRENCY ?? 8),
  };
}
