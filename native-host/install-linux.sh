#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Linux || "$EUID" == 0 ]]; then
    echo "Run this installer as your regular Linux desktop user, not root." >&2
    exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]] || ! "$PYTHON_BIN" -c 'import sys; assert sys.version_info >= (3, 10)'; then
    echo "Python 3.10 or newer is required." >&2
    exit 1
fi
for dependency in zenity xdg-open; do
    if ! command -v "$dependency" >/dev/null; then
        echo "Install dependencies: sudo apt install python3 zenity xdg-utils" >&2
        exit 1
    fi
done
"$PYTHON_BIN" - "$SCRIPT_DIR" <<'PY'
import json
import os
from pathlib import Path
import shlex
import shutil
import sys

source = Path(sys.argv[1])
config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config").expanduser().absolute()
host = config / "download-butler" / "host"
host.mkdir(parents=True, exist_ok=True)
for name in ("download_butler_host.py", "download_butler_host_v03.py"):
    shutil.copyfile(source / name, host / name)
wrapper = host / "download_butler_host"
wrapper.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " +
                   shlex.quote(str(host / "download_butler_host_v03.py")) + ' "$@"\n')
wrapper.chmod(0o755)
manifest = {
    "name": "com.downloadbutler.host",
    "description": "Download Butler native helper",
    "path": str(wrapper),
    "type": "stdio",
    "allowed_origins": ["chrome-extension://dgapakllfejieilepaagdcidcjempiml/"],
}
for browser in ("google-chrome", "chromium"):
    folder = config / browser / "NativeMessagingHosts"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "com.downloadbutler.host.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print("Registered:", path)
print("Native helper:", wrapper)
PY
echo "Load or reload the extension at chrome://extensions."
echo "Turn off Chrome's Ask where to save each file before downloading."
echo "Use Download Butler's popup to verify native helper status."
