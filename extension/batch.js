import {concurrency} from './queue-policy.js';
import {isDirectory,isIndex,child,parts,scan} from './directory.js';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const batchId = params.get('id') || '';
let batch = null;
let busy = false, completed = false, expanded = false;
let initial = [];
let progressTimer;
async function refreshProgress() {
  const response = await chrome.runtime.sendMessage({action:'batch_progress',batchId});
  if (!response?.ok) return false;
  const q = response.progress;
  $('queueStatus').classList.remove('hidden');
  $('queueStatus').textContent = `${q.queued} queued · ${q.active} active · ${q.completed} saved · ${q.failed} failed` + (q.errors.length ? '\n'+q.errors.join('\n') : '');
  if (!q.active && !q.queued) clearInterval(progressTimer);
  return true;
}
function watchProgress() {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => refreshProgress().catch(console.warn), 1500);
  refreshProgress().catch(console.warn);
}

function selectedRows() {
  return [...document.querySelectorAll('.row')]
    .filter((row) => row.querySelector('.pick').checked)
    .map((row) => ({
      url: row.dataset.url,
      rootUrl: row.dataset.rootUrl || '', rootName: row.dataset.rootName || '',
      sourcePageUrl: row.dataset.sourcePageUrl || '', sourcePageTitle: row.dataset.sourcePageTitle || '', text: row.dataset.text || '', context: row.dataset.context || '',
      filename: row.querySelector('.filename').value.trim() || 'download',
    }));
}

function updateCount() {
  const total = document.querySelectorAll('.row').length;
  const selected = selectedRows().length;
  $('count').textContent = `${selected} of ${total} selected`;
  const needScan = $('recursive').checked && selectedRows().some(x => isDirectory(x.url));
  $('download').disabled = busy || completed || selected === 0 || needScan;
  $('scan').disabled = busy || completed || !needScan;
  $('scan').hidden = !$('recursive').checked || ![...document.querySelectorAll('.row')].some(x => isDirectory(x.dataset.url));
  $('selectAll').checked = total > 0 && selected === total;
  $('selectAll').indeterminate = selected > 0 && selected < total;
}

function showError(message) {
  $('success').classList.add('hidden');
  $('error').textContent = message;
  $('error').classList.remove('hidden');
}

function showSuccess(message) {
  $('error').classList.add('hidden');
  $('success').textContent = message;
  $('success').classList.remove('hidden');
}

function render() {
  $('source').textContent = batch.sourceTitle ? `${batch.sourceTitle} — ${batch.sourceUrl}` : batch.sourceUrl;
  const list = $('list');
  list.textContent = '';

  for (const item of batch.items) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.url = item.url;
    for (const key of ['rootUrl','rootName','sourcePageUrl','sourcePageTitle','text','context']) row.dataset[key] = item[key] || '';

    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'pick';
    pick.checked = true;
    pick.addEventListener('change', updateCount);

    const filename = document.createElement('input');
    filename.type = 'text';
    filename.className = 'filename';
    filename.value = item.filename;
    filename.spellcheck = false;

    const urlWrap = document.createElement('div');
    urlWrap.className = 'url-wrap';
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'section-title';
    sectionTitle.textContent = item.sectionTitle ? `Section: ${item.sectionTitle}` : '';
    sectionTitle.title = item.sectionTitle || '';
    if (!sectionTitle.textContent) sectionTitle.classList.add('hidden');
    const linkText = document.createElement('div');
    linkText.className = 'link-text';
    linkText.textContent = (isDirectory(item.url) ? '📁 Directory — ' : item.rootUrl ? '↳ '+[item.rootName,...parts(item.rootUrl,item.url).slice(0,-1)].join('/')+'/ — ' : '') + (item.text || item.filename);
    const context = document.createElement('div');
    context.className = 'context';
    context.textContent = item.context || item.title || '';
    context.title = item.context || item.title || '';
    if (!context.textContent) context.classList.add('hidden');
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = item.url;
    url.title = item.url;
    urlWrap.append(sectionTitle, linkText, context, url);

    row.append(pick, filename, urlWrap);
    list.append(row);
  }
  updateCount();
}

async function load() {
  if (!batchId) {
    showError('Missing batch identifier.');
    $('download').disabled = true;
    return;
  }
  const response = await chrome.runtime.sendMessage({ action: 'get_batch', batchId });
  if (!response?.ok || !response.batch) {
    if (await refreshProgress()) {
      completed = true; $('download').disabled = true; $('scan').disabled = true;
      $('cancel').textContent = 'Close';
      for (const input of document.querySelectorAll('input')) input.disabled = true;
      watchProgress(); return;
    }
    showError(response?.error || 'This batch request is no longer available.');
    $('download').disabled = true;
    return;
  }
  batch = response.batch;
  const prefs = await chrome.storage.local.get({ batchSaveMetadata: true, batchRecursive: true, batchConcurrency: 3 });
  $('concurrency').value = prefs.batchConcurrency;
  $('recursive').checked = prefs.batchRecursive;
  if (isIndex(batch.sourceTitle) && isDirectory(batch.sourceUrl)) {
    const before = batch.items.length;
    batch.items = batch.items.filter(x => child(batch.sourceUrl,x.url));
    $('scanStatus').textContent = (before-batch.items.length)+' navigation/sorting links excluded.';
  }
  initial = batch.items.slice();
  $('saveMetadata').checked = prefs.batchSaveMetadata ?? true;
  render();
}

$('recursive').addEventListener('change', async () => {
  await chrome.storage.local.set({batchRecursive:$('recursive').checked});
  if (expanded && !$('recursive').checked) {
    batch.items = initial.slice(); expanded = false;
    $('scanStatus').textContent = 'Preview cleared; review selection again.';
    render();
  }
  updateCount();
});
$('scan').addEventListener('click', async () => {
  const rows = selectedRows(), roots = rows.filter(x => isDirectory(x.url));
  if (!roots.length || busy) return;
  busy = true; updateCount();
  const inputs = [...document.querySelectorAll('input')];
  inputs.forEach(x => x.disabled = true);
  try {
    const origins = [...new Set(roots.map(x => new URL(x.url).origin+'/*'))];
    if (!await chrome.permissions.request({origins})) throw Error('Site permission denied');
    const next = []; let directories = 0;
    const byUrl = new Map(batch.items.map(x => [x.url,x]));
    for (const row of rows) {
      if (!isDirectory(row.url)) { next.push({...byUrl.get(row.url),filename:row.filename}); continue; }
      $('scanStatus').textContent = 'Scanning '+row.filename+'…';
      const result = await scan(row.url);
      if (!result.files.length) throw Error('No downloadable files in '+row.url);
      directories += result.directories;
      next.push(...result.files.map(x => ({...x,rootName:row.filename})));
      if (next.length > 250 || directories > 250) throw Error('Batch exceeds 250 files or directories');
    }
    if (next.length > 250) throw Error('Batch exceeds 250 files');
    batch.items = next; expanded = true;
    $('error').classList.add('hidden');
    $('scanStatus').textContent = next.length+' files ready for review; '+directories+' directories scanned.';
    render();
  } catch(e) { showError(String(e.message || e)); $('scanStatus').textContent = 'Scan failed; no downloads started.'; }
  finally { busy = false; inputs.forEach(x => x.disabled = false); updateCount(); }
});
$('saveMetadata').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ batchSaveMetadata: event.target.checked });
});

$('selectAll').addEventListener('change', (event) => {
  for (const pick of document.querySelectorAll('.pick')) pick.checked = event.target.checked;
  updateCount();
});

$('cancel').addEventListener('click', () => window.close());

$('download').addEventListener('click', async () => {
  const items = selectedRows();
  if (!items.length || busy || ($('recursive').checked && items.some(x => isDirectory(x.url)))) return;
  busy = true;

  $('download').disabled = true;
  $('cancel').disabled = true;
  $('download').textContent = 'Choosing folder…';
  $('error').classList.add('hidden');

  try {
    const saveMetadata = $('saveMetadata').checked;
    if (!$('concurrency').reportValidity()) throw Error('Enter a valid concurrency limit.');
    const limit = concurrency($('concurrency').valueAsNumber);
    await chrome.storage.local.set({ batchSaveMetadata: saveMetadata, batchConcurrency:limit });
    const response = await chrome.runtime.sendMessage({ action: 'start_batch', batchId, items, saveMetadata, concurrency:limit });
    if (response?.cancelled) {
      busy = false; updateCount();
      $('download').textContent = 'Choose Folder & Download';
      $('download').disabled = false;
      $('cancel').disabled = false;
      return;
    }
    if (!response?.ok) throw new Error(response?.error || 'The batch could not be started.');

    const total = response.total;
    const destination = response.directoryPath || 'the selected folder';
    showSuccess(`Queued ${total} files for ${destination}. ${limit === 0 ? 'Unlimited concurrency.' : 'Maximum '+limit+' concurrent downloads.'} You may close this tab.${saveMetadata ? ' Metadata will be written as files complete.' : ''}`);
    watchProgress();
    completed = true; busy = false; $('scan').disabled = true;
    $('download').textContent = 'Batch queued';
    $('cancel').textContent = 'Close';
    $('cancel').disabled = false;
    for (const input of document.querySelectorAll('input')) input.disabled = true;
  } catch (error) {
    busy = false; updateCount();
    showError(String(error?.message || error));
    $('download').textContent = 'Choose Folder & Download';
    $('download').disabled = false;
    $('cancel').disabled = false;
  }
});

load().catch((error) => showError(String(error?.message || error)));
