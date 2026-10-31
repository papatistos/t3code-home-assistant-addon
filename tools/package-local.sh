#!/bin/bash
# Export committed add-on source without development credentials or Git metadata.
set -euo pipefail
set -o noclobber

repo=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
output=${1:?Usage: tools/package-local.sh /absolute/path/to/new-archive.tar.gz}
if ! git -C "$repo" diff --quiet HEAD -- t3code; then
    echo "Commit the add-on changes before packaging." >&2
    exit 1
fi
git -C "$repo" archive --format=tar --prefix=t3code/ HEAD:t3code | gzip -n > "$output"
shasum -a 256 "$output"
