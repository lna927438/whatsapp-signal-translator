# Signal Desktop integration for HelloDog

This distribution contains Signal Desktop v8.27.0, commit `1a1d65153be546836d5948cb50493d4d1d293d02`, with the HelloDog integration patches. It is a modified build, not an official Signal release. Upstream license and copyright notices are retained.

The official composer, emoji/sticker/GIF components, attachment pipeline, encrypted database, libsignal, RingRTC, settings and contact views are compiled together. Each HelloDog account owns a separate core process and profile under `signal-desktop-profiles/<owner hash>/<account hash>`. The core never opens the installed Signal or signal-cli profile. Phone linking is required for each new official-core profile.

HelloDog embeds the core's own window through a process-checked native helper. Translation uses inherited private process IPC. A normal outgoing message is translated inside Signal's persisted send job, then saved before encryption and transmission. The native message ID identifies retries. Emoji-only and attachment-only sends do not invoke translation. Incoming annotations reuse cached requests. Rich-text ranges and edited messages currently retain native sending without automatic translation; these cases are not accepted as translated-feature parity.

The verification workflow covers core compilation/typecheck, linking UI, isolated core processes, repeated open coalescing, window resize/overlay visibility, graceful shutdown, reopening a profile, and translation persistence/retry/erasure. Browser media checks do not prove phone linking, recipient delivery, stickers/GIF delivery or a real call. Consult the matching version's release notes and release-manifest.json for checks actually completed with that build.

## Rebuild locally on Windows x64

1. Use a short checkout directory, such as `C:\HelloDogBuild\signal-desktop`. Windows native tools and Chromium storage may fail with overly long paths.
2. Clone the upstream tag from `signal-desktop.lock.json` under `integrations/signal-desktop`, or use a directory junction to a short checkout. Overlay the patched source from the corresponding-source archive. Do not point it at an installed Signal profile.
3. Run `scripts/prepare-signal-build.ps1`, `scripts/build-signal-desktop.ps1`, `scripts/build-native-host.ps1`, and `scripts/package-signal-desktop.ps1`. Node 24.17.0, pnpm 11.5.2, Python and Visual Studio 2022 C++/Windows SDK are required. Downloads are pinned and verified. Adjust the script's Python path to your installation.
4. Install HelloDog dependencies from the root lockfile and build/package HelloDog. The security candidate includes the tested core from `integrations/signal-desktop/release/hellodog-security-core/win-unpacked`. The previous core is retained. `scripts/verify-signal-security.mjs` checks the maintained dependency patch, runtime boundary behavior and exact files inside the packaged archive before HelloDog packaging.
5. Launch HelloDog with `--isolated-test --test-profile=your-test-name` for a separate test profile. This mode does not change login startup settings.

`scripts/export-signal-source.py` exports the patched core and HelloDog source used for the version in package.json, excluding account profiles, credentials, logs and dependencies. The packaged `integrations/notices/SOURCE.txt` and release manifest identify its corresponding source artifact and checksum. Local candidate builds are not automatically published.
