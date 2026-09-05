#!/usr/bin/env bash
# Clone or update the nutshell-skills checkout this plugin reads from.
# Everything else is derived; this is the only network step.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${NUTSHELL_SKILLS_PATH:-${root}/.cache/nutshell-skills}"
repo="${NUTSHELL_SKILLS_REPO:-tidbcloud/nutshell-skills}"

if [[ -d "${dest}/.git" ]]; then
    echo "updating ${dest}"
    git -C "${dest}" pull --ff-only
else
    echo "cloning ${repo} -> ${dest}"
    mkdir -p "$(dirname "${dest}")"
    if command -v gh >/dev/null 2>&1; then
        gh repo clone "${repo}" "${dest}" -- --depth 1
    else
        git clone --depth 1 "git@github.com:${repo}.git" "${dest}"
    fi
fi

echo "source at ${dest} ($(git -C "${dest}" rev-parse --short HEAD))"
