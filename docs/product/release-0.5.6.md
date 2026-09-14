# HelloDog 0.5.6

Addresses WhatsApp layout, browser actions and missing or duplicated display translations.

- The saved chat-list width targets the whole branch on both the home and conversation screens. Nested lists and archived-chat drawers follow that width. The conversation area can shrink, old overrides are restored when the branch changes, and double-click restores native widths.
- Native image context menus offer Copy image and Save image as, including decoded blob images. Links offer copy/open actions; audio and video offer Save media as. Editing actions target the correct account view and include undo, redo and plain-text paste. WhatsApp keeps its own editing/search shortcuts.
- Commas in contact names no longer classify a direct chat as a group. Media captions and message-text wrappers have additional extraction fallbacks. Reply bodies, image emoji and original message identities remain supported.
- Typographical differences in quotes, punctuation and emoji presentation no longer produce a duplicated original. English originals and English paraphrases are not used as Chinese display translations. A conservative gateway check rejects clear English sentences for incompatible script targets before character settlement, while preserving proper nouns and protected glossary literals.

Validation uses automated regression tests, browser layout/translation fixtures, native Windows image clipboard round-trip and blob download checks, packaged startup and public release hash checks. Clipboard contents are restored after testing. No real chat messages or paid translations are sent during this release verification.

Limits: these fixtures do not constitute a complete official WhatsApp feature audit or a real-contact delivery test. The gateway language check is deliberately conservative and cannot guarantee linguistic accuracy for every message. It does not retroactively rewrite settled translation records; it prevents newly observed invalid results from settling. Historical correct translations retain their existing request identities. The unrelated native Signal core is unchanged from 0.5.5.

The Windows x64 installer remains unsigned. Existing account and draft data use the same data directory. Corresponding AGPL source accompanies the release; 0.5.5 is retained for rollback.
