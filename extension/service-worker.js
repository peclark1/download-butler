const HOST_NAME = 'com.downloadbutler.host';
const VERSION = '0.2.0';
const BATCH_MENU_ID = 'download-butler-selection';
let promptQueue = Promise.resolve();

function enqueuePrompt(task) {
  const result = promptQueue.then(task, task);
  promptQueue = result.catch(() => {});
  return result;
}

const DEFAULT_SETTINGS = {
  enabled: true,
  rememberPerSite: false,
  eraseChromeHistory: true,
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    enabled: stored.enabled ?? true,
    rememberPerSite: stored.rememberPerSite ?? false,
    eraseChromeHistory: stored.eraseChromeHistory ?? true,
  };
}

function basename(path) {
  return String(path || 'download').split(/[\\/]/).pop() || 'download';
}

function safeFilename(name) {
  let decoded = String(name || 'download');
  try { decoded = decodeURIComponent(decoded); } catch (_) {}
  return basename(decoded)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, 'download')
    .replace(/[. ]+$/g, '')
    .slice(0, 180) || 'download';
}

function filenameFromUrl(url, fallback = 'download') {
  try {
    const u = new URL(url);
    const leaf = u.pathname.split('/').filter(Boolean).pop();
    if (leaf) return safeFilename(leaf);
  } catch (_) {}
  return safeFilename(fallback);
}

function siteKeyFor(item) {
  for (const candidate of [item.referrer, item.finalUrl, item.url]) {
    if (!candidate) continue;
    try {
      const u = new URL(candidate);
      if (u.hostname) return u.hostname.toLowerCase();
    } catch (_) {}
  }
  return '';
}

function siteKeyForUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}

function pendingStorageKey(downloadId) {
  return `pendingDownload:${downloadId}`;
}

function batchRequestKey(batchId) {
  return `batchRequest:${batchId}`;
}

function batchReservationKey(stagingFilename) {
  return `batchReservation:${stagingFilename}`;
}

async function getPendingEntry(downloadId) {
  const key = pendingStorageKey(downloadId);
  const direct = await chrome.storage.local.get(key);
  if (direct[key]) return direct[key];

  const { pending = {} } = await chrome.storage.local.get('pending');
  return pending[String(downloadId)] || null;
}

async function setPendingEntry(downloadId, entry) {
  await chrome.storage.local.set({ [pendingStorageKey(downloadId)]: entry });
}

async function removePendingEntry(downloadId) {
  await chrome.storage.local.remove(pendingStorageKey(downloadId));
  const { pending = {} } = await chrome.storage.local.get('pending');
  const legacyKey = String(downloadId);
  if (Object.prototype.hasOwnProperty.call(pending, legacyKey)) {
    delete pending[legacyKey];
    await chrome.storage.local.set({ pending });
  }
}

async function setLastError(message) {
  await chrome.storage.local.set({
    lastError: message,
    lastErrorAt: new Date().toISOString(),
  });
  await chrome.action.setBadgeText({ text: '!' }).catch(() => {});
}

async function clearLastError() {
  await chrome.storage.local.remove(['lastError', 'lastErrorAt']);
  await chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

async function addHistory(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  const next = [entry, ...history].slice(0, 30);
  await chrome.storage.local.set({ history: next });
}

async function chooseDestination(item) {
  const settings = await getSettings();
  if (!settings.enabled) return { bypass: true };

  const originalName = safeFilename(item.filename);
  const siteKey = siteKeyFor(item);

  const response = await chrome.runtime.sendNativeMessage(HOST_NAME, {
    action: 'choose_destination',
    downloadId: item.id,
    filename: originalName,
    siteKey,
    rememberPerSite: settings.rememberPerSite,
    url: item.finalUrl || item.url || '',
  });

  if (!response || response.ok !== true) {
    if (response?.cancelled) return { cancelled: true };
    throw new Error(response?.error || 'Native helper did not return a destination.');
  }

  if (!response.stagingFilename || /[\\/]/.test(response.stagingFilename)) {
    throw new Error('Native helper returned an invalid staging filename.');
  }

  return {
    destinationPath: response.destinationPath,
    ticket: response.ticket,
    stagingFilename: response.stagingFilename,
    originalName,
    siteKey,
  };
}

async function cancelIfInProgress(downloadId) {
  try {
    const items = await chrome.downloads.search({ id: downloadId });
    if (items[0]?.state === 'in_progress') {
      await chrome.downloads.cancel(downloadId);
    }
  } catch (_) {}
}

async function getBatchReservationForItem(item) {
  const stage = basename(item.filename);
  if (stage) {
    const key = batchReservationKey(stage);
    const found = await chrome.storage.local.get(key);
    if (found[key]) return { key, reservation: found[key] };
  }

  // Defensive fallback: if Chrome changes the provisional filename before
  // onDeterminingFilename, match the one outstanding reservation for this URL.
  const all = await chrome.storage.local.get(null);
  const urls = new Set([item.finalUrl, item.url].filter(Boolean));
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('batchReservation:') || !value?.url) continue;
    if (urls.has(value.url)) return { key, reservation: value };
  }
  return null;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    try {
      const batch = await getBatchReservationForItem(item);
      if (batch) {
        const r = batch.reservation;
        await setPendingEntry(item.id, {
          destinationPath: r.destinationPath,
          ticket: r.ticket,
          originalName: r.targetFilename,
          siteKey: r.siteKey || '',
          stagingFilename: r.stagingFilename,
          url: r.url || item.finalUrl || item.url || '',
          batchId: r.batchId || '',
          startedAt: new Date().toISOString(),
        });
        await chrome.storage.local.remove(batch.key);
        await clearLastError();
        suggest({ filename: r.stagingFilename, conflictAction: 'overwrite' });
        return;
      }

      const choice = await enqueuePrompt(() => chooseDestination(item));

      if (choice.bypass) {
        suggest();
        return;
      }

      if (choice.cancelled) {
        suggest();
        await cancelIfInProgress(item.id);
        return;
      }

      await setPendingEntry(item.id, {
        destinationPath: choice.destinationPath,
        ticket: choice.ticket,
        originalName: choice.originalName,
        siteKey: choice.siteKey,
        stagingFilename: choice.stagingFilename,
        url: item.finalUrl || item.url || '',
        startedAt: new Date().toISOString(),
      });
      await clearLastError();

      await chrome.storage.local.set({
        lastAttempt: {
          version: VERSION,
          downloadId: item.id,
          originalName: choice.originalName,
          stagingFilename: choice.stagingFilename,
          destinationPath: choice.destinationPath,
          at: new Date().toISOString(),
        },
      });
      suggest({ filename: choice.stagingFilename, conflictAction: 'overwrite' });
    } catch (error) {
      await setLastError(String(error?.message || error));
      suggest();
      await cancelIfInProgress(item.id);
    }
  })();
  return true;
});

async function commitCompletedDownload(downloadId) {
  const entry = await getPendingEntry(downloadId);
  if (!entry) return;

  const items = await chrome.downloads.search({ id: downloadId });
  const item = items[0];
  if (!item || item.state !== 'complete' || !item.filename) return;

  try {
    const response = await chrome.runtime.sendNativeMessage(HOST_NAME, {
      action: 'commit_download',
      stagingPath: item.filename,
      ticket: entry.ticket,
    });

    if (!response || response.ok !== true) {
      throw new Error(response?.error || 'Native helper could not move the completed file.');
    }

    await removePendingEntry(downloadId);
    await clearLastError();
    await addHistory({
      filename: basename(response.destinationPath || entry.destinationPath) || entry.originalName,
      destinationPath: response.destinationPath || entry.destinationPath,
      url: entry.url,
      siteKey: entry.siteKey,
      batchId: entry.batchId || '',
      completedAt: new Date().toISOString(),
    });

    const settings = await getSettings();
    if (settings.eraseChromeHistory) {
      await chrome.downloads.erase({ id: downloadId }).catch(() => {});
    }
  } catch (error) {
    await setLastError(String(error?.message || error));
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete') {
    commitCompletedDownload(delta.id);
  }
});

function collectSelectedLinksInPage() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return [];

  const output = [];
  const seen = new Set();

  function add(url, text = '', downloadName = '') {
    try {
      const u = new URL(url, document.baseURI);
      if (!['http:', 'https:'].includes(u.protocol)) return;
      const href = u.href;
      if (seen.has(href)) return;
      seen.add(href);
      output.push({ url: href, text: String(text || '').trim(), downloadName: String(downloadName || '').trim() });
    } catch (_) {}
  }

  for (const anchor of document.querySelectorAll('a[href]')) {
    let intersects = false;
    for (let i = 0; i < selection.rangeCount; i += 1) {
      try {
        if (selection.getRangeAt(i).intersectsNode(anchor)) {
          intersects = true;
          break;
        }
      } catch (_) {}
    }
    if (intersects) add(anchor.href, anchor.textContent, anchor.getAttribute('download') || '');
  }

  // Also recognize a bare http(s) URL if the visible URL text itself was selected.
  const selectedText = selection.toString();
  const matches = selectedText.match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (let raw of matches) {
    raw = raw.replace(/[),.;!?]+$/g, '');
    add(raw, raw, '');
  }

  return output;
}

async function ensureContextMenu() {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: BATCH_MENU_ID,
      title: 'Download links in selection with Butler…',
      contexts: ['selection'],
    });
  } catch (error) {
    console.warn('Download Butler could not create context menu:', error);
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureContextMenu(); });
chrome.runtime.onStartup.addListener(() => { ensureContextMenu(); });
ensureContextMenu();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== BATCH_MENU_ID || !tab?.id) return;

  try {
    const settings = await getSettings();
    if (!settings.enabled) throw new Error('Download Butler is disabled.');

    const target = { tabId: tab.id };
    if (Number.isInteger(info.frameId) && info.frameId > 0) target.frameIds = [info.frameId];

    const results = await chrome.scripting.executeScript({
      target,
      func: collectSelectedLinksInPage,
    });
    const links = results?.[0]?.result || [];
    if (!links.length) {
      await setLastError('No downloadable http/https links were found in the selected text.');
      return;
    }

    const items = links.slice(0, 250).map((link, index) => ({
      url: link.url,
      text: link.text || '',
      filename: safeFilename(link.downloadName || filenameFromUrl(link.url, link.text || `download-${index + 1}`)),
    }));

    const batchId = crypto.randomUUID();
    const request = {
      id: batchId,
      sourceUrl: tab.url || info.pageUrl || '',
      sourceTitle: tab.title || '',
      siteKey: siteKeyForUrl(tab.url || info.pageUrl || ''),
      items,
      createdAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [batchRequestKey(batchId)]: request });
    await clearLastError();

    await chrome.tabs.create({
      url: chrome.runtime.getURL(`batch.html?id=${encodeURIComponent(batchId)}`),
      active: true,
    });
  } catch (error) {
    await setLastError(String(error?.message || error));
  }
});

async function getBatchRequest(batchId) {
  const key = batchRequestKey(batchId);
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function startBatch(batchId, requestedItems) {
  const batch = await getBatchRequest(batchId);
  if (!batch) throw new Error('This batch request has expired. Select the links again.');

  const selectedUrls = new Set((requestedItems || []).map((x) => x.url));
  const originalByUrl = new Map(batch.items.map((x) => [x.url, x]));
  const items = [];
  for (const requested of requestedItems || []) {
    const original = originalByUrl.get(requested.url);
    if (!original || !selectedUrls.has(requested.url)) continue;
    items.push({
      url: original.url,
      filename: safeFilename(requested.filename || original.filename),
    });
  }
  if (!items.length) throw new Error('No files are selected for download.');

  const settings = await getSettings();
  const response = await chrome.runtime.sendNativeMessage(HOST_NAME, {
    action: 'prepare_batch',
    batchId,
    items,
    siteKey: batch.siteKey || '',
    rememberPerSite: settings.rememberPerSite,
  });

  if (!response || response.ok !== true) {
    if (response?.cancelled) return { cancelled: true };
    throw new Error(response?.error || 'Native helper could not prepare the batch.');
  }

  const started = [];
  const failures = [];
  for (const prepared of response.items || []) {
    const reservation = {
      batchId,
      url: prepared.url,
      targetFilename: prepared.targetFilename,
      destinationPath: prepared.destinationPath,
      stagingFilename: prepared.stagingFilename,
      ticket: prepared.ticket,
      siteKey: batch.siteKey || '',
      createdAt: new Date().toISOString(),
    };
    const reservationKey = batchReservationKey(prepared.stagingFilename);
    await chrome.storage.local.set({ [reservationKey]: reservation });

    try {
      const id = await chrome.downloads.download({
        url: prepared.url,
        filename: prepared.stagingFilename,
        saveAs: false,
        conflictAction: 'overwrite',
      });

      // onDeterminingFilename normally claims the reservation first. Writing the
      // per-download state again here makes the batch robust if event ordering
      // differs on a particular Chrome build.
      await setPendingEntry(id, {
        destinationPath: prepared.destinationPath,
        ticket: prepared.ticket,
        originalName: prepared.targetFilename,
        siteKey: batch.siteKey || '',
        stagingFilename: prepared.stagingFilename,
        url: prepared.url,
        batchId,
        startedAt: new Date().toISOString(),
      });
      started.push({ id, filename: prepared.targetFilename, url: prepared.url });
    } catch (error) {
      await chrome.storage.local.remove(reservationKey);
      failures.push({ filename: prepared.targetFilename, url: prepared.url, error: String(error?.message || error) });
    }
  }

  await chrome.storage.local.remove(batchRequestKey(batchId));
  if (failures.length) {
    await setLastError(`${failures.length} batch download(s) could not be started.`);
  } else {
    await clearLastError();
  }

  return {
    ok: true,
    directoryPath: response.directoryPath,
    started,
    failures,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'native_status') {
    chrome.runtime.sendNativeMessage(HOST_NAME, { action: 'status' })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.action === 'reveal_path' && message.path) {
    chrome.runtime.sendNativeMessage(HOST_NAME, { action: 'reveal_path', path: message.path })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.action === 'get_batch' && message.batchId) {
    getBatchRequest(message.batchId)
      .then((batch) => sendResponse({ ok: Boolean(batch), batch, error: batch ? '' : 'Batch request not found.' }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.action === 'start_batch' && message.batchId) {
    startBatch(message.batchId, message.items)
      .then((result) => sendResponse(result))
      .catch(async (error) => {
        await setLastError(String(error?.message || error));
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }
});
