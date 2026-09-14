// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { ipcRenderer } from 'electron';
if (process.env.HELLODOG_EMBEDDED === '1' && process.env.HELLODOG_BRIDGE_ACTIVE === '1') {
  // DOM focus alone is insufficient in a cross-process Windows child window.
  // Do not cancel the event: native selection, emoji, IME and shortcuts keep
  // their normal behavior. Only request focus for a real user interaction.
  document.addEventListener('pointerdown', event => {
    if (event.isTrusted) ipcRenderer.send('hellodog:activate');
  }, true);
}
