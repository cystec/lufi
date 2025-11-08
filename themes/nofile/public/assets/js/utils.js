const TOAST_REGION_SELECTOR = '.toast-region';
export const STORAGE_PREFIX = 'nofile:';

export function normalizeWebSocketUrl(url) {
  if (!url) {
    return url;
  }

  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'https:') {
      parsed.protocol = 'wss:';
    } else if (parsed.protocol === 'http:') {
      parsed.protocol = 'ws:';
    } else if (parsed.protocol === '') {
      parsed.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    }
    return parsed.toString();
  } catch (error) {
    console.warn('Failed to normalize WebSocket URL', url, error);
    if (typeof url === 'string') {
      if (url.startsWith('https://')) {
        return `wss://${url.slice('https://'.length)}`;
      }
      if (url.startsWith('http://')) {
        return `ws://${url.slice('http://'.length)}`;
      }
      if (url.startsWith('//')) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}${url}`;
      }
    }
    return url;
  }
}

function resolveCryptoGlobal() {
  if (typeof globalThis === 'undefined') {
    return null;
  }
  return globalThis.crypto || globalThis.msCrypto || null;
}

function analyzeWebCryptoSupport() {
  if (typeof window === 'undefined') {
    return {
      ok: false,
      reason: 'no-window',
      message: 'Uploads require a browser environment with Web Crypto support.',
    };
  }

  const cryptoObj = resolveCryptoGlobal();

  if (!cryptoObj) {
    return {
      ok: false,
      reason: 'missing-crypto',
      message: 'This browser does not expose the window.crypto API. Please switch to a modern browser.',
    };
  }

  if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
    return {
      ok: false,
      reason: 'insecure-context',
      message: 'Web Crypto requires a secure context (HTTPS). Please access this page over HTTPS.',
    };
  }

  const subtle = cryptoObj.subtle || cryptoObj.webkitSubtle || null;

  if (!subtle) {
    return {
      ok: false,
      reason: 'missing-subtle',
      message: 'This browser is missing crypto.subtle (Web Crypto). Update or switch to a modern browser.',
    };
  }

  return { ok: true, crypto: cryptoObj, subtle };
}

export function getWebCryptoSupport() {
  return analyzeWebCryptoSupport();
}

export function ensureWebCrypto(operation = 'Uploads') {
  const support = analyzeWebCryptoSupport();
  if (support.ok) {
    return support;
  }

  const prefix = operation ? `${operation} requires Web Crypto support.` : 'Web Crypto support is required.';
  const message = support.message ? `${prefix} ${support.message}` : prefix;
  throw new Error(message);
}

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

export async function generateAesKey(support) {
  const { subtle } = support ?? ensureWebCrypto('Generating encryption keys');
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportAesKey(key, support) {
  const { subtle } = support ?? ensureWebCrypto('Exporting encryption keys');
  const raw = await subtle.exportKey('raw', key);
  return base64UrlEncode(raw);
}

export function decodeAesKey(base64url, support) {
  const { subtle } = support ?? ensureWebCrypto('Decrypting files');
  const raw = base64UrlDecode(base64url);
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
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

export function randomBytes(length, cryptoImpl) {
  const bytes = new Uint8Array(length);
  const cryptoObj = cryptoImpl ?? resolveCryptoGlobal();
  if (!cryptoObj?.getRandomValues) {
    throw new Error('Secure random number generation requires Web Crypto support.');
  }
  cryptoObj.getRandomValues(bytes);
  return bytes.buffer;
}
