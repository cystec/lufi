import { toast, getWebCryptoSupport } from './utils.js';

function initNav() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.primary-nav');
  if (!toggle || !nav) return;

  const closeNav = () => {
    toggle.setAttribute('aria-expanded', 'false');
    nav.classList.remove('is-open');
  };

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    nav.classList.toggle('is-open');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeNav();
    }
  });

  nav.addEventListener('click', (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      closeNav();
    }
  });
}

function initMaxSizeDisplay() {
  const span = document.getElementById('max-size');
  if (!span) return;
  const max = Number(span.getAttribute('data-max') || '0');
  if (!max) {
    span.textContent = 'No server limit';
    return;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(max) / Math.log(1024)), units.length - 1);
  const value = max / Math.pow(1024, exponent);
  span.textContent = `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function warnIfNoCrypto() {
  const support = getWebCryptoSupport();
  if (!support.ok) {
    toast(support.message, 'danger', { timeout: 7000 });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initMaxSizeDisplay();
  warnIfNoCrypto();
});
