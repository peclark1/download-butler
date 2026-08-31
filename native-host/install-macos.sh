#!/bin/bash
set -euo pipefail

HOST_NAME="com.downloadbutler.host"
EXTENSION_ID="dgapakllfejieilepaagdcidcjempiml"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "Download Butler needs Python 3 for this prototype."
  echo "Install Python 3 (for example with Homebrew), then run this installer again."
  exit 1
fi

APP_DIR="$HOME/Library/Application Support/Download Butler"
HOST_DIR="$APP_DIR/host"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_PY="$HOST_DIR/download_butler_host.py"
HOST_WRAPPER="$HOST_DIR/download_butler_host"
MANIFEST="$NM_DIR/$HOST_NAME.json"

mkdir -p "$HOST_DIR" "$NM_DIR"
cp "$SCRIPT_DIR/download_butler_host.py" "$HOST_PY"
chmod 755 "$HOST_PY"

cat > "$HOST_WRAPPER" <<EOF
#!/bin/sh
exec "$PYTHON_BIN" "$HOST_PY" "\$@"
EOF
chmod 755 "$HOST_WRAPPER"

cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Download Butler native helper",
  "path": "$HOST_WRAPPER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

cat <<EOF
Download Butler native helper installed.

Extension ID: $EXTENSION_ID
Native host:  $HOST_WRAPPER
Manifest:     $MANIFEST
Python:       $PYTHON_BIN

Next:
  1. Open chrome://extensions
  2. Turn on Developer mode
  3. Click "Load unpacked"
  4. Select the project's extension folder
  5. Confirm the extension ID is $EXTENSION_ID
  6. In Chrome Settings > Downloads, turn OFF Chrome's own
     "Ask where to save each file before downloading" option.

Then download a small test file. Download Butler should show the Save As dialog.
For batch mode, select several linked files on a page, Control-click the selection,
and choose "Download links in selection with Butler…".
EOF
