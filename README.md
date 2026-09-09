# WhatsApp Signal Translator

A Windows-first Electron desktop app for **real-time precise translation** in WhatsApp and Signal.

## Current scope

- WhatsApp Web embedded in Electron
- Multiple WhatsApp accounts with isolated persistent sessions
- Incoming WhatsApp messages translated into your language
- Outgoing WhatsApp text translated before sending
- Both Enter and send-button WhatsApp sending are intercepted for translation
- Incoming translation skips outgoing WhatsApp bubbles to reduce duplicate calls
- Signal integration through `signal-cli` JSON-RPC
- Signal account linking via QR device-link URI
- Incoming/outgoing Signal text translation
- Automatic first-run Signal runtime preparation on Windows
- OpenAI / DeepL / Google Cloud Translation providers
- One translation mode only: **Precise Translation**
- API credentials stored locally with Electron `safeStorage` when available
- Translation cache to reduce duplicate calls

## Translation behavior

Precise Translation preserves meaning, names, numbers, URLs, emojis, punctuation and line breaks. It does not add explanations, answer the message, or rewrite the text stylistically.

## Translation API setup

The app does not reuse a ChatGPT login or ChatGPT subscription. Translation providers require their own API credentials.

For OpenAI:

1. Create an API key in the OpenAI API Platform.
2. Configure API billing separately from a ChatGPT subscription.
3. Paste the key into **Translation Settings**.
4. Keep `gpt-5.6-luna` for the lowest-cost GPT-5.6 translation option unless another model is preferred.
5. Click **Test API + Translation** before saving. The test uses the values currently entered in the form, so the key does not need to be saved first.

The settings screen reports common failures such as missing/invalid keys, quota/rate-limit responses, unavailable models, network timeouts and permission errors.

DeepL API Free/Pro and Google Cloud Translation API keys can also be configured from the same settings panel.

## Development

```bash
npm install
npm run dev
```

## Signal runtime

On Windows, the app can prepare its Signal runtime automatically the first time Signal is used. It downloads:

- the current `signal-cli` distribution from the upstream `AsamK/signal-cli` GitHub release;
- a Java 25 JRE from Eclipse Temurin / Adoptium.

Available SHA-256 checksums are verified before the runtime is accepted. The runtime is stored under the application's user-data directory, so the Windows installer does not need to redistribute those third-party binaries.

Manual overrides are also supported with `SIGNAL_CLI_PATH`, a `signal-cli` installation on PATH, or a compatible runtime placed under `resources/signal/` before packaging.

## Windows build

```bash
npm run dist:win
```

The GitHub Actions CI performs dependency installation, TypeScript checks, Electron production build, Windows NSIS packaging and artifact upload.

## Compatibility notes

WhatsApp Web changes its DOM regularly. Selector and interception logic is centralized in `src/main/platforms/whatsapp/inject/script.ts` so future compatibility fixes remain localized.

Signal changes server-side compatibility over time. The managed runtime fetches the current upstream signal-cli release when setup is needed.

This repository is an independent implementation. It is not affiliated with WhatsApp, Meta, Signal, OpenAI, DeepL, Google, Eclipse Temurin or Adoptium.

## Development status

The project is currently an alpha baseline. CI verifies compilation and Windows packaging; WhatsApp DOM behavior and the automatic Signal runtime/link flow still require real-account testing on a Windows desktop before release use.
