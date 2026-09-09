Signal runtime notes

The Windows app can prepare Signal automatically on first use.
It downloads the current signal-cli distribution from the upstream AsamK/signal-cli GitHub release and a Java 25 JRE from Eclipse Temurin / Adoptium, verifies available SHA-256 checksums, and installs them under the app user-data directory.

No signal-cli or Java binaries are committed to this repository or bundled by default.

Manual overrides remain supported:
- set SIGNAL_CLI_PATH
- put signal-cli on PATH
- or place a compatible distribution under resources/signal/bin/ before packaging

signal-cli is an independent GPLv3 project and Signal compatibility can change over time, so the managed runtime should be kept current.
