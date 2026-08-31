const DEFAULTS = {
  enabled: true,
  rememberPerSite: false,
  eraseChromeHistory: true,
};

const $ = (id) => document.getElementById(id);

function leafName(path) {
  return String(path || '').split(/[\\/]/).pop() || path;
}

async function load() {
  const data = await chrome.storage.local.get({
    ...DEFAULTS,
    history: [],
    lastError: '',
  });

  $('enabled').checked = data.enabled;
  $('rememberPerSite').checked = data.rememberPerSite;
  $('eraseChromeHistory').checked = data.eraseChromeHistory;

  for (const id of ['enabled', 'rememberPerSite', 'eraseChromeHistory']) {
    $(id).addEventListener('change', async (event) => {
      await chrome.storage.local.set({ [id]: event.target.checked });
    });
  }

  if (data.lastError) {
    $('errorSection').classList.remove('hidden');
    $('lastError').textContent = data.lastError;
  }

  renderHistory(data.history);
  checkHost();
}

function renderHistory(history) {
  const root = $('history');
  if (!history.length) return;
  root.classList.remove('muted');
  root.textContent = '';

  for (const item of history.slice(0, 7)) {
    const row = document.createElement('div');
    row.className = 'item';

    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = item.filename || leafName(item.destinationPath);
    const path = document.createElement('div');
    path.className = 'item-path';
    path.textContent = item.destinationPath;
    text.append(name, path);

    const reveal = document.createElement('button');
    reveal.textContent = 'Reveal';
    reveal.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'reveal_path', path: item.destinationPath });
    });

    row.append(text, reveal);
    root.append(row);
  }
}

async function checkHost() {
  const status = $('hostStatus');
  const lastFolder = $('lastFolder');
  try {
    const response = await chrome.runtime.sendMessage({ action: 'native_status' });
    if (response?.ok) {
      status.textContent = `Helper connected (${response.platform || 'native'}, v${response.version || '?'})`;
      status.className = 'status ok';
      lastFolder.textContent = response.lastDir || 'None yet';
      lastFolder.classList.toggle('muted', !response.lastDir);
    } else {
      throw new Error(response?.error || 'Helper unavailable');
    }
  } catch (error) {
    status.textContent = 'Helper not connected';
    status.className = 'status bad';
    lastFolder.textContent = String(error?.message || error);
  }
}

load();
