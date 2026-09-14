# HelloDog 0.5.5

This release addresses user reports of missing historical and reply translations, emoji-bearing text, and duplicate Windows tray icons.

- WhatsApp distinguishes a quoted region from the surrounding reply body. It falls back to the body after filtering quoted candidates, reads nested text once, and preserves image-backed emoji.
- Pure emoji does not invoke paid translation. Completed message translations are reused when upgrading from the old emoji extraction, including after cache clearing and restart.
- Historical message failures have individual backoff and an inline Retry action. A confirmed uncharged failure permits two durable automatic recovery attempts; unknown/pending results keep the original request. Concurrent scans share each recovery attempt. Sending messages remains under the existing native send queue.
- Provider literal restoration accepts escaped placeholders and exact literal values with the original multiplicity. Changed, missing or duplicated literals remain rejected. Literal mismatch has a distinct diagnostic code.
- The rebuilt Signal core does not create a tray service when managed by HelloDog. Managed native windows skip independent taskbar entries and use HelloDog's icon and Windows application identity. Native notifications route through the bound HelloDog account without forwarding chat bodies. Unrelated Signal or other software installations remain independent.

Validation: automated regressions, 90-message Chromium DOM history/reply/emoji fixture, packaged HelloDog startup, rebuilt Signal startup in isolated empty profiles, notification routing instrumentation, source/package integrity, and public download hashes. Fixtures do not prove real contact delivery or all Windows notification settings. No real chat messages are sent for this release validation.

Distribution remains Windows x64 with an unsigned installer and corresponding AGPL source. Existing user data is retained. Version 0.5.4 remains available for rollback. Packages and payment features are unchanged.
