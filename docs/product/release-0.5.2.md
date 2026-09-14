# HelloDog 0.5.2

Windows x64 release containing the HelloDog workspace and modified Signal Desktop v8.27.0.

Includes queued translation sends, persisted request identifiers, cache restoration without a new charge, draft recovery, compact account icons, a resizable WhatsApp conversation list, and Signal native composer focus fixes. Cloud account balances and translation usage use the same account as the administrator console. Packages and payments are not enabled.

Signal includes the upstream media, emoji, sticker, GIF, settings, contact, and calling components. The integration is a modified build, not an official Signal distribution. Each account has its own linked-device profile. Rich-text and edited Signal messages currently use native sending without automatic translation. Real recipient delivery, calls, and every network/device combination have not all been independently verified.

Normal installations preserve the previous HelloDog production profile. Local test shortcuts using `--isolated-test` keep their separate test profiles; they are not automatically merged into production. Finish pending sends before changing versions. The installer is unsigned; its SHA-256 and corresponding source are provided on the download page.

Source: https://download.hellodog.net/sources/v0.5.2/HelloDog-0.5.2-corresponding-source.zip

Build instructions: `integrations/README.md`. Signal upstream licensing and copyright notices are in `integrations/notices`. The source archive excludes account profiles, credentials, chat records, and internal operations notes.
