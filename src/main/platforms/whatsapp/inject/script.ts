export const whatsappInjectionScript = String.raw`
(() => {
  if (window.__RT_TRANSLATOR_INSTALLED__) return;
  window.__RT_TRANSLATOR_INSTALLED__ = true;

  const RT_ATTR = 'data-rt-translated';
  const CHINESE_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  let sending = false;
  let allowNativeEnterOnce = false;
  let allowNativeClickOnce = false;

  const selectors = {
    composer: [
      '#main footer [contenteditable="true"][role="textbox"]',
      'footer [contenteditable="true"][role="textbox"]',
      '#main footer [contenteditable="true"][data-tab]',
      'footer [contenteditable="true"][data-tab]',
      '#main footer div[contenteditable="true"]',
      'footer div[contenteditable="true"]',
      '#main [contenteditable="true"][role="textbox"][aria-placeholder]',
      '[contenteditable="true"][role="textbox"][aria-placeholder]'
    ],
    sendButton: [
      '#main footer button[aria-label="Send"]',
      '#main footer button[aria-label="发送"]',
      'footer button[aria-label="Send"]',
      'footer button[aria-label="发送"]',
      'footer button[aria-label*="Send"]',
      'footer button[aria-label*="发送"]',
      'footer [data-testid="compose-btn-send"]',
      'footer [data-testid*="send"]'
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

  const composerText = (composer) => (composer?.innerText || composer?.textContent || '').replace(/\u00a0/g, ' ').trim();
  const containsChinese = (text) => CHINESE_RE.test(String(text || ''));

  const getComposer = (target) => {
    const targetElement = target instanceof Element ? target : target?.parentElement;
    const direct = targetElement?.closest?.('[contenteditable="true"][role="textbox"], [contenteditable="true"][data-tab]');
    if (direct && (direct.closest('footer') || direct.closest('#main'))) return direct;
    return first(selectors.composer);
  };

  const findSendButton = () => {
    const direct = first(selectors.sendButton);
    if (direct) return direct;
    const icon = document.querySelector(
      '#main footer span[data-icon="send"], #main footer [data-icon="send"], footer [data-icon*="send"], footer [data-testid*="send"]'
    );
    return icon?.closest('button, [role="button"]') || null;
  };

  const isSendTarget = (target) => {
    if (!(target instanceof Node)) return false;
    const known = findSendButton();
    if (known && (known === target || known.contains(target))) return true;
    const element = target instanceof Element ? target : target.parentElement;
    const button = element?.closest?.('button, [role="button"]');
    if (!button || !button.closest('footer')) return false;
    const marker = [
      button.getAttribute('aria-label') || '',
      button.getAttribute('data-testid') || '',
      button.getAttribute('data-icon') || ''
    ].join(' ').toLowerCase();
    if (marker.includes('send') || marker.includes('发送')) return true;
    return Boolean(button.querySelector('[data-icon*="send"], [data-testid*="send"]'));
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

  const isGroupChat = () => {
    const header = document.querySelector('#main header');
    if (!header) return false;
    if (header.querySelector('[data-icon*="group"], [data-testid*="group"]')) return true;
    const text = (header.innerText || '').replace(/\s+/g, ' ').trim();
    return /,\s*[^,]+/.test(text) && text.length > 12;
  };

  const addTranslation = (el, text, settings) => {
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
      fontSize: String(Number(settings?.fontSize || 13)) + 'px',
      lineHeight: '1.38',
      color: settings?.translationColor || '#c8d4e4',
      opacity: '.94',
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
    if (!settings.groupTranslate && isGroupChat()) return;

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
        if (translated && translated.trim() !== text) addTranslation(el, translated, settings);
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

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (_) {
      inserted = false;
    }

    if (!inserted || composerText(composer) !== String(text).trim()) {
      while (composer.firstChild) composer.removeChild(composer.firstChild);
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      composer.appendChild(paragraph);
    }

    composer.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: text
    }));
    composer.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  };

  const waitForComposer = async (composer, expected) => {
    const wanted = String(expected || '').trim();
    for (let i = 0; i < 12; i += 1) {
      if (composerText(composer) === wanted) return true;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    return composerText(composer) === wanted;
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
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
    return true;
  };

  const processSend = async (composer) => {
    const api = window.realtimeTranslator;
    if (!api) return;
    const original = composerText(composer);
    if (!original) return;

    try {
      const settings = await api.getRuntimeSettings();
      const blockChinese = settings.blockChineseSend !== false;

      if (!settings.sendAutoTranslate) {
        if (blockChinese && containsChinese(original)) {
          api.notifyError?.('已开启“禁止发送中文”。请开启发送翻译，或直接输入目标语言。');
          return;
        }
        nativeSend(composer);
        return;
      }

      const translated = await api.translateOutgoing(original);
      const finalText = String(translated || '').trim();
      if (!finalText) throw new Error('翻译结果为空，已阻止发送。');
      if (blockChinese && containsChinese(finalText)) {
        throw new Error('翻译结果仍包含中文，已阻止发送。请检查目标语言或 API 设置。');
      }

      replaceComposerText(composer, finalText);
      const updated = await waitForComposer(composer, finalText);
      if (!updated) throw new Error('无法把译文写入 WhatsApp 输入框，已阻止发送。');

      const currentText = composerText(composer);
      if (blockChinese && containsChinese(currentText)) {
        throw new Error('输入框仍包含中文，已阻止发送，避免原文误发。');
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      nativeSend(composer);
    } catch (error) {
      if (composerText(composer) !== original) replaceComposerText(composer, original);
      api.notifyError?.(String(error?.message || error));
    }
  };

  const interceptSendNow = (event, composer) => {
    // Critical: prevent WhatsApp's native handler synchronously. Waiting for
    // an IPC/settings promise before preventDefault lets the original Chinese
    // message escape before translation finishes.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (sending) return;
    sending = true;
    composer.setAttribute('data-rt-sending', 'true');
    void processSend(composer).finally(() => {
      composer.removeAttribute('data-rt-sending');
      sending = false;
    });
  };

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const composer = getComposer(event.target);
    if (!composer || !composer.contains(event.target)) return;

    if (allowNativeEnterOnce) {
      allowNativeEnterOnce = false;
      return;
    }

    interceptSendNow(event, composer);
  }, true);

  document.addEventListener('beforeinput', (event) => {
    if (event.inputType !== 'insertParagraph' || event.isComposing) return;
    const composer = getComposer(event.target);
    if (!composer || !composer.contains(event.target)) return;
    if (allowNativeEnterOnce) return;
    interceptSendNow(event, composer);
  }, true);

  document.addEventListener('click', (event) => {
    if (!isSendTarget(event.target)) return;

    if (allowNativeClickOnce) {
      allowNativeClickOnce = false;
      return;
    }

    const composer = getComposer(event.target);
    if (!composer) return;
    interceptSendNow(event, composer);
  }, true);

  let mutationTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(translateVisible, 180);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(translateVisible, 1400);
  translateVisible();
})();
`
