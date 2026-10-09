#!/bin/sh
# Renders the Open Graph cards (1200x630) from og.html with headless Chrome.
set -e
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
mkdir -p ../../public/og
for lang in vi en; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --window-size=1200,630 --virtual-time-budget=3000 \
    --screenshot="$PWD/../../public/og/og-$lang.png" "file://$PWD/og.html#$lang" >/dev/null 2>&1
done
ls -la ../../public/og
