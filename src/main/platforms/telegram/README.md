# Telegram Web A integration

HelloDog embeds the official `https://web.telegram.org/a/` application. It does not ship a fork, access Telegram credentials or call private Telegram APIs. Each HelloDog account owns a separate persistent browser partition and proxy.

DOM contract reviewed against the official project on 2026-10-12:

- https://github.com/Ajaxy/telegram-tt/blob/master/src/config.ts — `editable-message-text`, `editable-message-text-modal`.
- https://github.com/Ajaxy/telegram-tt/blob/master/src/util/routing.ts — numeric peer and thread in location hash.
- https://github.com/Ajaxy/telegram-tt/blob/master/src/components/middle/message/Message.tsx — `.Message[data-message-id]`, `.own`, `.message-content`, `.text-content`.
- https://github.com/Ajaxy/telegram-tt/blob/master/src/components/common/Composer.tsx — `.main-button.send` and distinct recording/edit/schedule states.
- https://github.com/Ajaxy/telegram-tt/blob/master/src/components/middle/MessageListContent.tsx — a `MessageListBottomMarker` is rendered only when `isViewportNewest` is true. `MessageListBottomMarker.tsx` renders `.list-bottom-marker`. HelloDog checks this marker is in the owned list's visible bounds immediately before the native click, and snapshots all current server IDs at that same moment. Sending from an older viewport, a loading list, or an empty list without a known message ID remains uncertain; later loaded equal-text history must never confirm that send.

Uncertain sends have a local reconciliation panel showing the original and translation. After checking the official chat record, the user can mark the existing task sent or not sent. Neither action sends, retranslates, or creates a task. A not-sent confirmation restores the original only into the unchanged/empty original editor; other drafts are preserved. Submitting tasks cannot be manually unlocked, and stale controls cannot affect another conversation. Pending records are recovered when reopening their conversation.
- https://github.com/Ajaxy/telegram-tt/blob/master/src/components/middle/composer/AttachmentModal.tsx — isolated caption editor and send icon.
- https://github.com/Ajaxy/telegram-tt/blob/master/src/util/audioPlayback/mediaPool.ts — current official audio elements may remain detached from the DOM. HelloDog only uses audio URLs with a provable row owner. If not available, its voice button opens a local audio-file picker so a downloaded voice message can still produce bilingual text in that same bubble. It never guesses the owner of a global audio player.

The send pipeline persists an intent before translation, previews the result, validates the exact route/editor/attachment snapshot again and commits once. A new positive server message ID with an official receipt is required for confirmation. Emptying the composer alone is insufficient. Uncertain results are reconciled without replaying a send.

No real Telegram account or live-recipient acceptance is implied by DOM regression tests. Login, proxy reconnection, text/photo delivery and downloaded voice selection require manual account acceptance before public release.
