export const whatsappInjectionScript = String.raw`
(() => {
  if (window.__RT_TRANSLATOR_INSTALLED__) return;
  window.__RT_TRANSLATOR_INSTALLED__ = true;

  const RT_ATTR = 'data-rt-translated';
  const CHINESE_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  let sending = false;
  let nativeBypassUntil = 0;
  let statusTimer;

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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const composerText = (composer) => (composer?.innerText || composer?.textContent || '').replace(/\u00a0/g, ' ').trim();
  const containsChinese = (text) => CHINESE_RE.test(String(text || ''));
  const bypassNative = () => Date.now() < nativeBypassUntil;

  const showSendStatus = (message, type = 'working', autoHide = true) => {
    let box = document.getElementById('rt-send-status');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rt-send-status';
      box.setAttribute('data-rt-ui', 'send-status');
      Object.assign(box.style, {
        position: 'fixed',
        top: '76px',
        right: '18px',
        zIndex: '2147483647',
        maxWidth: '420px',
        padding: '10px 14px',
        borderRadius: '10px',
        fontSize: '13px',
        lineHeight: '1.45',
        color: '#fff',
        boxShadow: '0 8px 28px rgba(0,0,0,.28)',
        pointerEvents: 'none',
        transition: 'opacity .18s ease',
        opacity: '1'
      });
      document.body.appendChild(box);
    }
    clearTimeout(statusTimer);
    box.textContent = message;
    box.style.background = type === 'error' ? '#a72b3a' : type === 'success' ? '#176b4d' : '#2456a6';
    box.style.opacity = '1';
    if (autoHide) {
      statusTimer = setTimeout(() => { if (box) box.style.opacity = '0'; }, type === 'error' ? 6000 : 2200);
    }
  };

  const getComposer = (target) => {
    const targetElement = target instanceof Element ? target : target?.parentElement;
    const direct = targetElement?.closest?.('[contenteditable="true"][role="textbox"], [contenteditable="true"][data-tab]');
    if (direct && (direct.closest('footer') || direct.closest('#main'))) return direct;
    return first(selectors.composer);
  };

  const findSendButton = () => {
    const direct = first(selectors.sendButton);
    if (direct) return direct;
    const icon = document.querySelector('#main footer span[data-icon="send"], #main footer [data-icon="send"], footer [data-icon*="send"], footer [data-testid*="send"]');
    return icon?.closest('button, [role="button"]') || null;
  };

  const isSendTarget = (target) => {
    if (!(target instanceof Node)) return false;
    const known = findSendButton();
    if (known && (known === target || known.contains(target))) return true;
    const element = target instanceof Element ? target : target.parentElement;
    const button = element?.closest?.('button, [role="button"]');
    if (!button || !button.closest('footer')) return false;
    const marker = [button.getAttribute('aria-label') || '', button.getAttribute('data-testid') || '', button.getAttribute('data-icon') || ''].join(' ').toLowerCase();
    if (marker.includes('send') || marker.includes('发送')) return true;
    return Boolean(button.querySelector('[data-icon*="send"], [data-testid*="send"]'));
  };

  const allMessages = () => {
    const seen = new Set();
    const out = [];
    for (const selector of selectors.messageText) {
      document.querySelectorAll(selector).forEach((el) => {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
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
      marginTop: '4px', paddingTop: '4px', borderTop: '1px dashed rgba(120,120,120,.35)',
      fontSize: String(Number(settings?.fontSize || 13)) + 'px', lineHeight: '1.38',
      color: settings?.translationColor || '#c8d4e4', opacity: '.94', whiteSpace: 'pre-wrap', userSelect: 'text'
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
      if (isOutgoing(el)) { el.setAttribute(RT_ATTR, 'outgoing'); continue; }
      const text = (el.innerText || el.textContent || '').trim();
      if (!text) { el.setAttribute(RT_ATTR, 'empty'); continue; }
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
    try { inserted = document.execCommand('insertText', false, text); } catch (_) { inserted = false; }
    if (!inserted || composerText(composer) !== String(text).trim()) {
      while (composer.firstChild) composer.removeChild(composer.firstChild);
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      composer.appendChild(paragraph);
    }
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    composer.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  };

  const waitForSendCompletion = async (composer, original, finalText) => {
    let sawTranslated = false;
    for (let i = 0; i < 36; i += 1) {
      const current = composerText(composer);
      if (!current) return true;
      if (current === finalText) sawTranslated = true;
      if (sawTranslated && current !== finalText) return true;
      await sleep(50);
    }
    const current = composerText(composer);
    return !current || (sawTranslated && current !== finalText && current !== original);
  };

  const nativeSend = async (composer, api) => {
    composer.focus();
    nativeBypassUntil = Date.now() + 1800;
    if (typeof api.sendNativeEnter === 'function' && await api.sendNativeEnter()) return true;
    const button = findSendButton();
    if (button) { button.click(); return true; }
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
    return true;
  };

  const commitTranslatedSend = async (composer, api, finalText) => {
    composer.focus();
    nativeBypassUntil = Date.now() + 2600;
    if (typeof api.commitTranslatedSend === 'function') {
      const accepted = await api.commitTranslatedSend(finalText);
      if (accepted) return true;
    }
    // Backward-compatible fallback if the native editor bridge is unavailable.
    replaceComposerText(composer, finalText);
    await sleep(100);
    return nativeSend(composer, api);
  };

  const processSend = async (composer) => {
    const api = window.realtimeTranslator;
    if (!api) {
      showSendStatus('翻译桥接未加载，已阻止发送。请重新打开该 WhatsApp 窗口。', 'error');
      return;
    }
    const original = composerText(composer);
    if (!original) return;

    try {
      showSendStatus('正在翻译并准备发送…', 'working', false);
      const settings = await api.getRuntimeSettings();
      const blockChinese = settings.blockChineseSend !== false;

      if (!settings.sendAutoTranslate) {
        if (blockChinese && containsChinese(original)) throw new Error('已开启“禁止发送中文”。请开启发送翻译，或直接输入目标语言。');
        showSendStatus('发送翻译已关闭，正在按原文发送…', 'working', false);
        if (!await nativeSend(composer, api)) throw new Error('WhatsApp 原生发送动作未触发。');
        return;
      }

      const translated = await api.translateOutgoing(original);
      const finalText = String(translated || '').trim();
      if (!finalText) throw new Error('翻译结果为空，已阻止发送。');
      if (blockChinese && containsChinese(finalText)) throw new Error('翻译结果仍包含中文，已阻止发送。请检查目标语言或 API 设置。');

      showSendStatus('翻译完成，正在通过 WhatsApp 原生输入发送…', 'working', false);
      if (!await commitTranslatedSend(composer, api, finalText)) throw new Error('无法提交译文到 WhatsApp 输入框。');

      const completed = await waitForSendCompletion(composer, original, finalText);
      if (!completed) throw new Error('译文已生成，但 WhatsApp 没有完成发送。中文原文没有被发送，请重试。');
      showSendStatus('已发送目标语言译文。', 'success');
    } catch (error) {
      const message = String(error?.message || error);
      const current = composerText(composer);
      if (!current) {
        showSendStatus('消息已发送。', 'success');
        return;
      }
      if (current !== original) replaceComposerText(composer, original);
      showSendStatus(message, 'error');
      api.notifyError?.(message);
    }
  };

  const interceptSendNow = (event, composer) => {
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
    if (bypassNative()) return;
    const composer = getComposer(event.target);
    if (!composer || !composer.contains(event.target)) return;
    interceptSendNow(event, composer);
  }, true);

  document.addEventListener('beforeinput', (event) => {
    if (event.inputType !== 'insertParagraph' || event.isComposing) return;
    if (bypassNative()) return;
    const composer = getComposer(event.target);
    if (!composer || !composer.contains(event.target)) return;
    interceptSendNow(event, composer);
  }, true);

  document.addEventListener('click', (event) => {
    if (bypassNative()) return;
    if (!isSendTarget(event.target)) return;
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
