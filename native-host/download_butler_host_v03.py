#!/usr/bin/env python3
"""Download Butler v0.3 native-host wrapper.

The v0.2 host remains the platform/file-move core. This wrapper adds portable
metadata sidecars and the folder index while keeping the native UI protocol
compatible with future Windows/Linux backends.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import re
import time
import uuid
from urllib.parse import quote

import download_butler_host as core

VERSION = "0.3.3"
METADATA_VERSION = 2
METADATA_SUFFIX = ".download-info.md"
INDEX_FILENAME = "Download Butler Index.md"
INDEX_LOCK_NAME = ".download-butler-index.lock"
HOST_STATE_LOCK_NAME = ".download-butler-host.lock"


def clean_text(value: object, limit: int = 4000) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def normalized_metadata(raw: dict | None) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "sourcePageTitle": clean_text(raw.get("sourcePageTitle"), 1000),
        "sourcePageUrl": clean_text(raw.get("sourcePageUrl"), 8000),
        "downloadUrl": clean_text(raw.get("downloadUrl"), 8000),
        "linkText": clean_text(raw.get("linkText"), 1000),
        "linkTitle": clean_text(raw.get("linkTitle"), 1000),
        "pageContext": clean_text(raw.get("pageContext"), 4000),
        "sectionTitle": clean_text(raw.get("sectionTitle"), 1000),
    }


def metadata_sidecar_path(destination: Path) -> Path:
    return destination.with_name(destination.name + METADATA_SUFFIX)


def destination_available(candidate: Path, reserved: set[str]) -> bool:
    key = candidate.name.casefold()
    sidecar_key = metadata_sidecar_path(candidate).name.casefold()
    protected = {INDEX_FILENAME.casefold(), INDEX_LOCK_NAME.casefold()}
    return (
        not candidate.exists()
        and not metadata_sidecar_path(candidate).exists()
        and key not in reserved
        and sidecar_key not in reserved
        and key not in protected
    )


def reserve_destination(candidate: Path, reserved: set[str]) -> None:
    reserved.add(candidate.name.casefold())
    reserved.add(metadata_sidecar_path(candidate).name.casefold())


def unique_destination(folder: Path, requested_name: str, reserved: set[str]) -> Path:
    name = core.safe_filename_component(requested_name)
    candidate = folder / name
    if destination_available(candidate, reserved):
        reserve_destination(candidate, reserved)
        return candidate

    suffix = candidate.suffix
    stem = candidate.stem or "download"
    for number in range(1, 10000):
        alternate = folder / f"{stem} ({number}){suffix}"
        if destination_available(alternate, reserved):
            reserve_destination(alternate, reserved)
            return alternate
    raise RuntimeError(f"Could not find a unique filename for {requested_name}")


def description_for(metadata: dict, filename: str) -> str:
    link_text = clean_text(metadata.get("linkText"), 1000)
    link_title = clean_text(metadata.get("linkTitle"), 1000)
    context = clean_text(metadata.get("pageContext"), 4000)
    url = clean_text(metadata.get("downloadUrl"), 8000)
    folded = filename.casefold()
    for candidate in (link_text, link_title):
        if candidate and candidate.casefold() != folded and candidate != url:
            return candidate
    return context or link_text or link_title


def yaml_string(value: object) -> str:
    # JSON double-quoted strings are valid YAML scalars and need no dependency.
    return json.dumps(str(value or ""), ensure_ascii=False)


def atomic_write(path: Path, content: str) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_text(content, encoding="utf-8")
        os.replace(temp, path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def angle_url(value: object) -> str:
    return clean_text(value, 8000).replace(">", "%3E")


def sidecar_document(destination: Path, metadata: dict, batch_id: str) -> str:
    metadata = normalized_metadata(metadata)
    filename = destination.name
    downloaded = datetime.now().astimezone().isoformat(timespec="seconds")
    file_size = destination.stat().st_size
    description = description_for(metadata, filename)

    lines = [
        "---",
        f"download_butler_metadata_version: {METADATA_VERSION}",
        f"filename: {yaml_string(filename)}",
        f"downloaded: {yaml_string(downloaded)}",
        f"file_size: {file_size}",
        f"description: {yaml_string(description)}",
        f"source_page_title: {yaml_string(metadata['sourcePageTitle'])}",
        f"section_title: {yaml_string(metadata['sectionTitle'])}",
        f"source_page_url: {yaml_string(metadata['sourcePageUrl'])}",
        f"download_url: {yaml_string(metadata['downloadUrl'])}",
        f"link_text: {yaml_string(metadata['linkText'])}",
        f"link_title: {yaml_string(metadata['linkTitle'])}",
        f"page_context: {yaml_string(metadata['pageContext'])}",
        f"batch_id: {yaml_string(batch_id)}",
        "---",
        "",
        f"# {filename}",
        "",
    ]
    if description:
        lines.extend([description, ""])
    lines.extend(["## Source", ""])
    if metadata["sectionTitle"]:
        lines.append(f"- **Section:** {metadata['sectionTitle']}")
    if metadata["sourcePageTitle"]:
        lines.append(f"- **Source page:** {metadata['sourcePageTitle']}")
    if metadata["sourcePageUrl"]:
        lines.append(f"- **Source page URL:** <{angle_url(metadata['sourcePageUrl'])}>")
    if metadata["downloadUrl"]:
        lines.append(f"- **Original file URL:** <{angle_url(metadata['downloadUrl'])}>")
    lines.extend([
        f"- **Downloaded:** {downloaded}",
        f"- **File size:** {file_size} bytes",
    ])
    if metadata["pageContext"]:
        lines.extend(["", "## Page context", "", metadata["pageContext"]])
    return "\n".join(lines).rstrip() + "\n"


def parse_sidecar(path: Path) -> dict | None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return None
    if not lines or lines[0].strip() != "---":
        return None

    record: dict[str, object] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip()
        if not key:
            continue
        try:
            record[key] = json.loads(value)
        except Exception:
            record[key] = value

    try:
        version = int(record.get("download_butler_metadata_version", 0))
    except (TypeError, ValueError):
        return None
    if version < 1 or not record.get("filename"):
        return None
    record["_sidecar"] = path.name
    return record


def table_text(value: object, limit: int = 240) -> str:
    return clean_text(value, limit).replace("|", "\\|")


def local_link(filename: str) -> str:
    label = filename.replace("[", "\\[").replace("]", "\\]")
    return f"[{label}]({quote(filename)})"


@contextmanager
def host_state_lock(timeout: float = 30.0):
    """Serialize native-host state mutations across sendNativeMessage processes."""
    core.STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock = core.STATE_DIR / HOST_STATE_LOCK_NAME
    deadline = time.monotonic() + timeout
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 120:
                    lock.rmdir()
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("timed out waiting for Download Butler native-host state")
            time.sleep(0.03)
    try:
        yield
    finally:
        try:
            lock.rmdir()
        except OSError:
            pass


@contextmanager
def index_lock(folder: Path, timeout: float = 10.0):
    lock = folder / INDEX_LOCK_NAME
    deadline = time.monotonic() + timeout
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 60:
                    lock.rmdir()
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("timed out waiting to update the Download Butler metadata index")
            time.sleep(0.05)
    try:
        yield
    finally:
        try:
            lock.rmdir()
        except OSError:
            pass


def rebuild_index(folder: Path) -> Path:
    index_path = folder / INDEX_FILENAME
    with index_lock(folder):
        records = []
        for sidecar in folder.glob(f"*{METADATA_SUFFIX}"):
            record = parse_sidecar(sidecar)
            if record:
                records.append(record)
        records.sort(key=lambda item: str(item.get("filename", "")).casefold())

        lines = [
            "# Download Butler Index",
            "",
            f"Automatically generated from `*{METADATA_SUFFIX}` sidecar files. The sidecars are the authoritative metadata records.",
            "",
        ]
        if records:
            lines.extend([
                "| File | Description | Section | Downloaded | Source page |",
                "| --- | --- | --- | --- | --- |",
            ])
            for record in records:
                filename = str(record.get("filename", ""))
                lines.append(
                    f"| {local_link(filename)} | {table_text(record.get('description', ''))} | "
                    f"{table_text(record.get('section_title', ''), 120)} | "
                    f"{table_text(record.get('downloaded', ''), 80)} | "
                    f"{table_text(record.get('source_page_title', ''), 120)} |"
                )
            lines.extend(["", "## Details", ""])
            for record in records:
                filename = str(record.get("filename", ""))
                description = clean_text(record.get("description", ""), 4000)
                context = clean_text(record.get("page_context", ""), 4000)
                lines.extend([f"### {filename}", ""])
                if description:
                    lines.extend([description, ""])
                if record.get("section_title"):
                    lines.append(f"- **Section:** {clean_text(record.get('section_title'), 1000)}")
                if record.get("source_page_title"):
                    lines.append(f"- **Source page:** {clean_text(record.get('source_page_title'), 1000)}")
                if record.get("source_page_url"):
                    lines.append(f"- **Source page URL:** <{angle_url(record.get('source_page_url'))}>")
                if record.get("download_url"):
                    lines.append(f"- **Original file URL:** <{angle_url(record.get('download_url'))}>")
                if record.get("downloaded"):
                    lines.append(f"- **Downloaded:** {clean_text(record.get('downloaded'), 100)}")
                lines.append(f"- **Metadata:** `{record.get('_sidecar', '')}`")
                if context and context != description:
                    lines.extend(["", "**Page context:**", "", context])
                lines.append("")
        else:
            lines.append("No Download Butler metadata records were found in this folder.")

        atomic_write(index_path, "\n".join(lines).rstrip() + "\n")
    return index_path


def write_metadata(destination: Path, metadata: dict, batch_id: str) -> tuple[Path, Path]:
    sidecar = metadata_sidecar_path(destination)
    atomic_write(sidecar, sidecar_document(destination, metadata, batch_id))
    return sidecar, rebuild_index(destination.parent)


def attach_metadata(state: dict, ticket: str, metadata: dict) -> None:
    info = state.get("tickets", {}).get(ticket)
    if info is not None:
        info["metadata"] = normalized_metadata(metadata)


def handle_choose(message: dict, state: dict) -> dict:
    response = core.handle_choose(message, state)
    if response.get("ok") and response.get("ticket"):
        ticket = response["ticket"]
        info = state.get("tickets", {}).get(ticket)
        save_metadata = bool(message.get("saveMetadata"))
        if info is not None:
            info["saveMetadata"] = save_metadata
        if save_metadata:
            attach_metadata(state, ticket, {
                "sourcePageUrl": message.get("sourcePageUrl") or "",
                "downloadUrl": message.get("url") or "",
            })
        core.save_state(state)
    return response


def handle_prepare_batch(message: dict, state: dict) -> dict:
    raw_items = message.get("items") or []
    if not isinstance(raw_items, list) or not raw_items:
        raise RuntimeError("batch contains no files")
    if len(raw_items) > core.MAX_BATCH_ITEMS:
        raise RuntimeError(f"batch is limited to {core.MAX_BATCH_ITEMS} files")

    site_key = str(message.get("siteKey") or "").lower().strip()
    remember_per_site = bool(message.get("rememberPerSite"))
    batch_id = str(message.get("batchId") or uuid.uuid4().hex)
    source_title = clean_text(message.get("sourcePageTitle"), 1000)
    source_url = clean_text(message.get("sourcePageUrl"), 8000)
    save_metadata = bool(message.get("saveMetadata", True))

    initial_dir = core.existing_initial_dir(state, site_key, remember_per_site)
    selected = core.choose_folder(initial_dir)
    if selected is None:
        return {"ok": False, "cancelled": True}

    directory = Path(selected).expanduser()
    if not directory.is_dir():
        raise RuntimeError(f"selected destination is not a directory: {directory}")
    core.remember_directory(state, directory, site_key, remember_per_site)

    reserved: set[str] = set()
    prepared = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        url = str(raw.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            continue
        destination = unique_destination(
            directory,
            core.safe_filename_component(str(raw.get("filename") or "download")),
            reserved,
        )
        stage_name = core.staging_filename("batch", destination.name)
        ticket = core.new_ticket(
            state,
            destination=destination,
            filename=destination.name,
            download_id="",
            stage_name=stage_name,
            batch_id=batch_id,
        )
        info = state.get("tickets", {}).get(ticket)
        if info is not None:
            info["saveMetadata"] = save_metadata
        if save_metadata:
            attach_metadata(state, ticket, {
                "sourcePageTitle": source_title,
                "sourcePageUrl": source_url,
                "downloadUrl": url,
                "linkText": raw.get("linkText") or "",
                "linkTitle": raw.get("linkTitle") or "",
                "pageContext": raw.get("pageContext") or "",
                "sectionTitle": raw.get("sectionTitle") or "",
            })
        prepared.append({
            "url": url,
            "targetFilename": destination.name,
            "destinationPath": str(destination),
            "stagingFilename": stage_name,
            "ticket": ticket,
        })

    if not prepared:
        raise RuntimeError("batch did not contain any supported http/https downloads")
    core.save_state(state)
    return {"ok": True, "directoryPath": str(directory), "items": prepared}


def handle_commit(message: dict, state: dict) -> dict:
    ticket = str(message.get("ticket") or "")
    info = dict(state.get("tickets", {}).get(ticket) or {})
    response = core.handle_commit(message, state)
    if not response.get("ok"):
        return response

    metadata_error = ""
    sidecar_path = ""
    index_path = ""
    if bool(info.get("saveMetadata", True)):
        try:
            destination = Path(str(response.get("destinationPath") or "")).expanduser()
            sidecar, index = write_metadata(
                destination,
                info.get("metadata") if isinstance(info.get("metadata"), dict) else {},
                str(info.get("batchId") or ""),
            )
            sidecar_path, index_path = str(sidecar), str(index)
        except Exception as exc:
            metadata_error = str(exc)
            core.log("File was saved, but metadata write failed:", exc)

    response.update({
        "metadataSidecarPath": sidecar_path,
        "metadataIndexPath": index_path,
        "metadataError": metadata_error,
    })
    return response


def dispatch(message: dict) -> dict:
    action = message.get("action")
    if action == "reveal_path":
        return core.handle_reveal(message)

    # chrome.runtime.sendNativeMessage starts a new helper process for each
    # request. Large batches can therefore produce many completion helpers at
    # once; serialize state access so their state.json updates cannot race.
    with host_state_lock():
        state = core.load_state()
        if action == "choose_destination":
            return handle_choose(message, state)
        if action == "prepare_batch":
            return handle_prepare_batch(message, state)
        if action == "commit_download":
            return handle_commit(message, state)
        if action == "status":
            response = core.handle_status(state)
            response["version"] = VERSION
            return response
        raise RuntimeError(f"unknown action: {action!r}")


def main() -> int:
    try:
        message = core.read_message()
        if message is None:
            return 0
        core.write_message(dispatch(message))
        return 0
    except Exception as exc:
        core.log(type(exc).__name__ + ":", exc)
        try:
            core.write_message({"ok": False, "error": str(exc)})
        except Exception as write_exc:
            core.log("Could not write error response:", write_exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
