#!/usr/bin/env bash
# Idempotent, non-interactive bootstrap for Cursor Cloud Agents.
# Installs the pinned Node.js and npm toolchain, locked dependencies, and
# the native tools the default Linux checks use. Does not install Hopper,
# Ghidra, or IDA, and does not call model APIs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Node lives here, not under /usr. Setup records process.execPath, and the
# suite rejects a command path that starts with /usr. Symlinks in
# /usr/local/bin still put node and npm on the default PATH; execPath follows
# the symlink back to this prefix.
NODE_PREFIX="/opt/nodejs"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "error: .cursor/install.sh supports Linux cloud agents only (found $(uname -s))." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64 | arm64) NODE_ARCH="arm64" ;;
  *)
    echo "error: unsupported architecture $(uname -m)." >&2
    exit 1
    ;;
esac

need_sudo() {
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true; then
    echo "error: ${1} and passwordless sudo is unavailable." >&2
    exit 1
  fi
}

install_apt() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v xz >/dev/null 2>&1 || missing+=(xz-utils)
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  command -v ps >/dev/null 2>&1 || missing+=(procps)
  command -v gcc >/dev/null 2>&1 || missing+=(build-essential)
  [[ -f /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)
  if [[ ${#missing[@]} -eq 0 ]]; then
    return 0
  fi
  need_sudo "missing packages (${missing[*]})"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
}

link_toolchain() {
  local cmd
  need_sudo "linking node into /usr/local/bin"
  for cmd in node npm npx; do
    sudo ln -sfn "${NODE_PREFIX}/bin/${cmd}" "/usr/local/bin/${cmd}"
  done
}

install_node() {
  local version archive url tmp
  version="$(tr -d '[:space:]' < .nvmrc)"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: .nvmrc must contain a plain Node.js version, found '${version}'." >&2
    exit 1
  fi
  if [[ -x "${NODE_PREFIX}/bin/node" ]] && [[ "$("${NODE_PREFIX}/bin/node" -v)" == "v${version}" ]]; then
    link_toolchain
    return 0
  fi
  need_sudo "Node.js ${version} is not installed at ${NODE_PREFIX}"
  archive="node-v${version}-linux-${NODE_ARCH}.tar.xz"
  url="https://nodejs.org/dist/v${version}/${archive}"
  tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "${tmp}/${archive}"
  curl -fsSL "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt"
  (
    cd "$tmp"
    grep -F "  ${archive}" SHASUMS256.txt | sha256sum -c -
  )
  sudo mkdir -p "$NODE_PREFIX"
  sudo tar -xJf "${tmp}/${archive}" -C "$NODE_PREFIX" --strip-components=1 --no-same-owner
  rm -rf "$tmp"
  if [[ "$("${NODE_PREFIX}/bin/node" -v)" != "v${version}" ]]; then
    echo "error: expected Node.js v${version} at ${NODE_PREFIX}/bin/node, found $("${NODE_PREFIX}/bin/node" -v)." >&2
    exit 1
  fi
  link_toolchain
}

activate_npm() {
  local spec version
  spec="$("${NODE_PREFIX}/bin/node" -p "require('./package.json').packageManager")"
  if [[ "$spec" != npm@* ]]; then
    echo "error: package.json#packageManager must be npm@<version>, found '${spec}'." >&2
    exit 1
  fi
  version="${spec#npm@}"
  version="${version%%+*}"
  export PATH="${NODE_PREFIX}/bin:/usr/local/bin:${PATH}"
  # A real npm binary, not a corepack shim. Corepack's last-known npm can move
  # to a newer major when a command runs outside this package, and that changes
  # npm pack --json.
  if [[ "$("${NODE_PREFIX}/bin/npm" -v)" == "$version" ]]; then
    link_toolchain
    return 0
  fi
  need_sudo "npm ${version} is not active"
  sudo env PATH="${NODE_PREFIX}/bin:${PATH}" npm_config_update_notifier=false \
    "${NODE_PREFIX}/bin/npm" install -g "npm@${version}"
  hash -r
  link_toolchain
  if [[ "$("${NODE_PREFIX}/bin/npm" -v)" != "$version" ]]; then
    echo "error: expected npm ${version}, found $("${NODE_PREFIX}/bin/npm" -v)." >&2
    exit 1
  fi
}

# No model API key is required to install or to run typecheck, lint, test, or
# build. Optional live-client verifiers use local CLIs and fixture keys and are
# not part of this bootstrap. If a later step needs a secret, read that named
# environment variable and warn when it is unset; do not fail install for it.

install_apt
install_node
activate_npm
export PATH="${NODE_PREFIX}/bin:/usr/local/bin:${PATH}"
export npm_config_update_notifier=false
npm ci

echo "install ok: node $(node -v) ($(node -p process.execPath)), npm $(npm -v), python3 $(python3 --version)"
