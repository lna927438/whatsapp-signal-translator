Signal components for the HelloDog Windows test build

Run scripts/prepare-signal-bundle.mjs before packaging. It prepares the pinned signal-cli 0.14.7 and Eclipse Temurin JRE 25.0.4.1+1 distributions, verifies their published SHA-256 checksums, and copies the runtime under bin/, lib/ and jre/.

These generated binary directories are ignored by Git and included by electron-builder extraResources. SOURCE.txt, signal-cli-LICENSE.txt and the Java legal directory preserve upstream notices and source locations.

A completed managed repair/update takes precedence over the bundled version. An explicit SIGNAL_CLI_PATH remains supported. Signal account data is separate from the runtime and is never removed by repair.

Automated application tests use the development Electron runtime with HELLODOG_TEST_USER_DATA and verify the resolved path. Signal process tests always pass an explicit isolated --data-dir. Never launch the packaged executable against a real profile for unattended checks.
