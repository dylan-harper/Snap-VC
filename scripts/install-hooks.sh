#!/bin/sh
set -eu

project_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
git -C "$project_root" config core.hooksPath .githooks
printf '%s\n' "Git hooks installed: .githooks"
