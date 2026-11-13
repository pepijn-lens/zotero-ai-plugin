#!/bin/bash
# Packages the plugin as dist/research-buddy.xpi.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/research-buddy.xpi
zip -qr dist/research-buddy.xpi manifest.json bootstrap.js src content prompts
echo "Built $(pwd)/dist/research-buddy.xpi"
