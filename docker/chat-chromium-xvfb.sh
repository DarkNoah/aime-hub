#!/bin/sh
set -eu

# Resolve the same browser revision installed by the server image.
chromium=$(node -p "require('/opt/playwright-core').chromium.executablePath()")
exec xvfb-run --auto-servernum "$chromium" "$@"
