import {
  base64UrlDecode,
  decodeAesKey,
  copyText,
  toast,
  getFragmentKey,
  formatBytes,
  buildWebSocketCandidates,
} from './utils.js';

const configEl = document.getElementById('file-config');
if (!configEl) {
  throw new Error('Missing file configuration');
}

const baseUrl = configEl.dataset.base;
const wsCandidates = buildWebSocketCandidates(configEl.dataset.ws, { baseUrl });
if (!wsCandidates.length) {
  throw new Error('Unable to determine download server endpoint');
}

const MAX_SOCKET_ATTEMPTS = 5;
const SOCKET_RETRY_BASE_DELAY = 500;
const SOCKET_RETRY_MAX_DELAY = 4000;

const config = {
  baseUrl,
  short: configEl.dataset.short,
  totalSlices: Number(configEl.dataset.nbslices || 1),
  passwordRequired: configEl.dataset.passwordRequired === 'true',
  wsCandidates,
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
  key: null,
  rawKey: null,
  keyString: '',
  nextPart: 0,
  chunks: [],
  completed: false,
  blob: null,
  aborting: false,
  password: undefined,
  currentCandidate: 0,
  candidateAttempts: wsCandidates.map(() => 0),
  lastSocketError: null,
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
  state.completed = false;
  state.currentCandidate = 0;
  state.candidateAttempts = config.wsCandidates.map(() => 0);
  state.lastSocketError = null;
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
  if (state.currentCandidate >= config.wsCandidates.length) {
    const message = state.lastSocketError?.message || 'Unable to establish download channel.';
    toast(message, 'danger');
    cancelBtn.hidden = true;
    window.onbeforeunload = null;
    return;
  }

  const url = config.wsCandidates[state.currentCandidate];
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    state.lastSocketError = error instanceof Error ? error : new Error(String(error));
    scheduleRetry(part, state.lastSocketError.message || 'Connection failed');
    return;
  }

  let opened = false;
  state.ws = socket;
  state.lastSocketError = null;

  socket.addEventListener('open', () => {
    opened = true;
    state.candidateAttempts[state.currentCandidate] = 0;
    requestSlice(part);
  });
  socket.addEventListener('message', onSliceReceived);
  socket.addEventListener('error', () => {
    state.lastSocketError = new Error('WebSocket error');
  });
  socket.addEventListener('close', () => {
    if (state.completed || state.aborting) {
      return;
    }
    const reason =
      state.lastSocketError?.message || (opened ? 'Connection lost' : 'Connection failed');
    scheduleRetry(part, reason);
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

function scheduleRetry(part, reason = 'Connection lost') {
  if (state.completed || state.aborting) {
    return;
  }

  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
    try {
      state.ws.close();
    } catch (error) {
      // Ignore close errors.
    }
  }
  state.ws = null;

  state.candidateAttempts[state.currentCandidate] += 1;
  const attempt = state.candidateAttempts[state.currentCandidate];

  if (attempt < MAX_SOCKET_ATTEMPTS) {
    const delay = Math.min(
      SOCKET_RETRY_BASE_DELAY * Math.pow(2, attempt - 1),
      SOCKET_RETRY_MAX_DELAY,
    );
    const attemptLabel = attempt + 1;
    messageEl.textContent = `${reason}. Retrying slice ${part + 1} (attempt ${attemptLabel})…`;
    window.setTimeout(() => openWebSocket(part), delay);
    return;
  }

  state.currentCandidate += 1;
  if (state.currentCandidate >= config.wsCandidates.length) {
    const message =
      state.lastSocketError?.message || 'Unable to sustain connection for download.';
    toast(message, 'danger');
    cancelBtn.hidden = true;
    window.onbeforeunload = null;
    return;
  }

  state.lastSocketError = null;
  messageEl.textContent = 'Switching download connection strategy…';
  state.candidateAttempts[state.currentCandidate] = 0;
  window.setTimeout(() => openWebSocket(part), SOCKET_RETRY_BASE_DELAY);
}

async function onSliceReceived(event) {
  state.candidateAttempts[state.currentCandidate] = 0;
  state.lastSocketError = null;
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
