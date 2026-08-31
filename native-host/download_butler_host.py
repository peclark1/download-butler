#!/usr/bin/env python3
"""Download Butler native-messaging host.

v0.2 targets macOS for native UI. The message protocol and file-move layer are
kept platform-neutral so Windows/Linux backends can implement the same actions.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import time
import uuid

HOST_NAME = "com.downloadbutler.host"
APP_NAME = "Download Butler"
VERSION = "0.2.0"
TICKET_MAX_AGE_SECONDS = 24 * 60 * 60
MAX_BATCH_ITEMS = 250


def app_support_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    if sys.platform.startswith("win"):
        root = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(root) / APP_NAME
    root = os.environ.get("XDG_CONFIG_HOME")
    return Path(root) / "download-butler" if root else Path.home() / ".config" / "download-butler"


STATE_DIR = app_support_dir()
STATE_FILE = STATE_DIR / "state.json"


def log(*parts: object) -> None:
    print("[Download Butler host]", *parts, file=sys.stderr, flush=True)


def load_state() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("state root is not an object")
    except FileNotFoundError:
        data = {}
    except Exception as exc:
        log("Could not read state:", exc)
        data = {}

    data.setdefault("lastDir", "")
    data.setdefault("siteDirs", {})
    data.setdefault("recentDirs", [])
    data.setdefault("tickets", {})
    prune_tickets(data)
    return data


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temp, STATE_FILE)


def prune_tickets(state: dict) -> None:
    now = time.time()
    tickets = state.get("tickets", {})
    state["tickets"] = {
        key: value
        for key, value in tickets.items()
        if isinstance(value, dict) and now - float(value.get("created", 0)) < TICKET_MAX_AGE_SECONDS
    }


def read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        return None
    if len(raw_len) != 4:
        raise RuntimeError("truncated native-message length")
    (length,) = struct.unpack("@I", raw_len)
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise RuntimeError("truncated native-message payload")
    return json.loads(payload.decode("utf-8"))


def write_message(message: dict) -> None:
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def existing_initial_dir(state: dict, site_key: str, remember_per_site: bool) -> Path:
    candidates: list[str] = []
    if remember_per_site and site_key:
        candidates.append(str(state.get("siteDirs", {}).get(site_key, "")))
    candidates.append(str(state.get("lastDir", "")))
    candidates.append(str(Path.home() / "Downloads"))
    candidates.append(str(Path.home()))

    for raw in candidates:
        if raw:
            path = Path(raw).expanduser()
            if path.is_dir():
                return path
    return Path.home()


def run_chrome_jxa(script: str, *args: str) -> str:
    proc = subprocess.run(
        ["/usr/bin/osascript", "-l", "JavaScript", "-e", script, *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"osascript exited with {proc.returncode}")
    return proc.stdout.rstrip("\r\n")


def choose_destination_macos(filename: str, initial_dir: Path) -> str | None:
    script = r'''
function run(argv) {
    var chrome = Application("Google Chrome");
    chrome.includeStandardAdditions = true;
    chrome.activate();

    try {
        var chosenFile = chrome.chooseFileName({
            withPrompt: "Save download as:",
            defaultName: argv[1],
            defaultLocation: Path(argv[0])
        });
        return chosenFile.toString();
    } catch (err) {
        if (err && (err.errorNumber === -128 || /-128/.test(String(err)))) {
            return "__DOWNLOAD_BUTLER_CANCELLED__";
        }
        throw err;
    }
}
'''
    result = run_chrome_jxa(script, str(initial_dir), filename)
    if result == "__DOWNLOAD_BUTLER_CANCELLED__":
        return None
    if not result:
        raise RuntimeError("macOS Save As dialog returned an empty path")
    return result


def choose_folder_macos(initial_dir: Path) -> str | None:
    script = r'''
function run(argv) {
    var chrome = Application("Google Chrome");
    chrome.includeStandardAdditions = true;
    chrome.activate();

    try {
        var chosenFolder = chrome.chooseFolder({
            withPrompt: "Choose a folder for these downloads:",
            defaultLocation: Path(argv[0])
        });
        return chosenFolder.toString();
    } catch (err) {
        if (err && (err.errorNumber === -128 || /-128/.test(String(err)))) {
            return "__DOWNLOAD_BUTLER_CANCELLED__";
        }
        throw err;
    }
}
'''
    result = run_chrome_jxa(script, str(initial_dir))
    if result == "__DOWNLOAD_BUTLER_CANCELLED__":
        return None
    if not result:
        raise RuntimeError("macOS folder chooser returned an empty path")
    return result


def choose_destination(filename: str, initial_dir: Path) -> str | None:
    if sys.platform == "darwin":
        return choose_destination_macos(filename, initial_dir)
    raise RuntimeError("The native Save As dialog is currently implemented on macOS only.")


def choose_folder(initial_dir: Path) -> str | None:
    if sys.platform == "darwin":
        return choose_folder_macos(initial_dir)
    raise RuntimeError("The native folder chooser is currently implemented on macOS only.")


def safe_filename_component(raw: str) -> str:
    name = Path(str(raw or "download").replace("\\", "/")).name
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name)
    name = name.rstrip(". ")
    if not name or set(name) == {"."}:
        name = "download"
    return name[:180]


def staging_filename(download_id: str, original_filename: str) -> str:
    suffix = Path(original_filename).suffix
    if len(suffix) > 20 or any(ch in suffix for ch in "/\\"):
        suffix = ""
    token = uuid.uuid4().hex[:12]
    safe_id = "".join(ch for ch in download_id if ch.isdigit())[:20] or "0"
    return f"DownloadButler-{safe_id}-{token}{suffix}"


def remember_directory(state: dict, directory: Path, site_key: str, remember_per_site: bool) -> None:
    folder = str(directory)
    state["lastDir"] = folder
    if remember_per_site and site_key:
        state.setdefault("siteDirs", {})[site_key] = folder
    recent = [p for p in state.get("recentDirs", []) if p != folder]
    state["recentDirs"] = [folder, *recent][:12]


def remember_destination(state: dict, destination: Path, site_key: str, remember_per_site: bool) -> None:
    remember_directory(state, destination.parent, site_key, remember_per_site)


def unique_destination(folder: Path, requested_name: str, reserved: set[str]) -> Path:
    name = safe_filename_component(requested_name)
    candidate = folder / name
    key = candidate.name.casefold()
    if not candidate.exists() and key not in reserved:
        reserved.add(key)
        return candidate

    suffix = candidate.suffix
    stem = candidate.stem or "download"
    for number in range(1, 10000):
        alternate = folder / f"{stem} ({number}){suffix}"
        key = alternate.name.casefold()
        if not alternate.exists() and key not in reserved:
            reserved.add(key)
            return alternate
    raise RuntimeError(f"Could not find a unique filename for {requested_name}")


def new_ticket(
    state: dict,
    *,
    destination: Path,
    filename: str,
    download_id: str,
    stage_name: str,
    batch_id: str = "",
) -> str:
    ticket = uuid.uuid4().hex
    state.setdefault("tickets", {})[ticket] = {
        "destinationPath": str(destination),
        "filename": filename,
        "downloadId": download_id,
        "stagingFilename": stage_name,
        "batchId": batch_id,
        "created": time.time(),
    }
    return ticket


def handle_choose(message: dict, state: dict) -> dict:
    filename = safe_filename_component(str(message.get("filename") or "download"))
    site_key = str(message.get("siteKey") or "").lower().strip()
    remember_per_site = bool(message.get("rememberPerSite"))
    download_id = str(message.get("downloadId") or "")

    initial_dir = existing_initial_dir(state, site_key, remember_per_site)
    selected = choose_destination(filename, initial_dir)
    if selected is None:
        return {"ok": False, "cancelled": True}

    destination = Path(selected).expanduser()
    remember_destination(state, destination, site_key, remember_per_site)

    stage_name = staging_filename(download_id, filename)
    ticket = new_ticket(
        state,
        destination=destination,
        filename=filename,
        download_id=download_id,
        stage_name=stage_name,
    )
    save_state(state)

    return {
        "ok": True,
        "destinationPath": str(destination),
        "ticket": ticket,
        "stagingFilename": stage_name,
        "lastDir": str(destination.parent),
    }


def handle_prepare_batch(message: dict, state: dict) -> dict:
    raw_items = message.get("items") or []
    if not isinstance(raw_items, list) or not raw_items:
        raise RuntimeError("batch contains no files")
    if len(raw_items) > MAX_BATCH_ITEMS:
        raise RuntimeError(f"batch is limited to {MAX_BATCH_ITEMS} files")

    site_key = str(message.get("siteKey") or "").lower().strip()
    remember_per_site = bool(message.get("rememberPerSite"))
    batch_id = str(message.get("batchId") or uuid.uuid4().hex)

    initial_dir = existing_initial_dir(state, site_key, remember_per_site)
    selected = choose_folder(initial_dir)
    if selected is None:
        return {"ok": False, "cancelled": True}

    directory = Path(selected).expanduser()
    if not directory.is_dir():
        raise RuntimeError(f"selected destination is not a directory: {directory}")
    remember_directory(state, directory, site_key, remember_per_site)

    reserved_names: set[str] = set()
    prepared: list[dict] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        url = str(raw.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            continue
        requested_name = safe_filename_component(str(raw.get("filename") or "download"))
        destination = unique_destination(directory, requested_name, reserved_names)
        stage_name = staging_filename("batch", destination.name)
        ticket = new_ticket(
            state,
            destination=destination,
            filename=destination.name,
            download_id="",
            stage_name=stage_name,
            batch_id=batch_id,
        )
        prepared.append({
            "url": url,
            "targetFilename": destination.name,
            "destinationPath": str(destination),
            "stagingFilename": stage_name,
            "ticket": ticket,
        })

    if not prepared:
        raise RuntimeError("batch did not contain any supported http/https downloads")

    save_state(state)
    return {
        "ok": True,
        "directoryPath": str(directory),
        "items": prepared,
    }


def validate_staging_path(staging: Path, ticket_info: dict) -> None:
    expected_stage_name = str(ticket_info.get("stagingFilename") or "")
    expected_id = str(ticket_info.get("downloadId") or "")

    if expected_stage_name:
        if staging.name != expected_stage_name:
            raise RuntimeError("staging filename did not match the approved download")
        prefix = f"DownloadButler-{expected_id}-" if expected_id else "DownloadButler-"
        if not staging.name.startswith(prefix):
            raise RuntimeError("staging download id did not match the approved download")
        return

    expected_name = str(ticket_info.get("filename") or "")
    if staging.name != expected_name:
        raise RuntimeError("staging filename did not match the approved download")
    parent = staging.parent
    if expected_id and parent.name != expected_id:
        raise RuntimeError("staging download id did not match the approved download")
    if parent.parent.name != ".download-butler":
        raise RuntimeError("refusing to move a file outside Download Butler's staging directory")


def remove_empty_staging_dirs(staging: Path) -> None:
    for folder in [staging.parent, staging.parent.parent]:
        try:
            folder.rmdir()
        except OSError:
            pass


def handle_commit(message: dict, state: dict) -> dict:
    ticket = str(message.get("ticket") or "")
    staging = Path(str(message.get("stagingPath") or "")).expanduser()
    info = state.get("tickets", {}).get(ticket)
    if not info:
        raise RuntimeError("download authorization ticket is missing or expired")

    validate_staging_path(staging, info)
    if not staging.is_file():
        raise RuntimeError(f"completed staging file does not exist: {staging}")

    destination = Path(str(info["destinationPath"])).expanduser()
    if not destination.parent.is_dir():
        raise RuntimeError(f"destination folder no longer exists: {destination.parent}")

    if destination.exists():
        if destination.is_dir():
            raise RuntimeError("destination is a directory, not a file")
        destination.unlink()

    shutil.move(str(staging), str(destination))
    if staging.parent.name.isdigit() and staging.parent.parent.name == ".download-butler":
        remove_empty_staging_dirs(staging)

    state.get("tickets", {}).pop(ticket, None)
    save_state(state)
    return {"ok": True, "destinationPath": str(destination)}


def handle_reveal(message: dict) -> dict:
    path = Path(str(message.get("path") or "")).expanduser()
    if sys.platform == "darwin":
        target = path if path.exists() else path.parent
        subprocess.Popen(["/usr/bin/open", "-R", str(target)])
        return {"ok": True}
    raise RuntimeError("Reveal is currently implemented on macOS only")


def handle_status(state: dict) -> dict:
    return {
        "ok": True,
        "host": HOST_NAME,
        "platform": "macOS" if sys.platform == "darwin" else sys.platform,
        "lastDir": state.get("lastDir", ""),
        "recentDirs": state.get("recentDirs", [])[:12],
        "version": VERSION,
    }


def dispatch(message: dict) -> dict:
    state = load_state()
    action = message.get("action")
    if action == "choose_destination":
        return handle_choose(message, state)
    if action == "prepare_batch":
        return handle_prepare_batch(message, state)
    if action == "commit_download":
        return handle_commit(message, state)
    if action == "reveal_path":
        return handle_reveal(message)
    if action == "status":
        return handle_status(state)
    raise RuntimeError(f"unknown action: {action!r}")


def main() -> int:
    try:
        message = read_message()
        if message is None:
            return 0
        write_message(dispatch(message))
        return 0
    except Exception as exc:
        log(type(exc).__name__ + ":", exc)
        try:
            write_message({"ok": False, "error": str(exc)})
        except Exception as write_exc:
            log("Could not write error response:", write_exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
