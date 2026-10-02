#!/bin/bash
# Installs claude-desktop-accounts straight from GitHub. Same as: npx claude-desktop-accounts
#
#   curl -fsSL https://raw.githubusercontent.com/5eanxlee/claude-desktop-accounts/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/5eanxlee/claude-desktop-accounts/main/install.sh | bash -s -- --no-sync
#
# Options are passed to the installer: --no-sync, --no-app, --yes (see --help).
set -euo pipefail
command -v node >/dev/null || { echo "Node.js 22 or newer is required: brew install node, or https://nodejs.org" >&2; exit 1; }
here=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); fi
if [ -n "$here" ] && [ -f "$here/bin/cli.js" ]; then exec node "$here/bin/cli.js" install "$@"; fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/5eanxlee/claude-desktop-accounts/tar.gz/refs/heads/main" | tar -xz -C "$tmp" --strip-components 1
node "$tmp/bin/cli.js" install "$@"
