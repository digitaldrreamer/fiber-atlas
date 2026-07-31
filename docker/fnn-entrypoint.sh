#!/bin/sh
# Observe-only Fiber node bootstrap.
#
# Fiber Atlas measures the network; it must not become part of it. Three properties
# are enforced here rather than left to a config file a future edit could relax:
#
#   1. We never announce ourselves. An announced observer injects a non-routable
#      phantom node into the very graph it is measuring.
#   2. We never auto-accept channels. Upstream defaults to contributing 99 CKB of our
#      own funds to any inbound channel above 100 CKB; zero disables it entirely.
#   3. Our wallet key is random and unfunded. This is the real guarantee — a key
#      holding nothing cannot spend regardless of how any flag is set. Configuration
#      is the second line of defence, not the first.
#
# Gossip needs none of this: it is a broadcast protocol over P2P connections, so a
# node with zero channels and zero CKB sees the whole public graph.
set -eu

NETWORK="${FIBER_NETWORK:-testnet}"
BASE_DIR="${FNN_BASE_DIR:-/data/fnn}"
CONFIG="${BASE_DIR}/config.yml"

case "$NETWORK" in
  testnet|mainnet) ;;
  *) echo "FIBER_NETWORK must be 'testnet' or 'mainnet', got '${NETWORK}'" >&2; exit 1 ;;
esac

if [ -z "${FIBER_SECRET_KEY_PASSWORD:-}" ]; then
  echo "FIBER_SECRET_KEY_PASSWORD is required — fnn encrypts ckb/key with it at startup." >&2
  echo "Set it in docker/.env (see .env.example). It is not optional even observe-only." >&2
  exit 1
fi

mkdir -p "${BASE_DIR}/ckb" "${BASE_DIR}/fiber"

# The upstream config carries the network's FundingLock / CommitmentLock code hashes
# and their cell_deps. Copying it rather than hand-maintaining our own guarantees the
# script hashes always match the pinned fnn version — SPEC-FAULTLINE §2.1 requires
# they be read from the node actually being run, never hardcoded across networks.
if [ ! -f "$CONFIG" ]; then
  cp "/opt/fnn/config/${NETWORK}/config.yml" "$CONFIG"

  # Mainnet upstream ships announce_listening_addr: true. Flip it, on both networks.
  sed -i 's|^\( *\)announce_listening_addr: .*|\1announce_listening_addr: false|' "$CONFIG"

  # Disable auto-accept.
  #
  # DO NOT DELETE THIS LINE THINKING IT REMOVES A FEATURE — it does the opposite.
  # auto_accept_channel_ckb_funding_amount belongs to fnn, not to us, and its default
  # is ON at 99 CKB. Upstream's config.yml omits the key entirely, so there is nothing
  # to edit and absence means "enabled". Inserting 0 is what turns it off; removing
  # the insert restores upstream's 99 CKB behaviour.
  sed -i '/^fiber:/a\  auto_accept_channel_ckb_funding_amount: 0' "$CONFIG"

  # The RPC stays on loopback, deliberately. fnn refuses to bind a public interface
  # without a biscuit keypair — that RPC controls funds, so the refusal is correct and
  # we do not work around it by configuring auth. The ingest container instead shares
  # this container's network namespace (`network_mode: service:` in compose.yml), so
  # it reaches 127.0.0.1:8227 while nothing on the Docker network can.

  if [ -n "${CKB_RPC_URL:-}" ]; then
    sed -i "s|^\( *\)rpc_url: .*|\1rpc_url: \"${CKB_RPC_URL}\"|" "$CONFIG"
  fi

  echo "generated ${CONFIG} for ${NETWORK}"
fi

# A fresh random key, never funded. fnn requires a wallet key to exist even when no
# channel is ever opened; it encrypts this file in place on first run.
if [ ! -f "${BASE_DIR}/ckb/key" ]; then
  openssl rand -hex 32 > "${BASE_DIR}/ckb/key"
  chmod 600 "${BASE_DIR}/ckb/key"
  echo "generated a new unfunded wallet key — do NOT send CKB to this node"
fi

echo "fnn $(fnn --version 2>/dev/null || echo '?') network=${NETWORK} observe-only"
grep -E 'announce_listening_addr|auto_accept_channel_ckb_funding_amount|chain:' "$CONFIG" || true

exec fnn -d "$BASE_DIR" "$@"
