# Download Butler

Download Butler is a Chrome extension plus a small local native helper that provides a more useful download workflow than Chrome's built-in download settings.

The current release is **v0.2.0**, with a macOS native helper. The extension/native-host protocol is designed so Windows and Linux helpers can be added without rewriting the Chrome extension.

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

An optional setting remembers a different last-used folder per website.

### Batch-download links from a selection

v0.2.0 adds a batch workflow for pages containing lists of downloadable files:

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

## Why there is a native helper

Chrome's Downloads API allows an extension to suggest a filename only relative to Chrome's configured Downloads directory. It does not allow an extension to directly choose an arbitrary absolute filesystem path.

The native helper therefore handles two jobs:

- displaying the platform-native save/folder chooser;
- moving the completed Chrome download to the approved destination.

Chrome still performs the actual network download, preserving Chrome's cookies, authentication, redirects, generated downloads, and normal security behavior.

## Install on macOS

### 1. Install the native helper

From Terminal, change into the project's `native-host` directory and run:

```bash
./install-macos.sh
```

The installer locates Python 3 and installs the Chrome Native Messaging host manifest for the fixed development extension ID.

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

Download a small file. Download Butler should display the macOS Save As panel. Choose a destination and verify that the completed file appears there.

Then try the batch feature by selecting several file links on a page and using **Download links in selection with Butler…** from the context menu.

## Extension popup

The toolbar popup currently provides:

- native-helper connection status;
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
  download_butler_host.py
  install-macos.sh
  uninstall-macos.sh
```

## Roadmap

Useful next steps include:

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
