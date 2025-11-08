import {
  base64UrlDecode,
  decodeAesKey,
  copyText,
  toast,
  getFragmentKey,
  formatBytes,
} from './utils.js';

const configEl = document.getElementById('file-config');
if (!configEl) {
  throw new Error('Missing file configuration');
}

const config = {
  wsUrl: configEl.dataset.ws,
  baseUrl: configEl.dataset.base,
  short: configEl.dataset.short,
  totalSlices: Number(configEl.dataset.nbslices || 1),
  passwordRequired: configEl.dataset.passwordRequired === 'true',
};

const panelEl = document.querySelector('.panel');
const downloadBtn = document.getElementById('download-btn');
const previewBtn = document.getElementById('open-preview-btn');
const copyFullBtn = document.getElementById('copy-link-btn');
const copyKeylessBtn = document.getElementById('copy-link-no-key-btn');
const cancelBtn = document.getElementById('cancel-download-btn');
const messageEl = document.getElementById('download-message');
const progressBar = document.getElementById('download-progress');
const passwordForm = document.getElementById('password-form');
const passwordInput = document.getElementById('file-password');
const passwordSubmit = document.getElementById('password-submit');
const fileSizeEl = document.getElementById('file-size');

const state = {
  ws: null,
  attempts: 0,
  key: null,
  rawKey: null,
  keyString: '',
  nextPart: 0,
  chunks: [],
  completed: false,
  blob: null,
  aborting: false,
};

function initFileSize() {
  const size = Number(panelEl.dataset.size || 0);
  if (fileSizeEl && size) {
    fileSizeEl.textContent = formatBytes(size);
  }
}

function setupCopyButtons() {
  copyFullBtn?.addEventListener('click', () => {
    copyText(window.location.href, 'Link copied');
  });

  copyKeylessBtn?.addEventListener('click', () => {
    copyText(window.location.href.split('#')[0], 'Keyless link copied');
  });
}

function onDownloadClick(event) {
  if (!state.blob) {
    event.preventDefault();
    startDownload();
  }
}

function setupDownloadButtons() {
  downloadBtn?.addEventListener('click', onDownloadClick);
  previewBtn?.addEventListener('click', () => {
    if (state.blob) {
      openPreview();
    } else {
      toast('Download the file before opening a preview.', 'warning');
    }
  });

  cancelBtn?.addEventListener('click', () => {
    state.aborting = true;
    state.ws?.close();
    window.onbeforeunload = null;
    messageEl.textContent = 'Download cancelled.';
    cancelBtn.hidden = true;
  });
}

function setupPasswordFlow() {
  if (!passwordForm) return;
  passwordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const pwd = passwordInput.value.trim();
    if (!pwd) {
      toast('Enter the password to continue.', 'warning');
      return;
    }
    state.password = pwd;
    passwordForm.hidden = true;
    startDownload();
  });
  passwordSubmit?.addEventListener('click', (event) => {
    event.preventDefault();
    passwordForm.requestSubmit();
  });
}

async function startDownload() {
  if (state.ws || state.completed) return;

  try {
    await prepareKey();
  } catch (error) {
    toast(error.message || 'Unable to read encryption key.', 'danger');
    return;
  }

  if (config.passwordRequired && !state.password) {
    toast('Enter the password to continue.', 'warning');
    return;
  }

  state.chunks = new Array(config.totalSlices);
  state.nextPart = 0;
  state.attempts = 0;
  state.completed = false;
  cancelBtn.hidden = false;
  messageEl.textContent = 'Connecting to secure download channel…';
  openWebSocket(0);
  window.onbeforeunload = (event) => {
    event.preventDefault();
    event.returnValue = '';
  };
}

async function prepareKey() {
  if (state.key) return;
  const fragmentKey = getFragmentKey();
  if (!fragmentKey) {
    throw new Error('This link is missing the encryption key fragment.');
  }
  state.keyString = fragmentKey;
  const raw = base64UrlDecode(fragmentKey);
  state.rawKey = raw;
  state.key = await decodeAesKey(fragmentKey);
}

function openWebSocket(part) {
  state.ws = new WebSocket(config.wsUrl);
  state.ws.addEventListener('open', () => {
    requestSlice(part);
  });
  state.ws.addEventListener('message', onSliceReceived);
  state.ws.addEventListener('error', () => {
    retry(part);
  });
  state.ws.addEventListener('close', () => {
    if (!state.completed && !state.aborting) {
      retry(part);
    }
  });
}

function requestSlice(part) {
  const payload = { part };
  if (state.password) {
    payload.file_pwd = state.password;
  }
  state.ws.send(JSON.stringify(payload));
  messageEl.textContent = `Requesting slice ${part + 1} of ${config.totalSlices}…`;
}

function retry(part) {
  state.attempts += 1;
  if (state.attempts > 8) {
    toast('Unable to sustain connection for download.', 'danger');
    cancelBtn.hidden = true;
    window.onbeforeunload = null;
    return;
  }
  messageEl.textContent = `Retrying slice ${part + 1} (${state.attempts})…`;
  openWebSocket(part);
}

async function onSliceReceived(event) {
  state.attempts = 0;
  const [jsonPart, encryptedPart] = event.data.split('XXMOJOXX');
  const meta = JSON.parse(jsonPart);

  if (meta.msg) {
    toast(meta.msg, 'danger');
    cancelBtn.hidden = true;
    window.onbeforeunload = null;
    state.ws?.close();
    return;
  }

  try {
    const payload = JSON.parse(encryptedPart);
    const decrypted = await decryptChunk(payload);
    state.chunks[meta.part] = decrypted;
    updateProgress(meta.part + 1, meta.total);

    if (meta.part + 1 === meta.total) {
      finalizeDownload(meta);
    } else {
      state.nextPart = meta.part + 1;
      requestSlice(state.nextPart);
    }
  } catch (error) {
    toast(error.message || 'Unable to decrypt slice.', 'danger');
    cancelBtn.hidden = true;
    window.onbeforeunload = null;
    state.ws?.close();
  }
}

async function decryptChunk(payload) {
  const iv = base64UrlDecode(payload.iv);
  const ciphertext = base64UrlDecode(payload.ct);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    state.key,
    ciphertext
  );
  return decrypted;
}

function updateProgress(completed, total) {
  const percent = Math.round((completed / total) * 100);
  progressBar.style.width = `${percent}%`;
  progressBar.setAttribute('aria-valuenow', String(percent));
  messageEl.textContent = `Decrypting ${completed} of ${total} chunks…`;
}

function finalizeDownload(meta) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    const payload = state.password ? { ended: true, file_pwd: state.password } : { ended: true };
    state.ws.send(JSON.stringify(payload));
  }
  state.ws?.close();
  state.completed = true;
  cancelBtn.hidden = true;
  window.onbeforeunload = null;

  const blob = new Blob(state.chunks, { type: meta.type || 'application/octet-stream' });
  state.blob = blob;

  const url = URL.createObjectURL(blob);
  downloadBtn.textContent = 'Save file';
  downloadBtn.href = url;
  downloadBtn.setAttribute('download', meta.name || 'download');
  downloadBtn.setAttribute('role', 'link');
  downloadBtn.removeEventListener('click', onDownloadClick);
  downloadBtn.addEventListener('click', () => {
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  messageEl.textContent = 'Download ready. Save the file or open a preview.';
  toast('File decrypted successfully.', 'success');
}

function openPreview() {
  if (!state.blob) return;
  const type = panelEl.dataset.type || '';
  const url = URL.createObjectURL(state.blob);
  const previewArea = document.createElement('div');
  previewArea.className = 'surface';

  if (type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Downloaded file preview';
    img.style.maxWidth = '100%';
    previewArea.appendChild(img);
  } else if (type.startsWith('video/')) {
    const video = document.createElement('video');
    video.controls = true;
    video.src = url;
    video.style.width = '100%';
    previewArea.appendChild(video);
  } else if (type.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    previewArea.appendChild(audio);
  } else if (type.startsWith('text/') || type === 'application/json') {
    state.blob.text().then((text) => {
      const pre = document.createElement('pre');
      pre.textContent = text.slice(0, 5000);
      previewArea.appendChild(pre);
    });
  } else {
    toast('Preview not available for this file type. Save the file instead.', 'warning');
    URL.revokeObjectURL(url);
    return;
  }

  panelEl.appendChild(previewArea);
}

initFileSize();
setupCopyButtons();
setupDownloadButtons();
setupPasswordFlow();
