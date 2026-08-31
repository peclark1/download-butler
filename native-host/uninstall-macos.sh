#!/bin/bash
set -euo pipefail
HOST_NAME="com.downloadbutler.host"
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"
rm -rf "$HOME/Library/Application Support/Download Butler/host"
echo "Download Butler native helper removed. Saved folder history/state was left in place."
