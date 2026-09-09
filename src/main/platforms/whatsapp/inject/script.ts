export const whatsappInjectionScript = String.raw`
(() => {
  if (window.__RT_TRANSLATOR_INSTALLED__) return;
  window.__RT_TRANSLATOR_INSTALLED__ = true;

  const RT_ATTR = 'data-rt-translated';
  const CHINESE_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  const pendingSent = [];
  let sending = false;
  let nativeBypassUntil = 0;
  let statusTimer;
  let lastConversationId = '';

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
    messageContainer: [
      '#main [data-testid="msg-container"]',
      '#main .message-in',
      '#main .message-out',
      '#main [data-id]'
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
  const normalizeMessage = (text) => String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const composerText = (composer) => normalizeMessage(composer?.innerText || composer?.textContent || '');
  const containsChinese = (text) => CHINESE_RE.test(String(text || ''));
  const bypassNative = () => Date.now() < nativeBypassUntil;

  const reportStatus = (state, message) => {
    window.realtimeTranslator?.reportStatus?.({ state, message, at: Date.now() });
  };

  const showSendStatus = (message, type = 'working', autoHide = true) => {
    reportStatus(type, message);
    let box = document.getElementById('rt-send-status');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rt-send-status';
      box.setAttribute('data-rt-ui', 'send-status');
      Object.assign(box.style, {
        position: 'fixed', top: '76px', right: '18px', zIndex: '2147483647', maxWidth: '420px',
        padding: '10px 14px', borderRadius: '10px', fontSize: '13px', lineHeight: '1.45', color: '#fff',
        boxShadow: '0 8px 28px rgba(0,0,0,.28)', pointerEvents: 'none', transition: 'opacity .18s ease', opacity: '1'
      });
      document.body.appendChild(box);
    }
    clearTimeout(statusTimer);
    box.textContent = message;
    box.style.background = type === 'error' ? '#a72b3a' : type === 'success' ? '#176b4d' : '#2456a6';
    box.style.opacity = '1';
    if (autoHide) statusTimer = setTimeout(() => { if (box) box.style.opacity = '0'; }, type === 'error' ? 6000 : 2200);
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

  const conversationInfo = () => {
    const header = document.querySelector('#main header');
    if (!header) return { id: '', name: '' };
    const titleSelectors = [
      '[data-testid="conversation-info-header-chat-title"]',
      'span[title][dir="auto"]',
      '[title][dir="auto"]',
      'span[title]'
    ];
    let name = '';
    for (const selector of titleSelectors) {
      const candidates = Array.from(header.querySelectorAll(selector));
      const found = candidates.map((el) => normalizeMessage(el.getAttribute('title') || el.textContent || '')).find((value) => value && value.length < 160);
      if (found) { name = found; break; }
    }
    if (!name) name = normalizeMessage((header.innerText || '').split('\n')[0] || '');
    const id = name ? 'wa:' + name.toLowerCase() : '';
    if (id && id !== lastConversationId) {
      lastConversationId = id;
      window.realtimeTranslator?.reportConversation?.({ id, name });
    }
    return { id, name };
  };

  const messageContainers = () => {
    const seen = new Set();
    const out = [];
    for (const selector of selectors.messageContainer) {
      document.querySelectorAll(selector).forEach((el) => {
        if (seen.has(el)) return;
        if (!el.querySelector?.('span.selectable-text, [data-pre-plain-text]')) return;
        const parentMessage = el.parentElement?.closest?.('[data-testid="msg-container"], .message-in, .message-out');
        if (parentMessage && parentMessage !== el) return;
        seen.add(el);
        out.push(el);
      });
    }
    return out.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top;
    });
  };

  const isOutgoingContainer = (container) => {
    if (!container) return false;
    if (container.matches?.('.message-out') || container.closest?.('.message-out')) return true;
    const cls = typeof container.className === 'string' ? container.className : '';
    return /(^|\s)message-out(\s|$)/.test(cls);
  };

  const messageId = (container) => {
    const direct = container.getAttribute?.('data-id');
    if (direct) return direct;
    const nested = container.querySelector?.('[data-id]')?.getAttribute?.('data-id');
    if (nested) return nested;
    const pre = container.querySelector?.('[data-pre-plain-text]')?.getAttribute?.('data-pre-plain-text') || '';
    return pre ? 'pre:' + pre + ':' + normalizeMessage(extractMessageText(container)).slice(0, 80) : '';
  };

  const isQuotedNode = (node) => Boolean(node.closest?.(
    '[data-testid*="quoted"], [data-testid*="reply"], [aria-label*="Quoted"], [aria-label*="quoted"], [aria-label*="引用"], [data-rt-ui]'
  ));

  const textNodesFor = (container) => {
    const preferred = Array.from(container.querySelectorAll?.('[data-pre-plain-text] span.selectable-text') || []);
    const all = preferred.length ? preferred : Array.from(container.querySelectorAll?.('span.selectable-text') || []);
    return all.filter((node) => !isQuotedNode(node));
  };

  const extractMessageText = (container) => {
    const parts = [];
    for (const node of textNodesFor(container)) {
      const value = normalizeMessage(node.innerText || node.textContent || '');
      if (value && !parts.includes(value)) parts.push(value);
    }
    return parts.join('\n').trim();
  };

  const messageTextHost = (container) => {
    const nodes = textNodesFor(container);
    return nodes[nodes.length - 1] || container.querySelector?.('[data-pre-plain-text]') || container;
  };

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect?.();
    if (!rect) return true;
    return rect.bottom >= -200 && rect.top <= window.innerHeight + 200 && rect.right >= 0 && rect.left <= window.innerWidth;
  };

  const isGroupChat = () => {
    const header = document.querySelector('#main header');
    if (!header) return false;
    if (header.querySelector('[data-icon*="group"], [data-testid*="group"]')) return true;
    const text = normalizeMessage(header.innerText || '');
    return /,\s*[^,]+/.test(text) && text.length > 12;
  };

  const contextFor = (container, containers) => {
    const index = containers.indexOf(container);
    if (index < 0) return [];
    const context = [];
    for (let i = Math.max(0, index - 4); i < index; i += 1) {
      const item = containers[i];
      const text = extractMessageText(item);
      if (!text) continue;
      context.push({ role: isOutgoingContainer(item) ? 'outgoing' : 'incoming', text });
    }
    return context.slice(-4);
  };

  const applyTranslationStyle = (settings) => {
    document.querySelectorAll('.rt-translation').forEach((node) => {
      node.style.fontSize = String(Number(settings?.fontSize || 13)) + 'px';
      node.style.color = settings?.translationColor || '#c8d4e4';
    });
  };

  const addTranslation = (container, text, settings, kind = 'incoming') => {
    if (!text) return;
    const host = messageTextHost(container);
    if (host.querySelector?.(':scope > .rt-translation')) return;
    const node = document.createElement('span');
    node.className = 'rt-translation';
    node.textContent = text;
    node.setAttribute('data-rt-ui', 'translation');
    node.setAttribute('data-rt-kind', kind);
    Object.assign(node.style, {
      display: 'block', marginTop: '5px', paddingTop: '5px', borderTop: '1px dashed rgba(120,120,120,.38)',
      fontSize: String(Number(settings?.fontSize || 13)) + 'px', lineHeight: '1.38', fontWeight: '500',
      color: settings?.translationColor || '#c8d4e4', opacity: '.98', whiteSpace: 'pre-wrap', userSelect: 'text'
    });
    host.appendChild(node);
  };

  const cleanupPendingSent = () => {
    const now = Date.now();
    for (let i = pendingSent.length - 1; i >= 0; i -= 1) if (pendingSent[i].expires < now) pendingSent.splice(i, 1);
    while (pendingSent.length > 24) pendingSent.shift();
  };

  const rememberSent = (translated, original, conversationId) => {
    cleanupPendingSent();
    pendingSent.push({ translated: normalizeMessage(translated), original, conversationId, expires: Date.now() + 45000 });
  };

  const annotateOutgoing = (container, settings, conversationId) => {
    cleanupPendingSent();
    const text = normalizeMessage(extractMessageText(container));
    if (!text) return false;
    const index = pendingSent.findIndex((item) => item.translated === text && (!item.conversationId || item.conversationId === conversationId));
    if (index < 0) return false;
    const item = pendingSent.splice(index, 1)[0];
    if (normalizeMessage(item.original) !== text) addTranslation(container, item.original, settings, 'outgoing-original');
    container.setAttribute(RT_ATTR, 'outgoing-done');
    return true;
  };

  const translateVisible = async () => {
    const api = window.realtimeTranslator;
    if (!api) return;
    const conversation = conversationInfo();
    const settings = await api.getRuntimeSettings(conversation.id);
    applyTranslationStyle(settings);
    if (!settings.receiveAutoTranslate && pendingSent.length === 0) return;
    if (!settings.groupTranslate && isGroupChat() && pendingSent.length === 0) return;

    const containers = messageContainers();
    for (const container of containers) {
      if (!isVisible(container)) continue;
      if (isOutgoingContainer(container)) {
        if (!container.getAttribute(RT_ATTR)) annotateOutgoing(container, settings, conversation.id);
        continue;
      }
      if (!settings.receiveAutoTranslate) continue;
      if (!settings.groupTranslate && isGroupChat()) continue;
      if (container.getAttribute(RT_ATTR) === 'working' || container.getAttribute(RT_ATTR) === 'done') continue;
      const text = extractMessageText(container);
      if (!text) { container.setAttribute(RT_ATTR, 'empty'); continue; }
      container.setAttribute(RT_ATTR, 'working');
      try {
        const translated = await api.translateIncoming({
          text,
          conversationId: conversation.id,
          conversationName: conversation.name,
          messageId: messageId(container),
          context: contextFor(container, containers)
        });
        if (translated && normalizeMessage(translated) !== normalizeMessage(text)) addTranslation(container, translated, settings, 'incoming');
        container.setAttribute(RT_ATTR, 'done');
      } catch (error) {
        container.removeAttribute(RT_ATTR);
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
    if (!inserted || composerText(composer) !== normalizeMessage(text)) {
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
      if (current === normalizeMessage(finalText)) sawTranslated = true;
      if (sawTranslated && current !== normalizeMessage(finalText)) return true;
      await sleep(50);
    }
    const current = composerText(composer);
    return !current || (sawTranslated && current !== normalizeMessage(finalText) && current !== normalizeMessage(original));
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
    replaceComposerText(composer, finalText);
    await sleep(100);
    return nativeSend(composer, api);
  };

  const outgoingContext = () => {
    const containers = messageContainers();
    return containers.slice(-4).map((container) => ({
      role: isOutgoingContainer(container) ? 'outgoing' : 'incoming',
      text: extractMessageText(container)
    })).filter((item) => item.text).slice(-4);
  };

  const processSend = async (composer) => {
    const api = window.realtimeTranslator;
    if (!api) {
      showSendStatus('翻译桥接未加载，已阻止发送。请重新打开该 WhatsApp 窗口。', 'error');
      return;
    }
    const original = composerText(composer);
    if (!original) return;
    const conversation = conversationInfo();

    try {
      showSendStatus('正在翻译并准备发送…', 'working', false);
      const settings = await api.getRuntimeSettings(conversation.id);
      const blockChinese = settings.blockChineseSend !== false;

      if (!settings.sendAutoTranslate) {
        if (blockChinese && containsChinese(original)) throw new Error('已开启“禁止发送中文”。请开启发送翻译，或直接输入目标语言。');
        showSendStatus('发送翻译已关闭，正在按原文发送…', 'working', false);
        if (!await nativeSend(composer, api)) throw new Error('WhatsApp 原生发送动作未触发。');
        showSendStatus('消息已发送。', 'success');
        return;
      }

      const translated = await api.translateOutgoing({
        text: original,
        conversationId: conversation.id,
        conversationName: conversation.name,
        context: outgoingContext()
      });
      const finalText = String(translated || '').trim();
      if (!finalText) throw new Error('翻译结果为空，已阻止发送。');
      if (blockChinese && containsChinese(finalText)) throw new Error('翻译结果仍包含中文，已阻止发送。请检查联系人语言或 API 设置。');

      rememberSent(finalText, original, conversation.id);
      showSendStatus('翻译完成，正在通过 WhatsApp 原生输入发送…', 'working', false);
      if (!await commitTranslatedSend(composer, api, finalText)) throw new Error('无法提交译文到 WhatsApp 输入框。');

      const completed = await waitForSendCompletion(composer, original, finalText);
      if (!completed) throw new Error('译文已生成，但 WhatsApp 没有完成发送。中文原文没有被发送，请重试。');
      showSendStatus('已发送目标语言译文。', 'success');
      setTimeout(() => { void translateVisible(); }, 180);
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
    mutationTimer = setTimeout(() => { conversationInfo(); void translateVisible(); }, 180);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { conversationInfo(); void translateVisible(); }, 1400);
  conversationInfo();
  translateVisible();
})();
`
