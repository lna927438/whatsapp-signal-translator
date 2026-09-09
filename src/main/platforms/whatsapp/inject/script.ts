export const whatsappInjectionScript = String.raw`
(() => {
  if (window.__RT_TRANSLATOR_INSTALLED__) return;
  window.__RT_TRANSLATOR_INSTALLED__ = true;

  const RT_ATTR = 'data-rt-translated';
  let sending = false;
  let allowNativeEnterOnce = false;
  let allowNativeClickOnce = false;

  const selectors = {
    composer: [
      'footer [contenteditable="true"][role="textbox"]',
      'footer div[contenteditable="true"]',
      '#main footer [contenteditable="true"]'
    ],
    sendButton: [
      'footer button[aria-label="Send"]',
      'footer button[aria-label="发送"]',
      'footer button[aria-label*="Send"]',
      'footer [data-testid="compose-btn-send"]'
    ],
    messageText: [
      '#main [data-testid="msg-container"] span.selectable-text',
      '#main .message-in span.selectable-text',
      '#main [data-id] span.selectable-text.copyable-text',
      '#main span.selectable-text.copyable-text'
    ]
  };

  const first = (items) => {
    for (const selector of items) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  };

  const findSendButton = () => {
    const direct = first(selectors.sendButton);
    if (direct) return direct;
    const icon = document.querySelector('footer span[data-icon="send"], footer [data-icon="send"]');
    return icon?.closest('button, [role="button"]') || null;
  };

  const allMessages = () => {
    const seen = new Set();
    const out = [];
    for (const selector of selectors.messageText) {
      document.querySelectorAll(selector).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      });
    }
    return out;
  };

  const messageContainer = (el) => el.closest('[data-testid="msg-container"], .message-in, .message-out, [data-id]');

  const isOutgoing = (el) => {
    const container = messageContainer(el);
    if (!container) return false;
    if (container.matches?.('.message-out') || container.closest?.('.message-out')) return true;
    const cls = typeof container.className === 'string' ? container.className : '';
    return /(^|\s)message-out(\s|$)/.test(cls);
  };

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect?.();
    if (!rect) return true;
    return rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth;
  };

  const addTranslation = (el, text) => {
    if (!text) return;
    const container = messageContainer(el) || el.parentElement || el;
    if (container.querySelector?.(':scope > .rt-translation')) return;
    const node = document.createElement('div');
    node.className = 'rt-translation';
    node.textContent = text;
    node.setAttribute('data-rt-ui', 'translation');
    Object.assign(node.style, {
      marginTop: '4px',
      paddingTop: '4px',
      borderTop: '1px dashed rgba(120,120,120,.35)',
      fontSize: '12px',
      lineHeight: '1.35',
      opacity: '.86',
      whiteSpace: 'pre-wrap',
      userSelect: 'text'
    });
    container.appendChild(node);
  };

  const translateVisible = async () => {
    const api = window.realtimeTranslator;
    if (!api) return;
    const settings = await api.getRuntimeSettings();
    if (!settings.receiveAutoTranslate) return;

    for (const el of allMessages()) {
      if (el.getAttribute(RT_ATTR) || el.closest('.rt-translation') || !isVisible(el)) continue;
      if (isOutgoing(el)) {
        el.setAttribute(RT_ATTR, 'outgoing');
        continue;
      }
      const text = (el.innerText || el.textContent || '').trim();
      if (!text) {
        el.setAttribute(RT_ATTR, 'empty');
        continue;
      }
      el.setAttribute(RT_ATTR, 'working');
      try {
        const translated = await api.translateIncoming(text);
        if (translated && translated.trim() !== text) addTranslation(el, translated);
        el.setAttribute(RT_ATTR, 'done');
      } catch (error) {
        el.removeAttribute(RT_ATTR);
        api.notifyError?.(String(error?.message || error));
      }
    }
  };

  const replaceComposerText = (composer, text) => {
    composer.focus();
    const range = document.createRange();
    range.selectNodeContents(composer);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('insertText', false, text);
    composer.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text
    }));
  };

  const nativeSend = (composer) => {
    const button = findSendButton();
    if (button) {
      allowNativeClickOnce = true;
      button.click();
      return true;
    }
    allowNativeEnterOnce = true;
    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true
    }));
    return true;
  };

  const translateAndSend = async (composer) => {
    const api = window.realtimeTranslator;
    if (!api || sending) return false;
    const original = (composer.innerText || composer.textContent || '').trim();
    if (!original) return false;

    const settings = await api.getRuntimeSettings();
    if (!settings.sendAutoTranslate) return false;

    sending = true;
    composer.setAttribute('data-rt-sending', 'true');
    try {
      const translated = await api.translateOutgoing(original);
      replaceComposerText(composer, translated || original);
      await new Promise((resolve) => setTimeout(resolve, 90));
      nativeSend(composer);
      return true;
    } catch (error) {
      replaceComposerText(composer, original);
      api.notifyError?.(String(error?.message || error));
      return true;
    } finally {
      composer.removeAttribute('data-rt-sending');
      sending = false;
    }
  };

  document.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const composer = first(selectors.composer);
    if (!composer || !composer.contains(event.target)) return;

    if (allowNativeEnterOnce) {
      allowNativeEnterOnce = false;
      return;
    }

    const api = window.realtimeTranslator;
    if (!api) return;
    const settings = await api.getRuntimeSettings();
    if (!settings.sendAutoTranslate) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (sending) return;
    await translateAndSend(composer);
  }, true);

  document.addEventListener('click', async (event) => {
    const button = findSendButton();
    if (!button || !(event.target instanceof Node) || !button.contains(event.target)) return;

    if (allowNativeClickOnce) {
      allowNativeClickOnce = false;
      return;
    }

    const composer = first(selectors.composer);
    if (!composer) return;
    const api = window.realtimeTranslator;
    if (!api) return;
    const settings = await api.getRuntimeSettings();
    if (!settings.sendAutoTranslate) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (sending) return;
    await translateAndSend(composer);
  }, true);

  let mutationTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(translateVisible, 180);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(translateVisible, 1600);
  translateVisible();
})();
`
