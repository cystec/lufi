import { STORAGE_PREFIX, formatBytes, copyText, toast } from './utils.js';

const STORAGE_KEY = `${STORAGE_PREFIX}files`;
const configEl = document.getElementById('files-config');
if (!configEl) {
  throw new Error('Files config missing');
}

const config = {
  baseUrl: configEl.dataset.base,
  actionUrl: configEl.dataset.action,
  counterUrl: configEl.dataset.counter,
};

const tableBody = document.getElementById('files-body');
const emptyRow = document.getElementById('files-empty');
const searchInput = document.getElementById('file-search');
const sortSelect = document.getElementById('file-sort');
const exportBtn = document.getElementById('export-storage');
const importTrigger = document.getElementById('import-storage-trigger');
const importInput = document.getElementById('import-storage');
const purgeBtn = document.getElementById('purge-expired');
const clearBtn = document.getElementById('clear-storage');

let files = loadFiles();
let selection = new Set();
let filteredFiles = [...files];

function loadFiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Unable to parse stored files', error);
    return [];
  }
}

function saveFiles(newFiles) {
  files = [...newFiles];
  filteredFiles = applyFilters(files);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
  renderTable();
}

function applyFilters(list) {
  const query = searchInput?.value?.trim().toLowerCase() || '';
  let working = [...list];

  if (query) {
    working = working.filter((file) => {
      return (
        file.name?.toLowerCase().includes(query) ||
        file.short?.toLowerCase().includes(query) ||
        (file.url && file.url.toLowerCase().includes(query))
      );
    });
  }

  const sortValue = sortSelect?.value || 'created_desc';
  working.sort((a, b) => {
    switch (sortValue) {
      case 'created_asc':
        return a.created_at - b.created_at;
      case 'expiry_asc':
        return computeExpiry(a) - computeExpiry(b);
      case 'size_desc':
        return (b.size || 0) - (a.size || 0);
      case 'size_asc':
        return (a.size || 0) - (b.size || 0);
      case 'created_desc':
      default:
        return (b.created_at || 0) - (a.created_at || 0);
    }
  });

  return working;
}

function computeExpiry(file) {
  if (!file.delay) return Infinity;
  return (file.created_at || 0) + file.delay * 86400;
}

function renderTable() {
  tableBody.innerHTML = '';
  if (!filteredFiles.length) {
    tableBody.appendChild(emptyRow);
    return;
  }

  filteredFiles.forEach((file) => {
    const row = document.createElement('tr');
    row.dataset.short = file.short;

    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'row-select';
    checkbox.checked = selection.has(file.short);
    checkbox.addEventListener('change', () => toggleSelection(file.short, checkbox.checked));
    selectCell.appendChild(checkbox);
    row.appendChild(selectCell);

    const nameCell = document.createElement('td');
    nameCell.textContent = file.name;
    row.appendChild(nameCell);

    const sizeCell = document.createElement('td');
    sizeCell.textContent = formatBytes(file.size || 0);
    row.appendChild(sizeCell);

    const expiryCell = document.createElement('td');
    const expiryTimestamp = computeExpiry(file);
    if (!file.delay) {
      expiryCell.textContent = 'No limit';
    } else if (expiryTimestamp * 1000 < Date.now()) {
      expiryCell.textContent = 'Expired';
      expiryCell.classList.add('status-pill', 'danger');
    } else {
      const expiresDate = new Date(expiryTimestamp * 1000);
      expiryCell.textContent = expiresDate.toLocaleString();
    }
    row.appendChild(expiryCell);

    const downloadsCell = document.createElement('td');
    downloadsCell.textContent = '…';
    row.appendChild(downloadsCell);
    fetchCounter(file, downloadsCell);

    const actionsCell = document.createElement('td');
    actionsCell.appendChild(buildActionButtons(file));
    row.appendChild(actionsCell);

    tableBody.appendChild(row);
  });
}

function buildActionButtons(file) {
  const wrapper = document.createElement('div');
  wrapper.className = 'file-actions';

  const openBtn = document.createElement('a');
  openBtn.className = 'btn';
  openBtn.href = file.url;
  openBtn.target = '_blank';
  openBtn.rel = 'noopener';
  openBtn.textContent = 'Open';

  const copyFull = document.createElement('button');
  copyFull.className = 'btn-secondary';
  copyFull.textContent = 'Copy full link';
  copyFull.addEventListener('click', () => copyText(file.url, 'Link copied'));

  const keylessLink = file.url.split('#')[0];
  const copyKeyless = document.createElement('button');
  copyKeyless.className = 'btn-secondary';
  copyKeyless.textContent = 'Copy without key';
  copyKeyless.addEventListener('click', () => copyText(keylessLink, 'Keyless link copied'));

  const deleteRemote = document.createElement('button');
  deleteRemote.className = 'btn-secondary';
  deleteRemote.textContent = 'Delete remote';
  deleteRemote.addEventListener('click', () => handleRemoteDelete(file));

  const deleteLocal = document.createElement('button');
  deleteLocal.className = 'btn-secondary';
  deleteLocal.textContent = 'Remove from list';
  deleteLocal.addEventListener('click', () => removeLocal(file.short));

  wrapper.append(openBtn, copyFull, copyKeyless, deleteRemote, deleteLocal);
  return wrapper;
}

async function fetchCounter(file, cell) {
  try {
    const body = new URLSearchParams({ short: file.short, token: file.token });
    const response = await fetch(config.counterUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await response.json();
    if (data.success) {
      cell.textContent = data.counter;
      if (data.deleted) {
        cell.classList.add('status-pill', 'warning');
        cell.textContent = `${data.counter} (deleted)`;
      }
    } else {
      cell.textContent = 'Unavailable';
      if (data.missing) {
        removeLocal(file.short);
        toast(`Removed ${file.name} from list because the file no longer exists.`, 'warning');
      }
    }
  } catch (error) {
    console.error('Counter fetch failed', error);
    cell.textContent = 'Error';
  }
}

function toggleSelection(short, isSelected) {
  if (isSelected) {
    selection.add(short);
  } else {
    selection.delete(short);
  }
}

async function handleRemoteDelete(file) {
  const deleteUrl = new URL(`d/${file.short}/${file.token}`, config.actionUrl).toString();
  try {
    const response = await fetch(deleteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _format: 'json' }),
    });
    const data = await response.json();
    if (data.success) {
      toast(data.msg || 'File deleted', 'success');
      removeLocal(file.short);
    } else {
      toast(data.msg || 'Delete failed', 'danger');
    }
  } catch (error) {
    console.error(error);
    toast('Unable to delete file', 'danger');
  }
}

function removeLocal(short) {
  const newFiles = files.filter((item) => item.short !== short);
  saveFiles(newFiles);
  selection.delete(short);
}

function exportStorage() {
  const blob = new Blob([JSON.stringify(files, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'nofile-exports.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  toast('Export ready', 'success');
}

function importStorage(file) {
  const reader = new FileReader();
  reader.addEventListener('loadend', () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) {
        throw new Error('Invalid format');
      }
      const merged = [...files];
      let importedCount = 0;
      imported.forEach((entry) => {
        if (entry.short && !merged.some((item) => item.short === entry.short)) {
          merged.push(entry);
          importedCount += 1;
        }
      });
      saveFiles(merged);
      toast(`Imported ${importedCount} item${importedCount === 1 ? '' : 's'}`, 'success');
    } catch (error) {
      console.error(error);
      toast('Unable to import file list', 'danger');
    }
  });
  reader.readAsText(file);
}

async function purgeExpired() {
  await Promise.all(
    files.map(async (file) => {
      const body = new URLSearchParams({ short: file.short, token: file.token });
      try {
        const response = await fetch(config.counterUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        const data = await response.json();
        if (data.success && data.deleted) {
          removeLocal(file.short);
        }
      } catch (error) {
        console.error('Unable to purge file', error);
      }
    })
  );
  toast('Expired entries cleaned', 'success');
}

async function deleteSelected() {
  const selected = files.filter((file) => selection.has(file.short));
  for (const file of selected) {
    await handleRemoteDelete(file);
  }
  selection.clear();
  renderTable();
}

function setupEvents() {
  searchInput?.addEventListener('input', () => {
    filteredFiles = applyFilters(files);
    renderTable();
  });

  sortSelect?.addEventListener('change', () => {
    filteredFiles = applyFilters(files);
    renderTable();
  });

  exportBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    exportStorage();
  });

  importTrigger?.addEventListener('click', (event) => {
    event.preventDefault();
    importInput?.click();
  });

  importInput?.addEventListener('change', (event) => {
    const [file] = event.target.files || [];
    if (file) {
      importStorage(file);
    }
    event.target.value = '';
  });

  purgeBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    purgeExpired();
  });

  clearBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    deleteSelected();
  });
}

filteredFiles = applyFilters(files);
renderTable();
setupEvents();
