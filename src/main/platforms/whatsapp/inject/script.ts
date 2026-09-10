export const whatsappInjectionScript = String.raw`
(() => {
  if (window.__RT_TRANSLATOR_INSTALLED__) return;
  window.__RT_TRANSLATOR_INSTALLED__ = true;

  const RT_ATTR = 'data-rt-translated';
  const pendingSent = [];
  let sending = false;
  let activeSend;
  let nativeClick;
  let editorLocked = false;
  let navigationRevision = 0;
  let incomingBusy = false;
  let incomingPaused = false;
  let incomingRetryAt = 0;
  let incomingFailures = 0;
  const incomingRequests = new WeakMap();
  let lastPendingTarget = '';
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
  const composerText = (composer) => String(composer?.innerText || composer?.textContent || '').replace(/\u00a0/g, ' ').trim();

  const reportStatus = (state, message) => {
    window.realtimeTranslator?.reportStatus?.({ state, message, at: Date.now() });
  };

  const showSendStatus = (message, type = 'working', autoHide = true, action, secondary) => {
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
    box.style.pointerEvents = action ? 'auto' : 'none';
    for (const item of [action, secondary].filter(Boolean)) {
      const button = document.createElement('button');
      button.textContent = item.label;
      Object.assign(button.style, { display: 'block', marginTop: '8px', cursor: 'pointer', padding: '5px 8px' });
      button.onclick = () => { button.disabled = true; Promise.resolve().then(() => item.run()).catch(error => showSendStatus(String(error?.message || error), 'error', false)); };
      box.appendChild(button);
    }
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

  const targetKey = () => {
    for (const el of document.querySelectorAll('#main [data-id]')) {
      const match = String(el.getAttribute('data-id') || '').match(/^(?:true|false)_([^_]+@[^_]+)_/);
      if (match) return 'peer:' + match[1];
    }
    return 'title:' + conversationInfo().id;
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
      const copy = node.cloneNode(true);
      copy.querySelectorAll('[data-rt-ui]').forEach(el => el.remove());
      const value = normalizeMessage(copy.innerText || copy.textContent || '');
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

  const resumeIncoming = () => {
    incomingPaused = false;
    incomingFailures = 0;
    incomingRetryAt = 0;
    void translateVisible();
  };
  window.__RT_RESUME_TRANSLATIONS__ = resumeIncoming;
  window.addEventListener('online', resumeIncoming);

  const translateVisible = async () => {
    const api = window.realtimeTranslator;
    if (!api || incomingBusy || incomingPaused || Date.now() < incomingRetryAt || navigator.onLine === false) return;
    incomingBusy = true;
    try {
      const conversation = conversationInfo();
      const target = targetKey();
      const settings = await api.getRuntimeSettings(conversation.id);
      if (conversationInfo().id !== conversation.id || targetKey() !== target) return;
      applyTranslationStyle(settings);
      const containers = messageContainers();
      for (const container of containers) {
        if (!container.isConnected || conversationInfo().id !== conversation.id || targetKey() !== target) break;
        if (!isVisible(container)) continue;
        if (isOutgoingContainer(container)) {
          if (!container.getAttribute(RT_ATTR)) annotateOutgoing(container, settings, conversation.id);
          continue;
        }
        if (!settings.receiveAutoTranslate || (!settings.groupTranslate && isGroupChat())) continue;
        if (['working', 'done'].includes(container.getAttribute(RT_ATTR))) continue;
        const text = extractMessageText(container);
        if (!text) continue;
        let payload = incomingRequests.get(container);
        if (!payload) {
          payload = { text, conversationId: conversation.id, conversationName: conversation.name,
            messageId: messageId(container), context: contextFor(container, containers) };
          incomingRequests.set(container, payload);
        }
        container.setAttribute(RT_ATTR, 'working');
        try {
          const translated = await api.translateIncoming(payload);
          if (container.isConnected && extractMessageText(container) === text) {
            if (translated && normalizeMessage(translated) !== normalizeMessage(text)) addTranslation(container, translated, settings, 'incoming');
            container.setAttribute(RT_ATTR, 'done');
          }
          incomingFailures = 0;
        } catch (error) {
          container.removeAttribute(RT_ATTR);
          throw error;
        }
      }
    } catch (error) {
      const message = String(error?.message || error);
      incomingFailures += 1;
      incomingRetryAt = Date.now() + Math.min(60000, 5000 * 2 ** (incomingFailures - 1));
      // Auth/quota/disabled-account failures require a state change, not polling.
      incomingPaused = /登录|停用|禁用|字符不足|余额不足|额度|401|403|402/.test(message) || incomingFailures >= 3;
      if (incomingPaused && !sending) showSendStatus('自动翻译已暂停：' + message, 'error', false, { label: '重新检查翻译', run: resumeIncoming });
      reportStatus('error', message);
    } finally { incomingBusy = false; }
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

  const matchesSnapshot = (snapshot) => snapshot && snapshot.composer.isConnected
    && getComposer() === snapshot.composer && document.querySelector('#main header') === snapshot.header
    && conversationInfo().id === snapshot.conversationId
    && (targetKey() === snapshot.targetKey || snapshot.targetKey === 'title:' + snapshot.conversationId)
    && navigationRevision === snapshot.navigationRevision;

  const outgoingIds = () => new Set(messageContainers().filter(isOutgoingContainer).map(messageId).filter(id => id && !id.startsWith('pre:')));

  window.__RT_SEND_SELECT__ = (task) => {
    const snapshot = activeSend;
    if (!snapshot || snapshot.id !== task.id || !matchesSnapshot(snapshot)
      || snapshot.original !== task.original
      || (snapshot.targetKey !== task.targetKey && task.targetKey !== 'title:' + snapshot.conversationId)
      || composerText(snapshot.composer) !== snapshot.original) return false;
    snapshot.translated = task.translated;
    snapshot.baseline = outgoingIds();
    editorLocked = true;
    snapshot.composer.focus();
    const range = document.createRange();
    range.selectNodeContents(snapshot.composer);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  };

  window.__RT_SEND_COMMIT__ = async (task) => {
    const snapshot = activeSend;
    const button = findSendButton();
    if (!snapshot || snapshot.id !== task.id || !matchesSnapshot(snapshot)
      || normalizeMessage(composerText(snapshot.composer)) !== normalizeMessage(task.translated)
      || !button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return { dispatched: false, message: '对话、草稿或发送按钮已变化，已阻止发送。' };
    }
    // No await between the final target check and Send. Only this exact button
    // click bypasses interception; there is no timed bypass for physical Enter.
    try {
      nativeClick = button;
      button.click();
    } finally { nativeClick = null; editorLocked = false; }
    for (let i = 0; i < 50; i += 1) {
      if (!matchesSnapshot(snapshot)) return { dispatched: true, confirmed: false };
      const receipt = messageContainers().find(container => {
        const id = messageId(container);
        return isOutgoingContainer(container) && id && !id.startsWith('pre:') && !snapshot.baseline.has(id)
          && normalizeMessage(extractMessageText(container)) === normalizeMessage(task.translated);
      });
      if (receipt) {
        rememberSent(task.translated, snapshot.original, snapshot.conversationId);
        return { dispatched: true, confirmed: true };
      }
      await sleep(100);
    }
    return { dispatched: true, confirmed: false };
  };

  window.__RT_SEND_RELEASE__ = (id, restore) => {
    editorLocked = false;
    const snapshot = activeSend;
    if (snapshot?.id !== id) return;
    if (restore && matchesSnapshot(snapshot) && normalizeMessage(composerText(snapshot.composer)) === normalizeMessage(snapshot.translated)) {
      replaceComposerText(snapshot.composer, snapshot.original);
    }
  };

  const showPending = (task) => {
    if (!task || ['sent', 'cancelled'].includes(task.state)) return;
    const uncertain = task.state === 'uncertain' || task.state === 'submitting';
    const origin = task.conversationId.replace(/^wa:/, '');
    if (uncertain) {
      showSendStatus('对话“' + origin + '”的发送结果未确认。请先核对原对话，勿直接重发。', 'error', false, {
        label: '已核对未发送，允许重试', run: async () => {
          const ready = await window.realtimeTranslator.confirmNotSent(task.id);
          showPending(ready);
        }
      }, { label: '已在原对话确认发送成功', run: async () => {
        await window.realtimeTranslator.confirmSent(task.id);
        showSendStatus('已记录核对结果，不会重复发送。', 'success');
      } });
    } else {
      showSendStatus('对话“' + origin + '”有保留的草稿' + (task.translated ? '和译文' : '') + '。重试将沿用原任务及目标语言。', 'working', false, {
        label: '恢复原草稿', run: () => {
          if (conversationInfo().id !== task.conversationId || (targetKey() !== task.targetKey && task.targetKey !== 'title:' + task.conversationId)) throw new Error('请先回到原对话。');
          const composer = getComposer();
          if (!composer || composerText(composer)) throw new Error('当前输入框已有内容，未覆盖。请先保留当前草稿。');
          replaceComposerText(composer, task.request.text);
          showSendStatus('原草稿已恢复，请核对收件人后点击发送。', 'working', false);
        }
      }, { label: '取消此待发送任务', run: async () => {
        await window.realtimeTranslator.cancelSend(task.id);
        showSendStatus('任务已取消。下次发送将使用当前翻译设置。', 'working');
      } });
    }
  };

  const recoverPending = async () => {
    if (sending) return;
    const conversation = conversationInfo();
    const key = targetKey();
    if (!conversation.id || !getComposer() || key === lastPendingTarget) return;
    lastPendingTarget = key;
    try {
      const task = await window.realtimeTranslator?.pendingSend(conversation.id, key);
      if (!sending && conversationInfo().id === conversation.id && targetKey() === key) showPending(task);
    } catch (_) { lastPendingTarget = ''; }
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
    const original = composerText(composer);
    if (!original) return;
    const conversation = conversationInfo();
    const snapshot = { composer, original, conversationId: conversation.id, targetKey: targetKey(),
      header: document.querySelector('#main header'), navigationRevision, id: '', translated: '' };
    activeSend = snapshot;
    let task;
    try {
      if (!api?.prepareSend) throw new Error('发送桥接未加载，请重新打开 WhatsApp 窗口。');
      showSendStatus('正在保存草稿并准备翻译…', 'working', false);
      task = await api.prepareSend({ text: original, conversationId: conversation.id, targetKey: snapshot.targetKey, context: outgoingContext() });
      snapshot.id = task.id;
      if (['uncertain', 'submitting'].includes(task.state)) { showPending(task); return; }
      showSendStatus('正在确认译文，草稿已保留…', 'working', false);
      task = await api.translateSend(task.id);
      if (!matchesSnapshot(snapshot) || composerText(composer) !== original) throw new Error('对话或草稿已变化，译文已保存，没有发送。');
      snapshot.translated = task.translated;
      showSendStatus('译文已保存，正在提交并等待 WhatsApp 确认…', 'working', false);
      await api.submitSend(task.id);
      showSendStatus('译文已进入 WhatsApp 发送队列。', 'success');
      void translateVisible();
    } catch (error) {
      showSendStatus(String(error?.message || error) + ' 原任务已保留。', 'error', false);
      if (task) {
        try { showPending(await api.pendingSend(conversation.id, snapshot.targetKey)); } catch (_) {}
      }
    } finally { editorLocked = false; activeSend = null; }
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

  const stopInput = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
  document.addEventListener('keydown', (event) => {
    if (editorLocked) { stopInput(event); return; }
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const composer = getComposer(event.target);
    if (composer && composer.contains(event.target)) interceptSendNow(event, composer);
  }, true);
  document.addEventListener('beforeinput', (event) => {
    if (event.inputType !== 'insertParagraph' || event.isComposing) return;
    const composer = getComposer(event.target);
    if (composer && composer.contains(event.target)) interceptSendNow(event, composer);
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (editorLocked) { stopInput(event); return; }
    const composer = getComposer();
    if (!composer?.contains(event.target) && !isSendTarget(event.target)
      && !event.target?.closest?.('[data-rt-ui]')) navigationRevision += 1;
  }, true);
  for (const name of ['paste', 'drop']) document.addEventListener(name, (event) => { if (editorLocked) stopInput(event); }, true);
  document.addEventListener('click', (event) => {
    if (nativeClick && (event.target === nativeClick || nativeClick.contains(event.target))) return;
    if (editorLocked) { stopInput(event); return; }
    if (!isSendTarget(event.target)) return;
    const composer = getComposer();
    if (composer) interceptSendNow(event, composer);
  }, true);

  setInterval(() => { void recoverPending(); void translateVisible(); }, 1400);
  void translateVisible();
})();
`;
