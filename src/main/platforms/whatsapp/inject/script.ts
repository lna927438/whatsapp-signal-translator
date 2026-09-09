export const whatsappInjectionScript = String.raw`
(() => {
  if (window.__RT_TRANSLATOR_INSTALLED__) return;
  window.__RT_TRANSLATOR_INSTALLED__ = true;

  const RT_ATTR = 'data-rt-translated';
  let sending = false;
  let allowNativeEnterOnce = false;

  const selectors = {
    composer: [
      'footer [contenteditable="true"][role="textbox"]',
      'footer [contenteditable="true"]'
    ],
    sendButton: [
      'footer button[aria-label*="Send"]',
      'footer button[aria-label*="发送"]',
      'footer [data-testid="compose-btn-send"]'
    ],
    messageText: [
      '#main [data-testid="msg-container"] span.selectable-text',
      '#main [data-id] span.selectable-text',
      '#main span.selectable-text.copyable-text'
    ]
  };

  const first = (items) => {
    for (const s of items) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };

  const allMessages = () => {
    const seen = new Set();
    const out = [];
    for (const s of selectors.messageText) {
      document.querySelectorAll(s).forEach((el) => {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      });
    }
    return out;
  };

  const addTranslation = (el, text) => {
    if (!text || el.querySelector?.(':scope > .rt-translation')) return;
    const node = document.createElement('div');
    node.className = 'rt-translation';
    node.textContent = text;
    Object.assign(node.style, {
      marginTop: '4px', paddingTop: '4px', borderTop: '1px dashed rgba(120,120,120,.35)',
      fontSize: '12px', lineHeight: '1.35', opacity: '.86', whiteSpace: 'pre-wrap'
    });
    el.appendChild(node);
  };

  const translateVisible = async () => {
    const api = window.realtimeTranslator;
    if (!api) return;
    const settings = await api.getRuntimeSettings();
    if (!settings.receiveAutoTranslate) return;
    for (const el of allMessages()) {
      if (el.getAttribute(RT_ATTR) || el.closest('.rt-translation')) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (!text) { el.setAttribute(RT_ATTR, 'empty'); continue; }
      el.setAttribute(RT_ATTR, 'working');
      try {
        const translated = await api.translateIncoming(text);
        if (translated && translated.trim() !== text) addTranslation(el, translated);
        el.setAttribute(RT_ATTR, 'done');
      } catch (e) {
        el.removeAttribute(RT_ATTR);
      }
    }
  };

  const replaceComposerText = (composer, text) => {
    composer.focus();
    const range = document.createRange();
    range.selectNodeContents(composer);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  };

  const nativeSend = () => {
    const direct = first(selectors.sendButton);
    if (direct) { direct.click(); return true; }
    const icon = document.querySelector('footer span[data-icon="send"]');
    const button = icon?.closest('button, [role="button"]');
    if (button) { button.click(); return true; }
    return false;
  };

  document.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const composer = first(selectors.composer);
    if (!composer || !composer.contains(event.target)) return;
    if (allowNativeEnterOnce) { allowNativeEnterOnce = false; return; }
    if (sending) { event.preventDefault(); event.stopImmediatePropagation(); return; }

    const api = window.realtimeTranslator;
    if (!api) return;
    const settings = await api.getRuntimeSettings();
    if (!settings.sendAutoTranslate) return;

    const original = (composer.innerText || composer.textContent || '').trim();
    if (!original) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    sending = true;
    try {
      const translated = await api.translateOutgoing(original);
      replaceComposerText(composer, translated || original);
      await new Promise((r) => setTimeout(r, 80));
      if (!nativeSend()) {
        allowNativeEnterOnce = true;
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      }
    } catch (e) {
      api.notifyError?.(String(e?.message || e));
    } finally {
      sending = false;
    }
  }, true);

  const observer = new MutationObserver(() => { clearTimeout(window.__RT_TIMER__); window.__RT_TIMER__ = setTimeout(translateVisible, 180); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(translateVisible, 1800);
  translateVisible();
})();
`
