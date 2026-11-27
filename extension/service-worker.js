import {concurrency,availableSlots} from './queue-policy.js';
import {parts,isDirectory,isIndex,child} from './directory.js';
const HOST_NAME = 'com.downloadbutler.host';
const VERSION = '0.6.0';
const BATCH_MENU_ID = 'download-butler-selection';
let promptQueue = Promise.resolve();
let commitQueue = Promise.resolve();
const commitsScheduled = new Set();

function enqueuePrompt(task) {
  const result = promptQueue.then(task, task);
  promptQueue = result.catch(() => {});
  return result;
}

function scheduleCommit(downloadId) {
  if (!Number.isInteger(downloadId) || commitsScheduled.has(downloadId)) return;
  commitsScheduled.add(downloadId);
  const task = async () => {
    try {
      await commitCompletedDownload(downloadId);
    } finally {
      commitsScheduled.delete(downloadId);
    }
  };
  const result = commitQueue.then(task, task);
  commitQueue = result.catch(() => {});
}

async function scheduleCommitIfAlreadyComplete(downloadId) {
  try {
    const items = await chrome.downloads.search({ id: downloadId });
    if (items[0]?.state === 'complete') scheduleCommit(downloadId);
  } catch (_) {}
}

const DEFAULT_SETTINGS = {
  enabled: true,
  rememberPerSite: false,
  eraseChromeHistory: true,
  saveSingleMetadata: false,
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    enabled: stored.enabled ?? true,
    rememberPerSite: stored.rememberPerSite ?? false,
    eraseChromeHistory: stored.eraseChromeHistory ?? true,
    saveSingleMetadata: stored.saveSingleMetadata ?? false,
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
    sourcePageUrl: item.referrer || '',
    saveMetadata: settings.saveSingleMetadata,
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

    await recordQueueOutcome(entry,'saved');
    await removePendingEntry(downloadId);
    if (response.metadataError) {
      await setLastError(`File saved, but metadata could not be written: ${response.metadataError}`);
    } else {
      await clearLastError();
    }
    await addHistory({
      filename: basename(response.destinationPath || entry.destinationPath) || entry.originalName,
      destinationPath: response.destinationPath || entry.destinationPath,
      url: entry.url,
      siteKey: entry.siteKey,
      batchId: entry.batchId || '',
      metadataSidecarPath: response.metadataSidecarPath || '',
      metadataIndexPath: response.metadataIndexPath || '',
      completedAt: new Date().toISOString(),
    });

    const settings = await getSettings();
    if (settings.eraseChromeHistory) {
      await chrome.downloads.erase({ id: downloadId }).catch(() => {});
    }
  } catch (error) {
    await recordQueueOutcome(entry,'failed',String(error?.message || error));
    await setLastError(String(error?.message || error));
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete') {
    scheduleCommit(delta.id);
  }
  if (['complete','interrupted'].includes(delta.state?.current)) wakeQueues();
});

async function recoverCompletedPendingDownloads() {
  try {
    const stored = await chrome.storage.local.get(null);
    const ids = Object.keys(stored)
      .filter((key) => key.startsWith('pendingDownload:'))
      .map((key) => Number(key.slice('pendingDownload:'.length)))
      .filter(Number.isInteger);

    // Also recognize the pre-v0.1.2 shared pending object if it still exists.
    for (const key of Object.keys(stored.pending || {})) {
      const id = Number(key);
      if (Number.isInteger(id) && !ids.includes(id)) ids.push(id);
    }

    for (const id of ids) await scheduleCommitIfAlreadyComplete(id);
  } catch (error) {
    await setLastError(`Could not recover completed downloads: ${String(error?.message || error)}`);
  }
}

function collectSelectedLinksInPage() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return [];

  const output = [];
  const seen = new Set();

  function cleanText(value, limit = 1500) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
  }

  function pageContextFor(anchor) {
    const contextNode = anchor.closest('tr, li, p, dd, dt, figcaption') || anchor.parentElement;
    if (!contextNode) return '';
    const context = cleanText(contextNode.innerText || contextNode.textContent || '');
    const linkOnly = cleanText(anchor.innerText || anchor.textContent || '');
    return context === linkOnly ? '' : context;
  }

  function sectionTitleFor(anchor) {
    // Prefer semantic headings. The last heading before the link normally
    // describes the section containing it, even when that heading is not
    // included in the user's text selection.
    let best = '';
    for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], caption')) {
      const relation = heading.compareDocumentPosition(anchor);
      if (!(relation & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const text = cleanText(heading.innerText || heading.textContent || '', 300);
      if (text && text.length <= 300) best = text;
    }
    if (best) return best;

    // Older hand-authored archive pages sometimes use a bold/enlarged DIV or
    // paragraph instead of a real heading element. Search a few nearby blocks
    // above the link and accept only short, visibly heading-like text.
    const bodySize = parseFloat(getComputedStyle(document.body).fontSize) || 16;
    let node = anchor.closest('tr, li, p, table, div, section, article') || anchor;
    for (let depth = 0; node && node !== document.body && depth < 8; depth += 1, node = node.parentElement) {
      let sibling = node.previousElementSibling;
      for (let scanned = 0; sibling && scanned < 6; scanned += 1, sibling = sibling.previousElementSibling) {
        const nestedHeading = sibling.matches('h1, h2, h3, h4, h5, h6, [role="heading"], caption')
          ? sibling
          : sibling.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], caption');
        if (nestedHeading) {
          const text = cleanText(nestedHeading.innerText || nestedHeading.textContent || '', 300);
          if (text) return text;
        }

        const text = cleanText(sibling.innerText || sibling.textContent || '', 220);
        if (!text || text.length > 220) continue;
        const style = getComputedStyle(sibling);
        const size = parseFloat(style.fontSize) || bodySize;
        const weight = parseInt(style.fontWeight, 10) || (style.fontWeight === 'bold' ? 700 : 400);
        if (size >= bodySize * 1.2 || weight >= 600) return text;
      }
    }
    return '';
  }

  function add(url, text = '', downloadName = '', context = '', title = '', sectionTitle = '') {
    try {
      const u = new URL(url, document.baseURI);
      if (!['http:', 'https:'].includes(u.protocol)) return;
      const href = u.href;
      if (seen.has(href)) return;
      seen.add(href);
      output.push({
        url: href,
        text: cleanText(text, 500),
        downloadName: String(downloadName || '').trim(),
        context: cleanText(context, 1500),
        title: cleanText(title, 500),
        sectionTitle: cleanText(sectionTitle, 300),
      });
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
    if (intersects) {
      add(
        anchor.href,
        anchor.textContent,
        anchor.getAttribute('download') || '',
        pageContextFor(anchor),
        anchor.getAttribute('title') || '',
        sectionTitleFor(anchor),
      );
    }
  }

  // Also recognize a bare http(s) URL if the visible URL text itself was selected.
  const selectedText = cleanText(selection.toString(), 1500);
  const matches = selection.toString().match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (let raw of matches) {
    raw = raw.replace(/[),.;!?]+$/g, '');
    add(raw, raw, '', selectedText, '', '');
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

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
  recoverCompletedPendingDownloads();
});
chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
  recoverCompletedPendingDownloads();
});
ensureContextMenu();
recoverCompletedPendingDownloads();

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
      context: link.context || '',
      title: link.title || '',
      sectionTitle: link.sectionTitle || '',
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

async function startBatch(batchId, requestedItems, saveMetadata = true, requestedLimit = 3) {
  const limit = concurrency(requestedLimit);
  if (await readQueue(batchId)) throw Error('Batch already queued.');
  const batch = await getBatchRequest(batchId);
  if (!batch) throw new Error('This batch request has expired. Select the links again.');

  const selectedUrls = new Set((requestedItems || []).map((x) => x.url));
  const originalByUrl = new Map(batch.items.map((x) => [x.url, x]));
  const items = [];
  for (const requested of requestedItems || []) {
    let original = originalByUrl.get(requested.url);
    let relativeDirs = [];
    if (requested.rootUrl) {
      const root = originalByUrl.get(requested.rootUrl);
      if (!root || !isDirectory(root.url) || isDirectory(requested.url)) throw Error('Invalid directory selection');
      if (isIndex(batch.sourceTitle) && !child(batch.sourceUrl,root.url)) throw Error('Invalid directory root');
      const relative = parts(root.url,requested.url);
      relativeDirs = [safeFilename(requested.rootName || root.filename), ...relative.slice(0,-1).map(safeFilename)];
      original = {url:requested.url,filename:relative.at(-1),text:requested.text,context:requested.context};
    }
    if (!original || !selectedUrls.has(requested.url)) continue;
    if (!requested.rootUrl && isIndex(batch.sourceTitle) && isDirectory(batch.sourceUrl) && !child(batch.sourceUrl,original.url)) continue;
    items.push({
      url: original.url,
      filename: safeFilename(requested.filename || original.filename),
      relativeDirs,
      sourcePageUrl: requested.rootUrl ? new URL('.',original.url).href : batch.sourceUrl,
      sourcePageTitle: requested.rootUrl ? requested.sourcePageTitle : batch.sourceTitle,
      linkText: original.text || '',
      linkTitle: original.title || '',
      pageContext: original.context || '',
      sectionTitle: original.sectionTitle || '',
    });
  }
  if (!items.length) throw new Error('No files are selected for download.');
  if (items.length > 250) throw Error('Batch exceeds 250 files');
  if (items.some(x => x.relativeDirs.length)) {
    const status = await chrome.runtime.sendNativeMessage(HOST_NAME,{action:'status'});
    if (status?.version !== VERSION) throw Error('Install the updated Download Butler native helper before downloading directories.');
  }

  const settings = await getSettings();
  const response = await chrome.runtime.sendNativeMessage(HOST_NAME, {
    action: 'prepare_batch',
    batchId,
    items,
    siteKey: batch.siteKey || '',
    sourcePageTitle: batch.sourceTitle || '',
    sourcePageUrl: batch.sourceUrl || '',
    rememberPerSite: settings.rememberPerSite,
    saveMetadata: Boolean(saveMetadata),
  });

  if (!response || response.ok !== true) {
    if (response?.cancelled) return { cancelled: true };
    throw new Error(response?.error || 'Native helper could not prepare the batch.');
  }

  const queue = {batchId, limit, siteKey:batch.siteKey || '', directoryPath:response.directoryPath,
    items:(response.items || []).map(prepared => ({...prepared,state:'queued'}))};
  await saveQueue(queue);
  await chrome.storage.local.remove(batchRequestKey(batchId));
  wakeQueues();
  return {ok:true,directoryPath:queue.directoryPath,total:queue.items.length};
}

// Persist queued files separately from native tickets. Serialize all queue pumps;
// terminal events and the periodic alarm can safely request another pass.
const queueKey = id => 'downloadQueue:'+id;
async function readQueue(id) {
  const key = queueKey(id);
  return (await chrome.storage.local.get(key))[key];
}
async function saveQueue(queue) {
  await chrome.storage.local.set({[queueKey(queue.batchId)]:queue});
}
let queuePump = Promise.resolve();
function wakeQueues() {
  queuePump = queuePump.then(pumpQueues,pumpQueues).catch(error => setLastError(String(error?.message || error)));
}
async function queueProgress(id) {
  const q = await readQueue(id);
  if (!q) return null;
  return {queued:q.items.filter(x=>x.state==='queued').length,
    active:q.items.filter(x=>['starting','active'].includes(x.state)).length,
    completed:q.items.filter(x=>x.state==='saved').length,
    failed:q.items.filter(x=>x.state==='failed').length,
    errors:q.items.filter(x=>x.state==='failed').map(x=>x.targetFilename+': '+x.error)};
}
async function reconcile(queue, entry) {
  let download;
  if (Number.isInteger(entry.id)) {
    [download] = await chrome.downloads.search({id:entry.id});
  } else {
    // Recover an interrupted worker after download() but before persisting its ID.
    // Match the unique staging name; never blindly re-submit an ambiguous start.
    const matches = await chrome.downloads.search({url:entry.url});
    download = matches.find(x=>basename(x.filename)===entry.stagingFilename);
    if (download) entry.id = download.id;
  }
  if (entry.state==='starting' && !download) {
    entry.state='failed'; entry.error='Interrupted while starting; verify Chrome downloads before retrying.';
    await chrome.storage.local.remove(batchReservationKey(entry.stagingFilename));
    return;
  }
  if (!download) {
    // Successful commit may erase Chrome history. Its durable queue outcome is
    // recorded before erase, independently of this reconciliation.
    entry.state='failed'; entry.error='Chrome download record missing.'; return;
  }
  if (download.state==='interrupted') {
    entry.state='failed'; entry.error=download.error || 'Download interrupted';
    await chrome.storage.local.remove(batchReservationKey(entry.stagingFilename));
  } else if (download.state==='complete') {
    // Wait until native commit has recorded success or failure; include this
    // time in the concurrency slot to avoid racing destination reservations.
    scheduleCommit(download.id);
  } else entry.state='active';
}
async function launchQueued(queue, entry) {
  entry.state='starting';
  await saveQueue(queue);
  const reservation = {...entry,batchId:queue.batchId,siteKey:queue.siteKey,createdAt:new Date().toISOString()};
  const key = batchReservationKey(entry.stagingFilename);
  try {
    await chrome.storage.local.set({[key]:reservation});
    const id = await chrome.downloads.download({url:entry.url,filename:entry.stagingFilename,saveAs:false,conflictAction:'overwrite'});
    entry.id=id; entry.state='active';
    await setPendingEntry(id,{destinationPath:entry.destinationPath,ticket:entry.ticket,
      originalName:entry.targetFilename,siteKey:queue.siteKey,stagingFilename:entry.stagingFilename,
      url:entry.url,batchId:queue.batchId,startedAt:new Date().toISOString()});
    await saveQueue(queue);
    await scheduleCommitIfAlreadyComplete(id);
  } catch(error) {
    // If Chrome already accepted the transfer, retain its ID and reconcile
    // instead of launching a duplicate.
    if (!Number.isInteger(entry.id)) {
      entry.state='failed'; entry.error=String(error?.message || error);
      await chrome.storage.local.remove(key);
    } else throw error;
  }
  await saveQueue(queue);
}
async function pumpQueues() {
  const all = await chrome.storage.local.get(null);
  for (const [key,queue] of Object.entries(all)) {
    if (!key.startsWith('downloadQueue:')) continue;
    for (const entry of queue.items) {
      if (['active','starting'].includes(entry.state)) {
        const outcome = all['queueOutcome:'+entry.stagingFilename];
        if (outcome) { entry.state=outcome.state; entry.error=outcome.error || ''; }
        else await reconcile(queue,entry);
      }
    }
    await saveQueue(queue);
    const active = queue.items.filter(x=>['starting','active'].includes(x.state)).length;
    const queued = queue.items.filter(x=>x.state==='queued');
    for (const entry of queued.slice(0,availableSlots(queue.limit,active,queued.length))) await launchQueued(queue,entry);
    // Remove outcome markers only once terminal state is safely persisted.
    const keys = queue.items.filter(x=>['saved','failed'].includes(x.state)).map(x=>'queueOutcome:'+x.stagingFilename);
    if (keys.length) await chrome.storage.local.remove(keys);
  }
}
async function recordQueueOutcome(entry,state,error='') {
  if (!entry?.batchId || !entry.stagingFilename) return;
  await chrome.storage.local.set({['queueOutcome:'+entry.stagingFilename]:{state,error}});
  wakeQueues();
}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='downloadButlerQueue') wakeQueues();});
async function initializeQueue() {
  if (!await chrome.alarms.get('downloadButlerQueue')) await chrome.alarms.create('downloadButlerQueue',{periodInMinutes:1});
  wakeQueues();
}
chrome.runtime.onStartup.addListener(()=>initializeQueue().catch(console.warn));
chrome.runtime.onInstalled.addListener(()=>initializeQueue().catch(console.warn));
initializeQueue().catch(console.warn);

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

  if (message?.action === 'batch_progress' && message.batchId) {
    queueProgress(message.batchId).then(progress=>sendResponse({ok:Boolean(progress),progress})).catch(error=>sendResponse({ok:false,error:String(error)}));
    return true;
  }
  if (message?.action === 'start_batch' && message.batchId) {
    startBatch(message.batchId, message.items, message.saveMetadata !== false, message.concurrency ?? 3)
      .then((result) => sendResponse(result))
      .catch(async (error) => {
        await setLastError(String(error?.message || error));
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }
});
