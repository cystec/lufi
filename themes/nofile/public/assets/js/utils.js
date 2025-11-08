const TOAST_REGION_SELECTOR = '.toast-region';
export const STORAGE_PREFIX = 'nofile:';

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function toast(message, variant = 'info', { timeout = 4000 } = {}) {
  const region = document.querySelector(TOAST_REGION_SELECTOR);
  if (!region) {
    console.warn('Toast region missing');
    return;
  }
  const toastEl = document.createElement('div');
  toastEl.className = `toast toast-${variant}`;
  toastEl.setAttribute('role', 'status');
  toastEl.textContent = message;
  region.appendChild(toastEl);

  window.setTimeout(() => {
    toastEl.classList.add('is-fading');
    toastEl.addEventListener('transitionend', () => toastEl.remove(), { once: true });
    toastEl.style.opacity = '0';
  }, timeout);
}

export async function copyText(text, successMessage = 'Copied', errorMessage = 'Copy failed') {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    toast(successMessage, 'success');
    return true;
  } catch (error) {
    console.error(error);
    toast(errorMessage, 'danger');
    return false;
  }
}

export function base64UrlEncode(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(base64url) {
  const padLength = (4 - (base64url.length % 4)) % 4;
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLength);
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

export function createIv(baseIv, counter) {
  const dataView = new DataView(new ArrayBuffer(12));
  const base = new Uint8Array(baseIv);
  if (base.length !== 12) {
    throw new Error('Base IV must be 12 bytes');
  }
  base.forEach((byte, idx) => dataView.setUint8(idx, byte));
  dataView.setUint32(8, counter, false);
  return dataView.buffer;
}

export async function generateAesKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportAesKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return base64UrlEncode(raw);
}

export function decodeAesKey(base64url) {
  const raw = base64UrlDecode(base64url);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
}

export function formatDate(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp * 1000);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getBaseUrl() {
  return window.document.querySelector('link[rel=canonical]')?.href || window.location.origin + '/';
}

export function withTimeout(promise, ms, message = 'Operation timed out') {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise.finally(() => window.clearTimeout(timeoutHandle)), timeoutPromise]);
}

export function getFragmentKey() {
  const hash = window.location.hash.replace(/^#/, '');
  const [key] = hash.split('&');
  return key || '';
}

export function setFragmentKey(key) {
  window.location.hash = key;
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes.buffer;
}
