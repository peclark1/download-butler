# Download Butler

Download Butler is a Chrome extension plus a small local native helper that provides a more useful download workflow than Chrome's built-in download settings.

The current release is **v0.3.0**, with a macOS native helper. The extension/native-host protocol is designed so Windows and Linux helpers can be added without rewriting the Chrome extension.

## Features

### Normal downloads

For ordinary Chrome-managed downloads, Download Butler:

1. Intercepts the download before Chrome chooses its final filename.
2. Opens a native macOS **Save As** dialog.
3. Starts in the folder where you last saved a file.
4. Lets you navigate anywhere macOS can access and optionally rename the file.
5. Lets Chrome perform the actual HTTP download to a short temporary staging filename in Chrome's configured Downloads directory.
6. Moves the completed file to the destination you selected.
7. Remembers that destination folder for the next download.
8. Writes portable source metadata beside the completed file and updates the folder's Download Butler index.

An optional setting remembers a different last-used folder per website.

### Batch-download links from a selection

Download Butler has a batch workflow for pages containing lists of downloadable files:

1. Select the lines or links you want on the page.
2. Control-click/right-click the selection.
3. Choose **Download links in selection with Butler…**.
4. Review the confirmation page listing the discovered HTTP/HTTPS links.
5. Uncheck unwanted items and optionally edit proposed filenames.
6. Click **Choose Folder & Download**.
7. Choose the destination folder once.
8. Download Butler downloads the whole batch into that directory without prompting for every file.

The selection scan recognizes normal `<a href>` links that intersect the selection as well as bare `http://` and `https://` URLs in selected text. Duplicate URLs are removed.

For batch downloads, existing destination names are not silently overwritten. Download Butler chooses `name (1).ext`, `name (2).ext`, and so on when necessary.

v0.3.0 also captures useful nearby page text for each selected link. It prefers the surrounding table row, list item, paragraph, definition item, figure caption, or immediate parent. That context is shown in the batch review page and saved with the file's provenance metadata.

### Durable source metadata

v0.3.0 preserves download provenance without modifying the downloaded file itself. By default Download Butler writes **both** a per-file sidecar and a human-readable folder index.

For example:

```text
KIMVol0001.pdf
KIMVol0001.pdf.download-info.md
Download Butler Index.md
```

The sidecar is the authoritative metadata record. It uses YAML front matter followed by ordinary readable Markdown. The schema starts with:

```yaml
download_butler_metadata_version: 1
```

Current metadata fields include:

- final filename;
- download timestamp;
- file size;
- source page title and URL when available;
- original/direct download URL;
- link text and link title;
- nearby page context for selection/batch downloads;
- batch identifier when applicable.

A typical sidecar looks like:

```markdown
---
download_butler_metadata_version: 1
filename: "KIMVol0001.pdf"
downloaded: "2026-08-30T21:56:23-05:00"
file_size: 123456
description: "KIM-1 User Notes Volume 1"
source_page_title: "KIM-1 Documentation Archive"
source_page_url: "https://example.org/kim1/"
download_url: "https://example.org/files/KIMVol0001.pdf"
link_text: "KIM-1 User Notes Volume 1"
link_title: ""
page_context: "KIM-1 User Notes Volume 1 — programming examples and hardware notes."
batch_id: "..."
---
```

`Download Butler Index.md` is regenerated from the sidecars in that directory. It contains a compact table plus detailed provenance for each Butler-managed file. The index writer is serialized with a short-lived directory lock so several batch downloads completing at nearly the same time do not overwrite one another's index entries.

The sidecars are intentionally plain text and portable. They are suitable for later consumption by cataloging software or a collection web navigator. If the folder index is lost, it can be regenerated from the sidecars; the downloaded file itself remains untouched.

Ordinary one-at-a-time downloads also receive sidecars. Those usually contain the direct download URL and Chrome's referrer information. The batch-selection workflow can capture richer descriptions because the explicit context-menu action grants temporary access to the selected page.

## Why there is a native helper

Chrome's Downloads API allows an extension to suggest a filename only relative to Chrome's configured Downloads directory. It does not allow an extension to directly choose an arbitrary absolute filesystem path.

The native helper therefore handles three jobs:

- displaying the platform-native save/folder chooser;
- moving the completed Chrome download to the approved destination;
- writing the local metadata sidecar and folder index.

Chrome still performs the actual network download, preserving Chrome's cookies, authentication, redirects, generated downloads, and normal security behavior.

## Install on macOS

### 1. Install the native helper

From Terminal, change into the project's `native-host` directory and run:

```bash
./install-macos.sh
```

The installer locates Python 3 and installs the Chrome Native Messaging host manifest for the fixed development extension ID. v0.3 installs the existing native/file-move core plus the v0.3 metadata wrapper.

### 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository's `extension` directory.
5. The extension ID should be:

   `dgapakllfejieilepaagdcidcjempiml`

The fixed development ID is intentional because the native host only accepts messages from this extension ID.

### 3. Disable Chrome's own Save As prompt

In **Chrome Settings → Downloads**, turn OFF:

**Ask where to save each file before downloading**

Download Butler supplies the prompt instead. Leaving Chrome's setting on can produce a second Chrome Save As dialog for the temporary staging file.

### 4. Test it

Download a small file. Download Butler should display the macOS Save As panel. Choose a destination and verify that the completed file appears there together with its `.download-info.md` sidecar and `Download Butler Index.md`.

Then try the batch feature by selecting several file links on a page and using **Download links in selection with Butler…** from the context menu. The review page should show captured link text, nearby page context, and the direct URL before you choose the destination folder.

## Extension popup

The toolbar popup currently provides:

- native-helper connection status and version;
- last-used folder;
- recent managed downloads;
- **Reveal** for recent files;
- enable/disable control;
- optional per-website folder memory;
- optional cleanup of Chrome's stale staging-file history entries.

## Staging and failure behavior

Chrome downloads each managed file to a short temporary name in its configured Downloads directory, for example:

```text
<Chrome Downloads>/DownloadButler-123-a82f19c401be.pdf
```

The helper generates the staging name and binds it to a one-time authorization ticket. Once Chrome reports the download complete, the helper moves the file to the selected destination.

The design favors visible failures instead of silently placing files in the wrong directory:

- If the native helper cannot be contacted, the extension records the error, displays an `!` badge, and cancels the download rather than silently falling back to Downloads.
- If you cancel Download Butler's Save As dialog, the Chrome download is cancelled.
- If the final move fails, the staging file is left in Chrome's Downloads directory and the error is shown in the extension popup.
- If the file move succeeds but metadata writing fails, the downloaded file is kept in the requested destination and the metadata failure is reported separately.

Pending download state is stored per download ID, preventing completion of one download from erasing the destination state of another rapid sequential download.

## Chrome download history

By default, Download Butler removes its completed Chrome download-history entry after moving the file because Chrome only knows the temporary staging path. Otherwise Chrome's **Open** action would point to a file that no longer exists there.

Download Butler maintains its own short recent-download list in the popup. Chrome-history cleanup can be disabled in the popup.

## Privacy and security

Everything is local. There is no server and no telemetry.

The native-host manifest accepts messages only from the fixed Download Butler extension ID. Each approved destination creates a one-time authorization ticket used by the helper when moving the completed staging file.

On macOS, local state is stored at:

```text
~/Library/Application Support/Download Butler/state.json
```

That state contains folder history, optional per-site folder choices, and short-lived authorization tickets. It does not contain downloaded file contents.

The batch selection scanner uses Chrome's temporary `activeTab` permission granted by the explicit context-menu action. The extension does not request permanent read access to every website.

## Project layout

```text
extension/
  manifest.json
  service-worker.js
  popup.html / popup.css / popup.js
  batch.html / batch.css / batch.js

native-host/
  download_butler_host.py       # native UI + file-move core
  download_butler_host_v03.py   # v0.3 metadata/provenance wrapper
  install-macos.sh
  uninstall-macos.sh
```

## Roadmap

Useful next steps include:

- teach the Computer Collection navigator/catalog to recognize `*.download-info.md`, hide sidecars from ordinary file listings, and display their provenance with the corresponding file;
- a proper macOS `NSSavePanel` branded as **Download Butler — Save As**;
- Windows native helper and installer;
- Linux native helper and installer;
- favorite destination folders;
- a recent-folder chooser;
- rules by website and/or file extension;
- optional **use last folder without asking** mode;
- optional destination subfolder rules.

## Uninstall the macOS helper

Run:

```bash
./uninstall-macos.sh
```

Then remove the unpacked extension from `chrome://extensions`.

The uninstall script intentionally leaves your saved folder-history state in place. Delete `~/Library/Application Support/Download Butler` if you also want to remove that state.
