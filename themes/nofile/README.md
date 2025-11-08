# nofile.in theme

This theme provides a neon dark, fully white-label experience for `nofile.in`. All public copy refers to the brand only and the UI never exposes the underlying platform name.

## Installation
- Copy the `themes/nofile` directory into your Lufi deployment.
- In `lufi.conf`, set `theme => "nofile"` and restart the application.
- Ensure the public assets are served from `/assets/...`; the layout references these paths directly.

## Email and invitations
- The UI removes every email sharing entry point. Keep `mail => undef` or the equivalent disabled block in `lufi.conf`.
- Guest invitations remain optional. When enabled, uploaded links are still pushed to the server (without any mailer UI) through the existing guest webhook.

## Report button
- The file view includes a “Report file” action that links to `mailto:shubham@nofile.in?subject=[Report] nofile.in&body=<metadata>`.
- If you prefer a server endpoint, change the anchor in `templates/render.html.ep` to point to your abuse form; the JS layer does not depend on the current `mailto`.

## Color tokens
Defined in `assets/css/nofile.css`:
- `--bg`: `#05070a`
- `--panel`: `#0f1115`
- `--text`: `#e7e7ec`
- `--muted`: `#9aa1aa`
- `--accent`: `#2eff84`
- `--accent-2`: `#2bc4ff`
- `--danger`: `#ff4d4d`
- `--warning`: `#f5a623`
- `--success`: `#2ecc71`

Adjusting these variables updates the complete palette, including focus rings, buttons, and toasts.

## Encryption flow
- The uploader uses Web Crypto with AES-GCM 256-bit keys. A unique key is generated per file and exported in base64url format.
- Every slice receives a fresh IV derived from secure randomness plus the chunk index.
- Ciphertext and IV are stored server side alongside existing metadata. The key never leaves the browser.
- The share link embeds the key in the fragment. LocalStorage retains only the moderation token, URLs, and encryption key.
- The file viewer reads the fragment, imports the key, and decrypts each slice with Web Crypto before streaming the Blob to the user.
- No analytics calls touch the fragment. Avoid stripping the `#` portion when sharing links.

## Accessibility checks
- Keyboard: header nav, dropzone, upload option toggles, and file actions are reachable and have visible focus styles.
- Drag and drop: the dropzone reacts to keyboard activation (Enter or Space) and exposes status updates via `aria-live`.
- Contrast: tested against WCAG AA using the token palette; text on `--panel` backgrounds exceeds contrast 4.5:1.
- Reduced motion: global media query removes transitions for users who prefer reduced motion.

## Lighthouse targets
- Performance ≥ 95, Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 90 on standard hardware with production builds.
- Critical CSS is compact, JS bundles avoid large third-party libraries, and all scripts load using `type="module"` and `defer`.

## Static resources
- `robots.txt` allows crawlers on public routes while excluding dynamic file endpoints.
- `sitemap.xml` lists Upload, My files, About, and Privacy pages.
- `assets/site.webmanifest` plus PNG/SVG icons provide favicon, maskable, and installable support.

## Development notes
- JS modules live in `assets/js/` and share helpers through `utils.js`.
- The uploader removes the historical mail-to features. Keep corresponding server settings disabled to prevent orphan routes.
- Always maintain the fragment handling contract: never log, store, or transmit key fragments outside the client.
