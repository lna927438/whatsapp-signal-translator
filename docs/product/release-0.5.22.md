# HelloDog 0.5.22

The owner authorized production publication on 2026-10-12 after final-source verification, followed by safe cleanup of obsolete artifacts. This supersedes the earlier local-beta-only instruction.

## Voice translation

- Restore missing voice controls across supported WhatsApp, Telegram and Google Voice message/player structures; retain Signal voice support.
- English and Chinese are displayed inside the original voice bubble after the user clicks the translation control. Original audio is preserved. No automatic chat messages or background transcription are introduced.
- Use directly readable media only when its ownership can be tied to the current message and account. Otherwise select the audio downloaded from that message. Google Voice support includes visible voicemail/audio players, not new audio-SMS sending or live-call translation.
- Preserve strict cancellation on changed account, route, message or source. Stable completed Google Voice results survive the official player's explicit hidden-audio unload. Pending work and genuinely replaced audio do not inherit the old result.
- Preserve message-specific translation and billing identities, retry settlement, file limits and resource integrity verification.

## Responsiveness

- Batch idle WhatsApp mutation scanning, index audio once per scan and suspend unnecessary full scans in hidden windows; retain immediate invalidation of pending work.
- Ignore Telegram playback-presentation-only mutations without ignoring new media, message identity or privacy changes.
- Suspend hidden Google Voice full-page scans and refresh on visibility. Decode and IPC watchdogs restore a usable retry state after a prolonged wait; late results are discarded.
- Stream the local recognizer model hash in bounded chunks instead of allocating the whole model at once. Every recognition task still verifies all resources. The existing one-job queue, CPU limit and native timeout remain in place.

## Verification and limits

Final commit-bound test, build, installer extraction, corresponding-source, package integrity and publication evidence is recorded in the local release verification directory. Synthetic browser fixtures cover controls, bilingual layout, navigation, file ownership, timeouts and scanning. Local speech recognition is tested with generated audio; these checks are distinct from live provider and account acceptance.

The owner currently has no accounts available to repeat the repaired WhatsApp, Telegram or Google Voice end-to-end flows. Signal and earlier Telegram bilingual display had prior user confirmation, which does not establish acceptance of every current official page variant. No live messages are sent as part of release verification. Local processing improvements do not guarantee a fixed end-to-end speedup on every machine or network.

This release changes the desktop and public website release/guide content. It requires no API deployment, database migration or billing configuration changes. Retain the previous stable installer, source and signed metadata for rollback, plus website chunks used by already-open admin tabs. Cleanup must preserve running applications, accounts, drafts, sources, models and required dependency junctions.
