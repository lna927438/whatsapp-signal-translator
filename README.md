# WhatsApp Signal Translator v0.1

A Windows-first Electron desktop app for **real-time precise translation** in WhatsApp and Signal.

## v0.1 scope

- WhatsApp Web embedded in Electron
- Multiple WhatsApp accounts with isolated persistent sessions
- Incoming WhatsApp messages translated into your language
- Outgoing WhatsApp text translated before sending
- Signal integration through `signal-cli` JSON-RPC
- Signal account linking via QR device-link URI
- Incoming/outgoing Signal text translation
- OpenAI / DeepL / Google Translate providers
- One translation mode only: **Precise Translation**
- API credentials stored locally with Electron `safeStorage` when available
- Translation cache to reduce duplicate calls

## Translation behavior

Precise Translation preserves meaning, names, numbers, URLs, emojis, punctuation and line breaks. It does not add explanations or rewrite the text stylistically.

## Setup

```bash
npm install
npm run dev
```

For Signal, install a current `signal-cli` build and either:

1. put it on PATH, or
2. set `SIGNAL_CLI_PATH`, or
3. copy it under `resources/signal/` before packaging.

The application starts signal-cli in multi-account JSON-RPC mode and listens for receive notifications.

## Windows build

```bash
npm run dist:win
```

## Notes

WhatsApp Web changes its DOM regularly. All selector logic is centralized in `src/main/platforms/whatsapp/inject/script.ts` so future compatibility fixes remain localized.

Signal changes server-side compatibility over time. Keep `signal-cli` current.

This repository is an independent implementation. It is not affiliated with WhatsApp, Meta, Signal, OpenAI, DeepL or Google.

## Development status

`v0.1` is an initial functional baseline. WhatsApp DOM selectors and packaged Signal runtime still need real-device validation on Windows before release use.
