#!/usr/bin/env bash
# Install the router into OpenCode and Codex.
#
# The catalog, overlay, retriever, verifier and trajectory are shared verbatim -
# only the command files differ, and those are generated. Regenerate them with
# `node scripts/export-adapters.mjs` after editing anything in commands/.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

link() {  # link <src> <dest>
    mkdir -p "$(dirname "$2")"
    rm -rf "$2"
    ln -s "$1" "$2"
    echo "  $2 -> $1"
}

echo "opencode:"
link "${root}/skills/tidb-aio-router" "${HOME}/.config/opencode/skills/tidb-aio-router"
mkdir -p "${HOME}/.config/opencode/command"
cp "${root}"/adapters/opencode/command/*.md "${HOME}/.config/opencode/command/"
echo "  commands copied to ~/.config/opencode/command/"

echo "codex:"
link "${root}/skills/tidb-aio-router" "${HOME}/.codex/skills/tidb-aio-router"
mkdir -p "${HOME}/.codex/prompts"
cp "${root}"/adapters/codex/prompts/*.md "${HOME}/.codex/prompts/"
echo "  prompts copied to ~/.codex/prompts/"

echo
echo "Add this to your shell profile so the generated commands can find the scripts:"
echo "  export TIDB_AIO_ROOT=\"${root}\""
