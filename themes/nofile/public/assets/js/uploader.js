import {
  formatBytes,
  toast,
  copyText,
  generateAesKey,
  exportAesKey,
  createIv,
  base64UrlEncode,
  randomBytes,
  ensureWebCrypto,
  STORAGE_PREFIX,
} from './utils.js';

const CHUNK_SIZE = 750 * 1024;
const uploadConfigEl = document.getElementById('upload-config');
if (!uploadConfigEl) {
  throw new Error('Upload configuration missing');
}

const config = {
  wsUrl: uploadConfigEl.dataset.ws,
  baseUrl: uploadConfigEl.dataset.base,
  actionUrl: uploadConfigEl.dataset.action,
  forceBurn: uploadConfigEl.dataset.forceBurn === 'true',
  isGuest: uploadConfigEl.dataset.guest === 'true',
  sendUrlsUrl: uploadConfigEl.dataset.sendUrls,
};

const dropzone = document.getElementById('upload-dropzone');
const fileInput = document.getElementById('file-input');
const deleteSelect = document.getElementById('delete-day');
const firstViewCheckbox = document.getElementById('first-view');
const passwordInput = document.getElementById('file-pwd');
const uploadList = document.getElementById('upload-list');
const uploadSection = document.getElementById('active-uploads');

const queue = [];
let activeUpload = null;
let websocket = null;
let websocketReady = null;
let uploadCounter = 0;
let pendingGuestPayloads = [];

function ensureUploadSectionVisible() {
  if (uploadList.children.length > 0) {
    uploadSection.removeAttribute('hidden');
  }
}

function initDropzone() {
  if (!dropzone || !fileInput) return;

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('is-hovered');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('is-hovered');
  });

  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-hovered');
    if (event.dataTransfer?.files?.length) {
      enqueueFiles(event.dataTransfer.files);
    }
  });

  fileInput.addEventListener('change', (event) => {
    const files = event.target.files;
    if (files?.length) {
      enqueueFiles(files);
    }
    fileInput.value = '';
  });
}

function enqueueFiles(fileList) {
  const burn = config.forceBurn || firstViewCheckbox?.checked;
  const delay = Number(deleteSelect?.value || 0);
  const password = passwordInput?.value?.trim();

  Array.from(fileList).forEach((file) => {
    queue.push({
      id: uploadCounter++,
      file,
      delay,
      burn,
      password: password || undefined,
      status: 'pending',
    });
  });

  toast(`${fileList.length} file${fileList.length > 1 ? 's' : ''} queued`, 'success');
  ensureUploadSectionVisible();
  startNextUpload();
}

function ensureWebsocket() {
  if (websocketReady) {
    return websocketReady;
  }

  websocketReady = new Promise((resolve, reject) => {
    websocket = new WebSocket(config.wsUrl);
    websocket.binaryType = 'arraybuffer';
    websocket.addEventListener('open', () => resolve(websocket));
    websocket.addEventListener('error', (error) => {
      websocketReady = null;
      reject(error);
    });
    websocket.addEventListener('close', () => {
      websocketReady = null;
    });
    websocket.addEventListener('message', handleServerMessage);
  });

  return websocketReady;
}

function handleServerMessage(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (err) {
    console.error('Failed to parse server response', err);
    return;
  }

  if (!activeUpload || data.i !== activeUpload.queueIndex) {
    return;
  }

  if (!data.success) {
    failActiveUpload(data.msg || 'Upload failed');
    return;
  }

  if (typeof data.j === 'number' && typeof data.parts === 'number') {
    updateProgress(activeUpload, ((data.j + 1) / data.parts) * 100);
  }

  if (data.short) {
    activeUpload.short = data.short;
  }
  if (data.token) {
    activeUpload.modToken = data.token;
  }

  if (data.j + 1 === data.parts) {
    finalizeUpload(activeUpload, data);
    activeUpload = null;
    startNextUpload();
  } else {
    activeUpload.nextChunk = data.j + 1;
    sendNextChunk(activeUpload).catch((error) => {
      console.error(error);
      failActiveUpload(error.message);
    });
  }
}

function createUploadCard(upload) {
  const li = document.createElement('li');
  li.className = 'file-card';
  li.id = `upload-${upload.id}`;

  const header = document.createElement('div');
  header.className = 'stack';
  const title = document.createElement('h3');
  title.textContent = upload.file.name;
  const subtitle = document.createElement('p');
  subtitle.className = 'muted';
  subtitle.textContent = `${formatBytes(upload.file.size)} · ${upload.file.type || 'Unknown type'}`;

  header.appendChild(title);
  header.appendChild(subtitle);

  const progress = document.createElement('div');
  progress.className = 'progress';
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  progress.appendChild(bar);

  const message = document.createElement('p');
  message.className = 'muted';
  message.id = `upload-message-${upload.id}`;
  message.textContent = 'Preparing encryption key…';

  li.appendChild(header);
  li.appendChild(progress);
  li.appendChild(message);

  uploadList.prepend(li);

  return { li, bar, message, title };
}

async function startNextUpload() {
  if (activeUpload || queue.length === 0) {
    if (queue.length === 0) {
      window.onbeforeunload = null;
    }
    return;
  }

  const next = queue.shift();
  const queueIndex = next.id;
  const ui = createUploadCard(next);

  activeUpload = {
    queueIndex,
    file: next.file,
    delay: next.delay,
    burn: next.burn,
    password: next.password,
    card: ui.li,
    progressBar: ui.bar,
    messageEl: ui.message,
    titleEl: ui.title,
    nextChunk: 0,
    chunkCount: Math.max(1, Math.ceil(next.file.size / CHUNK_SIZE)),
    short: null,
    modToken: null,
    key: null,
    keyEncoded: null,
    baseIv: null,
    cryptoSupport: null,
  };

  window.onbeforeunload = (event) => {
    event.preventDefault();
    event.returnValue = '';
  };

  try {
    await ensureWebsocket();
    await prepareActiveUpload();
    await sendNextChunk(activeUpload);
  } catch (error) {
    failActiveUpload(error.message || String(error));
  }
}

async function prepareActiveUpload() {
  if (!activeUpload) return;

  const support = ensureWebCrypto('Encrypting files');
  const key = await generateAesKey(support);
  const encodedKey = await exportAesKey(key, support);
  const baseIv = randomBytes(12, support.crypto);

  activeUpload.key = key;
  activeUpload.keyEncoded = encodedKey;
  activeUpload.baseIv = baseIv;
  activeUpload.cryptoSupport = support;
  activeUpload.messageEl.textContent = 'Encrypting first chunk…';
}

async function sendNextChunk(upload) {
  const ws = await ensureWebsocket();
  const { file, nextChunk, chunkCount } = upload;
  const support = upload.cryptoSupport ?? ensureWebCrypto('Encrypting files');
  const subtle = support.subtle;
  const start = nextChunk * CHUNK_SIZE;
  const end = Math.min(file.size, start + CHUNK_SIZE);
  const slice = file.slice(start, end);
  const buffer = await slice.arrayBuffer();

  const iv = createIv(upload.baseIv, nextChunk);
  const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv }, upload.key, buffer);
  const payload = {
    alg: 'AES-GCM',
    iv: base64UrlEncode(iv),
    ct: base64UrlEncode(encrypted),
  };

  const envelope = {
    total: chunkCount,
    part: nextChunk,
    size: file.size,
    name: file.name,
    type: file.type,
    delay: upload.delay,
    del_at_first_view: upload.burn,
    zipped: false,
    id: upload.short,
    i: upload.queueIndex,
  };

  if (upload.password) {
    envelope.file_pwd = upload.password;
  }

  const message = `${JSON.stringify(envelope)}XXMOJOXX${JSON.stringify(payload)}`;
  ws.send(message);
  upload.messageEl.textContent = `Encrypting and sending slice ${nextChunk + 1} of ${chunkCount}…`;
}

function updateProgress(upload, percent) {
  if (!upload.progressBar) return;
  upload.progressBar.style.width = `${Math.max(1, Math.round(percent))}%`;
  upload.progressBar.setAttribute('aria-valuenow', percent.toFixed(1));
}

function failActiveUpload(reason) {
  if (!activeUpload) return;
  activeUpload.progressBar.style.background = 'linear-gradient(90deg, #ff4d4d, #ff7e7e)';
  activeUpload.messageEl.textContent = `Upload failed: ${reason}`;
  toast(`Upload failed: ${reason}`, 'danger', { timeout: 6000 });
  activeUpload = null;
  startNextUpload();
}

function finalizeUpload(upload, response) {
  const short = response.short;
  const modToken = response.token;
  const createdAt = response.created_at;
  const delay = response.delay;

  const downloadUrl = new URL(`r/${short}`, config.baseUrl).toString();
  const downloadUrlWithKey = `${downloadUrl}#${upload.keyEncoded}`;
  const deleteUrl = new URL(`d/${short}/${modToken}`, config.actionUrl).toString();

  // Update UI
  upload.progressBar.style.width = '100%';
  upload.progressBar.classList.add('complete');
  upload.messageEl.textContent = 'Upload complete. Use the buttons below to share or remove.';

  const actions = document.createElement('div');
  actions.className = 'file-actions';

  const copyFullBtn = document.createElement('button');
  copyFullBtn.className = 'btn-secondary';
  copyFullBtn.textContent = 'Copy link with key';
  copyFullBtn.addEventListener('click', () => copyText(downloadUrlWithKey, 'Link copied'));

  const copyNoKeyBtn = document.createElement('button');
  copyNoKeyBtn.className = 'btn-secondary';
  copyNoKeyBtn.textContent = 'Copy link without key';
  copyNoKeyBtn.addEventListener('click', () => copyText(downloadUrl, 'Keyless link copied'));

  const copyDeleteBtn = document.createElement('button');
  copyDeleteBtn.className = 'btn-secondary';
  copyDeleteBtn.textContent = 'Copy delete link';
  copyDeleteBtn.addEventListener('click', () => copyText(deleteUrl, 'Deletion link copied'));

  const openBtn = document.createElement('a');
  openBtn.className = 'btn';
  openBtn.href = downloadUrlWithKey;
  openBtn.textContent = 'Open';
  openBtn.target = '_blank';
  openBtn.rel = 'noopener';

  actions.appendChild(openBtn);
  actions.appendChild(copyFullBtn);
  actions.appendChild(copyNoKeyBtn);
  actions.appendChild(copyDeleteBtn);

  upload.card.appendChild(actions);

  toast(`${upload.file.name} uploaded`, 'success');

  storeFileMetadata({
    name: upload.file.name,
    size: upload.file.size,
    short,
    url: downloadUrlWithKey,
    del_at_first_view: upload.burn,
    created_at: createdAt,
    delay,
    token: modToken,
  });

  if (config.isGuest && config.sendUrlsUrl) {
    pendingGuestPayloads.push(JSON.stringify({
      name: upload.file.name,
      short,
      url: downloadUrlWithKey,
      size: upload.file.size,
      created_at: createdAt,
      delay,
      token: modToken,
    }));
    sendGuestPayloads();
  }
}

function storeFileMetadata(entry) {
  try {
    const key = `${STORAGE_PREFIX}files`;
    const raw = localStorage.getItem(key);
    const files = raw ? JSON.parse(raw) : [];
    files.push(entry);
    localStorage.setItem(key, JSON.stringify(files));
  } catch (error) {
    console.error('Unable to store metadata', error);
  }
}

async function sendGuestPayloads() {
  if (!pendingGuestPayloads.length) return;
  if (!config.sendUrlsUrl) {
    pendingGuestPayloads = [];
    return;
  }
  try {
    const response = await fetch(config.sendUrlsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: pendingGuestPayloads }),
    });
    if (response.ok) {
      pendingGuestPayloads = [];
    }
  } catch (error) {
    console.error('Guest URL send failed', error);
  }
}

initDropzone();
