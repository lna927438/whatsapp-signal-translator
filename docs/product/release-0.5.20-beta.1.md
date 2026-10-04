# HelloDog 0.5.20-beta.1 — reliability acceptance candidate

This is a local candidate, not an approved production release. The published desktop remains 0.5.19. Preserve the current user profile and complete device acceptance before publishing or replacing the installed client.

## Behavior changes

- Preserve source-authored paragraph separators and deliberate spacing during outgoing translation. Compact model-added paragraph breaks and extra spaces before restoring protected literal data. Reject missing or reordered layout placeholders before customer settlement.
- Read WhatsApp composer structure without treating CSS paragraph margins or visual wrapping as authored blank lines. Preserve image emoji and validate the exact outgoing body at dispatch, including attachment-caption Enter and long translated bodies.
- Reject late Signal authorization when the draft was changed, erased, or expired while translation was pending, even when the earlier result said no translation was needed.
- Reject recovered or manually corrected outgoing translations that still contain Chinese when the selected foreign target forbids it. Keep the original charge and draft for correction.
- Recover uncertain translations by querying the same request ID, with paced retries and no second translation submission. Translation network, identity refresh and capability waits share a 42-second deadline; local storage and operating-system scheduling can add time.
- Revoke old-account delivery after account switching. Release WhatsApp voice observers, listeners and timers on page teardown and ignore late voice results.
- Look up a single local receipt by its exact owner and request ID without sorting the full journal.
- Validate client character-wallet snapshots consistently. Preserve previously confirmed values when a read or update payload fails validation.
- Isolate a provider statement-read failure from the other provider and character totals. Keep authorization failures closed. Correct GMT+8 month-boundary filters and reject invalid balances, amounts and timestamps.
- Retain exact monetary arithmetic with two-decimal display. Explain that totals use original precision. Keep DeepSeek automatic cumulative paid consumption separate from its manually recorded monthly statements.

## Verification and release boundary

Automated checks cover transaction idempotency, protected text and layout, interrupted network recovery, account switching, sending and attachment guards, voice lifecycle, balance snapshots, admin failures and business timezones. Isolated Edge fixtures do not send messages to real contacts or establish real-provider semantic accuracy.

The Signal core is rebuilt from the pinned upstream 8.27.0 source with the accepted 0.5.19 voice fixes retained. Package checks compare compiled files, embedded core and voice resources, security fuses, and source archives.

Real-device acceptance must confirm ordinary and attachment sends, deliberate multi-line text, input method composition, network recovery, window/account switching, voice translation and draft preservation. Do not test by sending unsolicited messages to existing contacts.

## Database deployment note

No new database migration is required for these fixes. Three historical migration sources restored from the already-published web branch have different local and production timestamps. Do not blindly apply them again:

| Local source ID | Existing production ID |
| --- | --- |
| 20260924012152 | 20260924014353 |
| 20260924020814 | 20260924021444 |
| 20260924021637 | 20260924022125 |

Production database checks in this task were read-only. No customer balance, official statement, authentication policy, or chat data was changed.
