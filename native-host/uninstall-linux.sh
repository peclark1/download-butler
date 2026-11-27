#!/usr/bin/env bash
set -euo pipefail
if [[ "$EUID" == 0 ]]; then
    echo "Run as your regular desktop user, not root." >&2
    exit 1
fi
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
for browser in google-chrome chromium; do
    rm -f -- "$CONFIG/$browser/NativeMessagingHosts/com.downloadbutler.host.json"
done
for file in download_butler_host download_butler_host.py download_butler_host_v03.py; do
    rm -f -- "$CONFIG/download-butler/host/$file"
done
rmdir -- "$CONFIG/download-butler/host" 2>/dev/null || true
echo "Download Butler helper removed; saved folder history retained."
