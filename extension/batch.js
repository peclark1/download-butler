const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const batchId = params.get('id') || '';
let batch = null;

function selectedRows() {
  return [...document.querySelectorAll('.row')]
    .filter((row) => row.querySelector('.pick').checked)
    .map((row) => ({
      url: row.dataset.url,
      filename: row.querySelector('.filename').value.trim() || 'download',
    }));
}

function updateCount() {
  const total = document.querySelectorAll('.row').length;
  const selected = selectedRows().length;
  $('count').textContent = `${selected} of ${total} selected`;
  $('download').disabled = selected === 0;
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
    const linkText = document.createElement('div');
    linkText.className = 'link-text';
    linkText.textContent = item.text || item.filename;
    const context = document.createElement('div');
    context.className = 'context';
    context.textContent = item.context || item.title || '';
    context.title = item.context || item.title || '';
    if (!context.textContent) context.classList.add('hidden');
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = item.url;
    url.title = item.url;
    urlWrap.append(linkText, context, url);

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
    showError(response?.error || 'This batch request is no longer available.');
    $('download').disabled = true;
    return;
  }
  batch = response.batch;
  render();
}

$('selectAll').addEventListener('change', (event) => {
  for (const pick of document.querySelectorAll('.pick')) pick.checked = event.target.checked;
  updateCount();
});

$('cancel').addEventListener('click', () => window.close());

$('download').addEventListener('click', async () => {
  const items = selectedRows();
  if (!items.length) return;

  $('download').disabled = true;
  $('cancel').disabled = true;
  $('download').textContent = 'Choosing folder…';
  $('error').classList.add('hidden');

  try {
    const response = await chrome.runtime.sendMessage({ action: 'start_batch', batchId, items });
    if (response?.cancelled) {
      $('download').textContent = 'Choose Folder & Download';
      $('download').disabled = false;
      $('cancel').disabled = false;
      return;
    }
    if (!response?.ok) throw new Error(response?.error || 'The batch could not be started.');

    const started = response.started?.length || 0;
    const failures = response.failures?.length || 0;
    const destination = response.directoryPath || 'the selected folder';
    showSuccess(`Started ${started} download${started === 1 ? '' : 's'} to ${destination}${failures ? `; ${failures} could not be started.` : '.'} Metadata sidecars and Download Butler Index.md will be written as files complete.`);
    $('download').textContent = 'Downloads started';
    $('cancel').textContent = 'Close';
    $('cancel').disabled = false;
    for (const input of document.querySelectorAll('input')) input.disabled = true;
  } catch (error) {
    showError(String(error?.message || error));
    $('download').textContent = 'Choose Folder & Download';
    $('download').disabled = false;
    $('cancel').disabled = false;
  }
});

load().catch((error) => showError(String(error?.message || error)));
