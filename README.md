# Download Butler 0.3.3 — macOS prototype

Download Butler is a Chrome extension plus a small local native helper that gives Chrome a more useful download workflow:

1. A normal Chrome-managed download starts.
2. Download Butler shows a native macOS **Save As** dialog before Chrome chooses the filename.
3. The dialog starts in the folder where you last saved a file.
4. You may navigate anywhere macOS can save: another folder, mounted disk, network volume, etc., and you may rename the file.
5. Chrome downloads the bytes to a short temporary staging filename under its configured Downloads directory.
6. When Chrome reports the download complete, the native helper moves the file to the destination you selected.
7. That destination folder becomes the starting folder for the next Save As dialog.

The extension also has an optional **remember a folder per website** mode.




## New in 0.3.1: section/header capture

For selection downloads, Download Butler now records the nearest meaningful page heading for each selected link as `section_title`. This is intended for archive pages where many files belong to a named group such as a magazine, computer model, software family, or document section. The heading does not need to be part of the text selection; Butler looks backward from each selected link for the nearest semantic heading (`h1`–`h6`, ARIA heading, or table caption) and has a conservative fallback for older pages that use bold/enlarged blocks instead of semantic heading tags.

The batch confirmation page shows the detected section before downloading, and the value is written to each `.download-info.md` sidecar and to `Download Butler Index.md`. For example, files selected under a **Popular Electronics** heading will carry `section_title: "Popular Electronics"`.

## New in 0.3.0: durable download metadata

Download Butler now preserves provenance alongside managed downloads instead of leaving useful page information behind in the browser. By default it writes **both** a per-file metadata sidecar and a human-readable folder index.

For a file named `KIMVol0001.pdf`, Butler creates:

```text
KIMVol0001.pdf
KIMVol0001.pdf.download-info.md
Download Butler Index.md
```

The sidecar is the authoritative metadata record. It uses YAML front matter followed by ordinary readable Markdown. The current schema is identified by:

```yaml
download_butler_metadata_version: 2
```

Metadata includes the final filename, download timestamp, file size, source page title and URL, the nearest section/header title, original file URL, link text/title, nearby page context, and batch identifier when applicable. The downloaded file itself is never modified.

`Download Butler Index.md` is regenerated from the sidecars in the destination directory. It contains a compact table plus detailed source information for each Butler-managed file. This makes the metadata useful even without the extension and also gives archival/catalog software a stable format to consume.

For **selection/batch downloads**, v0.3.0 captures richer page context. Butler looks at the nearest table row, list item, paragraph, definition item, figure caption, or immediate parent surrounding each selected link and stores a compact version of that text. The confirmation page displays that context before the batch starts. This is particularly useful on archive and documentation pages where a cryptic filename is accompanied by a useful human description.

For ordinary one-at-a-time downloads, Butler still creates metadata, using the direct download URL and Chrome referrer information available for that download. Link text/page context is richer for the selection workflow because Butler is explicitly allowed to inspect the selected page after the context-menu action.

The metadata format is intentionally plain-text and portable so it can be consumed later by tools such as a collection catalog or web navigator. Sidecars should generally move with their corresponding files; if `Download Butler Index.md` is lost, it can be regenerated from the sidecars.

## New in 0.2.0: download all links in a selection

Download Butler now has a batch-download workflow for pages that contain lists of file links:

1. Select the lines/links you want on the web page.
2. Control-click/right-click the selection.
3. Choose **Download links in selection with Butler…**.
4. Butler opens a confirmation tab listing every HTTP/HTTPS link that intersects the selection.
5. Uncheck anything you do not want and optionally edit the proposed filenames.
6. Click **Choose Folder & Download**.
7. Choose the destination directory once.
8. Chrome downloads the whole batch and Butler moves each completed file into that directory.

The selection scan uses Chrome's temporary `activeTab` permission, granted by the explicit context-menu click. The extension does **not** request permanent access to every web page. Bare `http://` or `https://` URLs in selected text are recognized in addition to normal `<a href>` links.

For batch downloads, existing destination names are not overwritten silently. Butler chooses `name (1).ext`, `name (2).ext`, and so on when needed. The confirmation page intentionally shows the URL and makes the guessed filename editable because some sites use download URLs whose eventual server filename cannot be known before the request starts.

## 0.1.3 pending-download race fix

v0.1/v0.1.1 stored every active download inside one shared `pending` object in Chrome local storage. A completed download could read that object, another download could then add itself, and the first download's cleanup could finally write its stale copy back -- deleting the newer download's destination ticket. The newer file would then complete in Chrome's staging area instead of being moved to the selected destination.

v0.1.3 stores each active download under its own storage key (`pendingDownload:<id>`), so completion of one download cannot erase another download's state. It can also read and clean the old shared format so an in-flight v0.1.1 download is not abandoned during an update.

Download Butler also no longer silently lets Chrome continue to the ordinary Downloads folder when the native Save As helper fails. The download is cancelled instead and the toolbar icon gets an `!` badge; the actual error is shown in the popup. This makes destination failures visible rather than looking like Butler ignored the selected folder.

## 0.1.1 focus fix

The macOS Save As panel is now hosted in **Google Chrome's application context** and Chrome is explicitly activated immediately before the panel is shown. This fixes the case where a Control-click/context-menu download opened the panel visually but left keyboard focus behind on Chrome's context menu.

The filename field remains available for immediate editing, while **Save** remains the panel's default action, so pressing Return should save without first clicking the dialog. This approach does not require Accessibility permissions or simulated keystrokes.


## Metadata controls

Metadata is optional in v0.3.3:

- **Single-file downloads:** metadata is OFF by default and can be enabled with **Save metadata for single-file downloads** in the extension popup.
- **Batch downloads:** the confirmation page has a **Save metadata + folder index** checkbox. It defaults ON and remembers your last batch choice.

Disabling metadata does not change the normal save/move workflow; it only skips creation of the `.download-info.md` sidecar and `Download Butler Index.md`.

## Why there is a native helper

Chrome's downloads API lets an extension change a download filename only *relative to Chrome's configured Downloads directory*. It does not let an extension directly name an arbitrary absolute path elsewhere on the computer. The helper provides the native Save As window and performs the final local file move.

Chrome still performs the actual HTTP download. That means cookies, authenticated downloads, redirects, POST-generated downloads, blob downloads, and Chrome's normal download security behavior remain Chrome's responsibility.

## Install on macOS

### 1. Install the native helper

From Terminal, `cd` into this project's `native-host` directory and run:

```bash
./install-macos.sh
```

The prototype uses Python 3 for the native-messaging process. The installer records the absolute path to your Python executable so Chrome does not depend on its GUI-process `PATH`.

### 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project's `extension` directory.
5. The extension ID should be:

   `dgapakllfejieilepaagdcidcjempiml`

The fixed development ID is intentional; the native messaging host is allowed to accept messages only from this extension ID.

### 3. Turn off Chrome's own Save As prompt

In **Chrome Settings → Downloads**, turn OFF:

**Ask where to save each file before downloading**

Download Butler supplies the prompt instead. Leaving Chrome's setting on may result in a second Chrome Save As dialog for the staging file.

### 4. Test it

Download a small file from a web page. You should get a macOS Save As dialog. Choose a location. After the download completes, the file should appear at the selected location.

Click the Download Butler toolbar icon to see:

- native-helper connection status
- the last-used folder
- recent managed downloads
- a **Reveal** button for recent files
- enable/disable setting
- per-website folder-memory setting
- Chrome download-history cleanup setting

## What happens to Chrome's download history?

By default, Download Butler removes the completed entry from Chrome's download history after moving it. This is because Chrome only knows the temporary staging path and would otherwise retain a stale **Open** action pointing to a file that has moved.

Download Butler keeps its own short recent-download list in the extension popup. You can turn Chrome-history cleanup off from the popup if you prefer.

## Failure behavior

The design favors not losing downloads:

- If the native helper cannot be contacted before a download starts, the extension records the error, shows an `!` badge, and cancels that download rather than silently saving it to Chrome's default Downloads folder.
- If you cancel Download Butler's Save As dialog, the Chrome download is cancelled.
- If the final move fails, the staging file is left in place under Chrome's Downloads directory and the error is shown in the extension popup.

The current staging layout uses a short temporary filename directly in Chrome's configured Downloads directory, for example:

```text
<Chrome Downloads>/DownloadButler-123-a82f19c401be.pdf
```

The temporary file is moved to the selected destination as soon as Chrome reports it complete.

## Privacy / security

Everything is local. There is no server and no telemetry.

The helper's native-host manifest permits messages only from the Download Butler extension ID. Each selected destination also creates a one-time authorization ticket; the helper checks that the completed file is inside Download Butler's staging tree and corresponds to that approved download before moving it.

State is stored locally at:

```text
~/Library/Application Support/Download Butler/state.json
```

It contains folder history, optional per-site folder choices, and short-lived authorization tickets. It does not contain downloaded file contents.

## Current scope

The native Save As, folder chooser, Reveal UI, batch selection workflow, and metadata writer currently target macOS. The extension/native protocol was deliberately separated from platform UI so Windows and Linux can use the same extension.

Good next steps are:

- teach collection/catalog web tools to recognize `*.download-info.md` and show the provenance beside the corresponding file

- Windows SaveFileDialog backend and installer
- Linux GTK/portal or Zenity/KDialog backend and installer
- favorite destination folders in the popup
- a recent-folder chooser in the Save workflow
- rules by domain and/or extension
- optional "use the last folder without asking" mode
- optional subfolder rules such as `PDF → Documentation` or `.img/.imd → Disk Images`
- destination rules that can still be overridden by the Save As dialog

## Uninstall the macOS helper

Run:

```bash
./uninstall-macos.sh
```

Then remove the unpacked extension from `chrome://extensions`.

The uninstall script intentionally leaves your saved folder-history state in place. Delete `~/Library/Application Support/Download Butler` if you also want to remove that data.


## v0.1.3 macOS staging fix

v0.1.3 changes the Chrome staging strategy after macOS Chrome reported `Invalid filename` for the earlier hidden `.download-butler/<id>/...` path. New downloads now use one short ASCII staging filename directly in Chrome's configured Downloads directory. The native helper generates that unpredictable filename and binds it to the one-time move ticket.

It also checks the download state before attempting cancellation, avoiding the secondary `Download must be in progress` extension error.
