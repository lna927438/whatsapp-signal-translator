import { whatsappSidebarScript } from './sidebar'
import { whatsappContactScript } from './contactDetails'
import { equivalentDisplayText, wrongTargetScript } from '../../../../shared/translationResult'
import { hasBlockedChinese } from '../../../translation/outgoingPolicy'
export const whatsappInjectionScript = String.raw`
(() => {
  if (window.__RT_TRANSLATOR_INSTALLED__) return;
  window.__RT_TRANSLATOR_INSTALLED__ = true;
  let englishUi = false;
  const ui = text => englishUi ? ({
    '翻译此消息':'Translate message', '翻译为我的语言':'Translate into my language',
    '重试翻译':'Retry translation', '发送译文预览':'Translation preview', '原文':'Original',
    '可编辑译文':'Editable translation', '发送译文':'Send translation', '暂不发送':'Not now',
    '恢复原文 / 取消发送':'Restore original / cancel send',
    '回翻（新翻译，成功按字符计费）':'Back-translate (new translation; may use characters)', '回翻：':'Back-translation: '
  }[text] || text) : text;
  const activeMediaTracks = new Set();
  for (const method of ['getUserMedia', 'getDisplayMedia']) {
    const devices = navigator.mediaDevices, original = devices?.[method];
    if (original) devices[method] = async (...args) => {
      const stream = await original.apply(devices, args);
      for (const track of stream.getTracks()) activeMediaTracks.add(track);
      return stream;
    };
  }

  const RT_ATTR = 'data-rt-translated';
  const pendingSent = [];
  let sending = false;
  let activeSend;
  const queuedSends = new Map();
  let commitTail = Promise.resolve();
  let queuePreparing = false;
  let unacknowledgedIntent = null;
  let nativeClick;
  let editorLocked = false;
  let nativeEditor;
  const composingEditors = new WeakSet();
  const nativeParagraphEditors = new WeakSet();
  let inputRevision = 0;
  let restoredFailedDraft = null;
  let lastUserInputAt = 0;
  let navigationRevision = 0;
  let incomingBusy = false;
  const incomingActive = new WeakSet();
  let incomingActiveCount = 0;
  let incomingPaused = false;
  let incomingRetryAt = 0;
  let incomingFailures = 0;
  const incomingRequests = new WeakMap();
  let displayRevision = 0;
  let displaySettingsKey = '';
  const historyTails = new Map();
  const historySeen = new Set();
  const allowedNew = new Set();
  let lastUnread = -1;
  let lastHistoryMode;
  let lastPendingTarget = '';
  let statusTimer;
  let lastConversationId = '';

  const selectors = {
    composer: [
      '#main footer :is([contenteditable="true"],[contenteditable="plaintext-only"])[role="textbox"]',
      'footer :is([contenteditable="true"],[contenteditable="plaintext-only"])[role="textbox"]',
      '#main footer :is([contenteditable="true"],[contenteditable="plaintext-only"])[data-tab]',
      'footer :is([contenteditable="true"],[contenteditable="plaintext-only"])[data-tab]',
      '#main footer div:is([contenteditable="true"],[contenteditable="plaintext-only"])',
      'footer div:is([contenteditable="true"],[contenteditable="plaintext-only"])',
      '#main :is([contenteditable="true"],[contenteditable="plaintext-only"])[role="textbox"][aria-placeholder]',
      ':is([contenteditable="true"],[contenteditable="plaintext-only"])[role="textbox"][aria-placeholder]'
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
  const bounded = (work, ms, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(work).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const normalizeMessage = (text) => String(text || '').replace(/\u00a0/g, ' ').replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const equivalentDisplayText = ${equivalentDisplayText.toString()};
  const wrongTargetScript = ${wrongTargetScript.toString()};
  const hasBlockedChinese = ${hasBlockedChinese.toString()};
  const composerText = (composer) => String(composer?.innerText || composer?.textContent || '').replace(/\u00a0/g, ' ').trim();

  const reportStatus = (state, message) => {
    window.realtimeTranslator?.reportStatus?.({ state, message, at: Date.now() });
  };

  const showSendStatus = (message, type = 'working', autoHide = true, action, secondary) => {
    clearTimeout(statusTimer);
    document.getElementById('rt-send-status')?.remove();
    // Persistent recovery belongs to the records window, never the conversation.
    if (type === 'working') reportStatus('working', '正在发送…');
    else if (/核对|未确认|后台确认/.test(message)) reportStatus('ready', '');
    else reportStatus(type, message);
  };

  const getComposer = (target) => {
    const targetElement = target instanceof Element ? target : target?.parentElement;
    const direct = targetElement?.closest?.(':is([contenteditable="true"],[contenteditable="plaintext-only"])[role="textbox"], :is([contenteditable="true"],[contenteditable="plaintext-only"])[data-tab]');
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
    if ((target instanceof Element ? target : target.parentElement)?.closest('[data-rt-ui]')) return false;
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
      const candidates = Array.from(header.querySelectorAll(selector)).filter(el => !el.closest('[data-rt-ui]'));
      const found = candidates.map((el) => normalizeMessage(el.getAttribute('title') || el.textContent || '')).find((value) => value && value.length < 160);
      if (found) { name = found; break; }
    }
    if (!name) name = normalizeMessage((header.innerText || '').split('\n')[0] || '');
    const id = name ? 'wa:' + name.toLowerCase() : '';
    if (id && id !== lastConversationId) {
      lastConversationId = id;
      document.getElementById('rt-send-status')?.remove();
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
        if (seen.has(el) || out.some(item => item.contains(el) || el.contains(item))) return;
        if (!el.querySelector?.('.selectable-text, [data-pre-plain-text], [data-testid="msg-text"], [data-testid="media-caption"]')) return;
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
    const id = messageId(container);
    if (/^false_/.test(id) || container.matches?.('.message-in') || container.closest?.('.message-in')) return false;
    if (container.matches?.('.message-out') || container.closest?.('.message-out')) return true;
    if (/^true_/.test(id)) return true;
    if (Array.from(container.querySelectorAll?.('.message-out') || []).some(node => !isQuotedNode(node))) return true;
    // Current WhatsApp also uses opaque message IDs without true_/false_.
    // Its native outgoing tail, own-author label and receipt metadata survive
    // changes to generated classes. A quoted outgoing message is not evidence.
    if (Array.from(container.querySelectorAll?.('[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-dblcheck-ack"], [data-icon="msg-time"], [data-icon="msg-error"], [data-testid="msg-check"], [data-testid="msg-dblcheck"], [data-testid="tail-out"], [data-icon="tail-out"], span[aria-label="你："], span[aria-label="You:"]') || []).some(node => !isQuotedNode(node))) return true;
    if (Array.from(container.querySelectorAll?.('[data-testid="msg-meta"] svg title') || []).some(node => !isQuotedNode(node) && node.textContent?.trim() === 'wds-ic-read')) return true;
    const cls = typeof container.className === 'string' ? container.className : '';
    return /(^|\s)message-out(\s|$)/.test(cls);
  };

  const messageId = (container) => {
    const direct = container.getAttribute?.('data-id') || container.closest?.('[data-id]')?.getAttribute('data-id');
    if (direct) return direct;
    const nested = container.querySelector?.('[data-id]')?.getAttribute?.('data-id');
    if (nested) return nested;
    const pre = container.querySelector?.('[data-pre-plain-text]')?.getAttribute?.('data-pre-plain-text') || '';
    return pre ? 'pre:' + pre + ':' + normalizeMessage(extractMessageText(container)).slice(0, 80) : '';
  };

  // A reply wrapper can contain BOTH the quote and the new message. Only the
  // actual quoted region is excluded; a generic "reply" marker is not enough.
  const quoteSelector = '[data-testid*="quoted"], [data-testid="reply-context"], [aria-label^="Quoted message"], [aria-label^="quoted message"], [aria-label^="引用消息"], [data-rt-ui]';
  const isQuotedNode = (node) => Boolean(node.closest?.(quoteSelector));

  const textNodesFor = (container) => {
    const eligible = selector => Array.from(container.querySelectorAll?.(selector) || []).filter(node => !isQuotedNode(node));
    const preferred = eligible('[data-pre-plain-text] .selectable-text');
    const selectable = eligible('.selectable-text');
    const all = preferred.length ? preferred : selectable.length ? selectable : eligible('[data-pre-plain-text], [data-testid="msg-text"], [data-testid="media-caption"]');
    // Nested formatting spans can also be selectable. Read their outer host
    // once so words, mentions and emoji remain in their original order.
    return all.filter(node => !all.some(parent => parent !== node && parent.contains(node)));
  };

  const extractMessageText = (container) => {
    const parts = [];
    for (const node of textNodesFor(container)) {
      const copy = node.cloneNode(true);
      copy.querySelectorAll(quoteSelector).forEach(el => el.remove());
      copy.querySelectorAll('[data-testid="msg-meta"], [data-icon^="msg-"], [data-icon^="tail-"], time, button, [role="button"]').forEach(el => el.remove());
      // WhatsApp renders many emoji as images, which innerText/textContent omit.
      // Attachment thumbnails and reaction controls are not message text.
      copy.querySelectorAll('img').forEach(el => {
        const alt = el.getAttribute('data-plain-text') || el.getAttribute('alt') || '';
        el.replaceWith(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(alt) ? alt : '');
      });
      copy.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
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
    for (const node of document.querySelectorAll('#main [data-id]')) if (/^(?:true|false)_[^_]+@g\.us_/.test(node.getAttribute('data-id') || '')) return true;
    const header = document.querySelector('#main header');
    if (!header) return false;
    if (header.querySelector('[data-icon*="group"], [data-testid*="group"]')) return true;
    // A comma in a person's name or status is not evidence of a group.
    return false;
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
      node.style.display = settings?.translationsVisible === false ? 'none' : 'block';
    });
  };

  window.__RT_APPLY_SETTINGS__ = settings => {
    displayRevision++;
    applyTranslationStyle(settings);
    resumeIncoming();
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
      display: settings?.translationsVisible === false ? 'none' : 'block', marginTop: '5px', paddingTop: '5px', borderTop: '1px dashed rgba(120,120,120,.38)',
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

  const rememberSent = (translated, original, conversationId, id) => {
    cleanupPendingSent();
    pendingSent.push({ translated: normalizeMessage(translated), original, conversationId, id, expires: Date.now() + 45000 });
  };

  const annotateOutgoing = (container, settings, conversationId) => {
    cleanupPendingSent();
    const text = normalizeMessage(extractMessageText(container));
    if (!text) return false;
    const index = pendingSent.findIndex((item) => item.id === messageId(container) && item.translated === text && (!item.conversationId || item.conversationId === conversationId));
    if (index < 0) return false;
    const item = pendingSent.splice(index, 1)[0];
    if (equivalentDisplayText(item.original, text) || wrongTargetScript(item.original, settings.localLanguage || 'zh-CN')) return false;
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
  window.__RT_REFRESH_TRANSLATIONS__ = () => {
    displayRevision++;
    document.querySelectorAll('.rt-translation, [data-rt-history-action]').forEach(el => el.remove());
    document.querySelectorAll('[data-rt-translated]').forEach(el => el.removeAttribute(RT_ATTR));
    resumeIncoming();
  };
  window.addEventListener('online', resumeIncoming);

  const incomingError = (error, payload) => {
    const message = String(error?.message || error);
    incomingPaused = /登录|停用|禁用|字符不足|余额不足|额度|401|403|402|sign in|unauthori[sz]ed|insufficient|disabled/i.test(message);
    if (payload) payload.error = message;
    if (payload && !incomingPaused) {
      payload.failures = (payload.failures || 0) + 1;
      payload.retryAt = Date.now() + Math.min(60000, 5000 * 2 ** (payload.failures - 1));
    } else {
      incomingFailures += 1;
      incomingRetryAt = Date.now() + (incomingPaused ? 60000 : Math.min(60000, 5000 * 2 ** Math.min(4, incomingFailures - 1)));
    }
    reportStatus('error', message);
  };
  const translateVisible = async () => {
    const api = window.realtimeTranslator;
    if (!api || incomingBusy || Date.now() < incomingRetryAt || navigator.onLine === false || document.visibilityState === 'hidden') return;
    // Recheck access after cooldown: a refreshed login or topped-up balance
    // must not require restarting the page to release a permanent local latch.
    incomingPaused = false;
    incomingBusy = true;
    try {
      const conversation = conversationInfo();
      const target = targetKey();
      const settings = await bounded(api.getRuntimeSettings(conversation.id), 5000, '翻译显示设置暂时没有响应，请刷新重试。');
      englishUi = settings.uiLanguage === 'en';
      if (conversationInfo().id !== conversation.id || targetKey() !== target) return;
      const settingsKey = JSON.stringify([settings.localLanguage,settings.translationQuality,settings.historyMode,settings.receiveAutoTranslate,settings.groupTranslate,settings.translationsVisible,settings.uiLanguage]);
      if (displaySettingsKey !== settingsKey) {
        displayRevision++; displaySettingsKey = settingsKey;
        document.querySelectorAll('.rt-translation, [data-rt-history-action]').forEach(el => el.remove());
        document.querySelectorAll('[data-rt-translated]').forEach(el => el.removeAttribute(RT_ATTR));
      }
      const generation = displayRevision;
      applyTranslationStyle(settings);
      const containers = messageContainers();
      const mode = settings.historyMode || 'visible';
      if (mode !== lastHistoryMode) { document.querySelectorAll('[data-rt-history-action]').forEach(el => el.remove()); document.querySelectorAll('[data-rt-translated="history"]').forEach(el => el.removeAttribute(RT_ATTR)); lastHistoryMode = mode; }
      const previousTail = historyTails.get(target);
      const tailIndex = containers.findIndex(el => messageId(el) === previousTail);
      if (mode === 'new' && previousTail && tailIndex >= 0) {
        containers.slice(tailIndex + 1).forEach(el => { const key = target + ':' + messageId(el); if (!historySeen.has(key)) allowedNew.add(key); });
      }
      containers.forEach(el => historySeen.add(target + ':' + messageId(el)));
      if (historySeen.size > 20000) { historySeen.clear(); allowedNew.clear(); historyTails.clear(); containers.forEach(el => historySeen.add(target + ':' + messageId(el))); }
      if (containers.length) historyTails.set(target, messageId(containers[containers.length - 1]));
      // Fill at most three slots, newest visible messages first. An old history
      // request must not hold the entire scan until its network response arrives.
      for (const container of [...containers].reverse()) {
        if (!container.isConnected || generation !== displayRevision || conversationInfo().id !== conversation.id || targetKey() !== target) break;
        if (incomingActive.has(container)) continue;
        if (!isVisible(container)) continue;
        const text = extractMessageText(container);
        const id = messageId(container), outgoing = isOutgoingContainer(container);
        if (!text || !id) continue;
        let payload = incomingRequests.get(container);
        if (!payload || payload.text !== text || payload.messageId !== id || payload.outgoing !== outgoing || payload.conversationId !== conversation.id || payload.revision !== generation) {
          container.querySelectorAll('[data-rt-ui="translation"], [data-rt-history-action]').forEach(el => el.remove());
          container.removeAttribute(RT_ATTR);
          payload = { text, conversationId: conversation.id, conversationName: conversation.name,
            messageId: id, context: contextFor(container, containers), outgoing, revision: generation };
          incomingRequests.set(container, payload);
        }
        const marked = container.getAttribute(RT_ATTR);
        if (['done', 'outgoing-done', 'history'].includes(marked)) {
          if (container.querySelector('.rt-translation, [data-rt-history-action]') || payload.sameText) continue;
          container.removeAttribute(RT_ATTR); // React replaced the text host; restore its annotation from the same message.
        }
        if (annotateOutgoing(container, settings, conversation.id)) continue;
        if (!/\p{L}/u.test(text)) { payload.sameText = true; container.setAttribute(RT_ATTR, 'done'); continue; }
        // Let the active send bind its original to the native receipt before a
        // history scan considers reverse-translating that newly created bubble.
        if(activeSend?.conversationId===conversation.id && !activeSend.baseline?.has(id)
          && normalizeMessage(text)===normalizeMessage(activeSend.translated)) continue;
        if (settings.translationsVisible === false) continue;
        if ((payload.retryAt || 0) > Date.now()) continue;
        if (incomingActiveCount >= 3) continue;
        const current = () => container.isConnected && generation === displayRevision && incomingRequests.get(container) === payload && messageId(container) === id
          && extractMessageText(container) === text && conversationInfo().id === conversation.id && targetKey() === target;
        const finish = translated => {
          if (!current()) return;
          if (typeof translated !== 'string' || !translated.trim()) throw new Error('暂未取得译文，将自动重试，也可以点击重试翻译。');
          if (translated && !equivalentDisplayText(translated, text)) addTranslation(container, translated, settings, 'incoming');
          payload.sameText = !translated || equivalentDisplayText(translated, text);
          container.setAttribute(RT_ATTR, 'done');
        };
        const showAction = (retry = false) => {
          container.querySelectorAll('[data-rt-history-action]').forEach(el => el.remove());
          const button = document.createElement('button');
          button.setAttribute('data-rt-ui', 'history-action'); button.setAttribute('data-rt-history-action', '');
          button.textContent = ui(retry ? '重试翻译' : '翻译此消息'); button.title = ui('翻译为我的语言');
          if (retry && payload.error) button.title = payload.error;
          Object.assign(button.style, { display: 'block', background: 'transparent', color: '#8fb7ab', border: '0', padding: '4px 0', cursor: 'pointer', fontSize: '11px' });
          button.onclick = async () => {
            if (button.disabled || !current() || incomingActive.has(container)) return;
            button.disabled = true; incomingActive.add(container); incomingActiveCount++;
            try {
              const result = await bounded(api.translateIncoming({ ...payload, manual: true }), 45000, '翻译暂未完成，请重试');
              if (current()) {
                finish(result); button.remove(); payload.retryAt = 0; payload.failures = 0;
                incomingPaused = false; incomingFailures = 0; incomingRetryAt = 0;
                if (!activeSend) reportStatus('ready', '翻译已恢复');
              }
            } catch (error) { if (current()) { incomingError(error, payload); button.disabled = false; button.textContent = ui('重试翻译'); } }
            finally {
              incomingActive.delete(container); incomingActiveCount--;
              if (document.defaultView && document.documentElement?.isConnected) setTimeout(() => { void translateVisible(); }, 30);
            }
          };
          messageTextHost(container).appendChild(button);
        };
        container.querySelectorAll('[data-rt-history-action]').forEach(el => el.remove());
        container.setAttribute(RT_ATTR, 'working');
        incomingActive.add(container); incomingActiveCount++;
        void (async () => {
        try {
          const cachedValue = await bounded(api.cachedIncoming?.(payload), 10000, '读取译文超时，请重试');
          const cached = typeof cachedValue === 'string' && cachedValue ? cachedValue : undefined;
          if (!current()) return;
          if (cached === undefined && (!settings.receiveAutoTranslate || (!settings.groupTranslate && isGroupChat()) || (mode !== 'visible' && !(mode === 'new' && allowedNew.has(target + ':' + id))))) {
            container.setAttribute(RT_ATTR, 'history');
            showAction();
            return;
          }
          const translated = cached !== undefined ? cached : await bounded(api.translateIncoming(payload), 45000, '翻译暂未完成，请重试');
          finish(translated);
          payload.retryAt = 0; payload.failures = 0;
          incomingFailures = 0;
        } catch (error) {
          container.removeAttribute(RT_ATTR);
          if (current()) { incomingError(error, payload); showAction(true); }
        } finally {
          incomingActive.delete(container); incomingActiveCount--;
          if (document.defaultView && document.documentElement?.isConnected) setTimeout(() => { void translateVisible(); }, 30);
        }
        })();
      }
    } catch (error) {
      incomingError(error);
    } finally { incomingBusy = false; }
  };

  // WhatsApp's Lexical state owns the draft. Its discrete update commits the
  // model and DOM together, without several asynchronous Ctrl+A/Backspace
  // round trips during which another Enter or paste could be lost.
  const editNativeComposer = (composer, text) => {
    const editor = composer?.__lexicalEditor;
    if (!editor || typeof editor.update !== 'function' || typeof editor.getEditorState !== 'function'
      || editor.getRootElement?.() !== composer) return null;
    const root = editor.getEditorState()?._nodeMap?.get('root');
    if (!root || typeof root.select !== 'function' || typeof root.getChildrenSize !== 'function') return null;
    if (composingEditors.has(composer) || editor.isComposing?.()) return false;
    try {
      editor.update(() => {
        const selection = root.select(0, root.getChildrenSize());
        if (typeof selection?.removeText !== 'function' || typeof selection?.insertRawText !== 'function') throw new Error('Unsupported native selection');
        selection.removeText();
        if (text) selection.insertRawText(text);
      }, { discrete: true });
      const state = editor.getEditorState();
      return normalizeMessage(state.read(() => state._nodeMap.get('root').getTextContent())) === normalizeMessage(text)
        && normalizeMessage(composerText(composer)) === normalizeMessage(text);
    } catch { return false; }
  };
  window.__RT_EDIT_ATOMIC__ = value => {
    const composer = getComposer();
    if (!composer || !composer.isConnected || targetKey() !== value.targetKey || conversationInfo().id !== value.conversationId
      || composerText(composer) !== value.expected) return false;
    return editNativeComposer(composer, value.text);
  };

  const replaceComposerText = async (composer, text) => {
    // Use the browser's editing transaction so Lexical updates its own state.
    // A DOM replacement can look empty while retaining the old native draft.
    if (!composer?.isConnected || getComposer() !== composer || composingEditors.has(composer)) return false;
    const atomic = editNativeComposer(composer, text);
    if (atomic !== null) return atomic;
    const key = targetKey(), wasLocked = editorLocked;
    editorLocked = true;
    try {
    if (window.realtimeTranslator?.editComposer) {
      return await bounded(window.realtimeTranslator.editComposer({token:crypto.randomUUID(),text,expected:composerText(composer),targetKey:key,conversationId:conversationInfo().id}),5000,'草稿交接超时');
    }
    composer.focus();
    await sleep(0);
    if (!composer.isConnected || getComposer() !== composer || targetKey() !== key) return false;
    const range = document.createRange();
    range.selectNodeContents(composer);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    await sleep(0); // Lexical consumes selectionchange before its edit command.
    if (!composer.isConnected || getComposer() !== composer || targetKey() !== key) return false;
    document.execCommand(text ? 'insertText' : 'delete', false, text || undefined);
    await sleep(0);
    return composer.isConnected && getComposer() === composer && targetKey() === key
      && normalizeMessage(composerText(composer)) === normalizeMessage(text);
    } catch { return false; } finally { editorLocked = wasLocked; }
  };

  window.__RT_EDIT_SELECT__ = value => {
    const composer=getComposer();
    if(nativeEditor||!composer||composingEditors.has(composer)||targetKey()!==value.targetKey||conversationInfo().id!==value.conversationId||composerText(composer)!==value.expected)return false;
    nativeEditor={...value,composer};composer.focus();return true;
  };
  window.__RT_EDIT_CHECK__ = async (token, finish = false) => {
    for(let n=0;n<20;n++) {
      const edit=nativeEditor,composer=getComposer();
      if(edit?.token!==token||composer!==edit.composer||targetKey()!==edit.targetKey||conversationInfo().id!==edit.conversationId)return false;
      if(finish) {if(normalizeMessage(composerText(composer))===normalizeMessage(edit.text)){
        await sleep(20); // Native selection/IME and Lexical reconciliation finish on separate tasks.
        return nativeEditor===edit && getComposer()===composer && targetKey()===edit.targetKey && normalizeMessage(composerText(composer))===normalizeMessage(edit.text);
      }}
      else {const selection=getSelection();if(selection?.rangeCount&&composer.contains(selection.getRangeAt(0).commonAncestorContainer)&&normalizeMessage(selection.toString())===normalizeMessage(edit.expected))return true;}
      await sleep(5);
    }
    return false;
  };
  window.__RT_EDIT_RELEASE__ = token => {if(nativeEditor?.token===token)nativeEditor=null;};
  window.__RT_EDIT_WRITE__ = token => {
    const edit=nativeEditor;
    if(edit?.token!==token||getComposer()!==edit.composer||targetKey()!==edit.targetKey||conversationInfo().id!==edit.conversationId)return false;
    return document.execCommand('insertText',false,edit.text);
  };

  const matchesSnapshot = (snapshot) => snapshot && snapshot.composer.isConnected
    && getComposer() === snapshot.composer && document.querySelector('#main header') === snapshot.header
    && conversationInfo().id === snapshot.conversationId
    && (targetKey() === snapshot.targetKey || snapshot.targetKey === 'title:' + snapshot.conversationId)
    && navigationRevision === snapshot.navigationRevision;

  const outgoingIds = () => new Set(messageContainers().filter(isOutgoingContainer).map(messageId).filter(id => id && !id.startsWith('pre:')));

  window.__RT_SEND_SELECT__ = (task) => {
    const queued = queuedSends.get(task.id);
    if (queued) {
      const composer = getComposer();
      if (!composer || composingEditors.has(composer) || queued.targetKey !== targetKey() || queued.conversationId !== conversationInfo().id
        || (!queued.targetKey.startsWith('peer:') && queued.navigationRevision !== navigationRevision)) return false;
      activeSend = { composer, id: task.id, original: task.original, translated: task.translated,
        targetKey: queued.targetKey, conversationId: queued.conversationId, header: document.querySelector('#main header'),
        navigationRevision, queued: true, restoreText: restoredFailedDraft?.id === task.id
          && restoredFailedDraft.composer === composer && restoredFailedDraft.revision === inputRevision
          && composerText(composer) === queued.original ? '' : composerText(composer) };
      if (restoredFailedDraft?.id === task.id) restoredFailedDraft = null;
    }
    const snapshot = activeSend;
    if (!snapshot || snapshot.id !== task.id || !matchesSnapshot(snapshot)
      || snapshot.original !== task.original
      || (snapshot.targetKey !== task.targetKey && task.targetKey !== 'title:' + snapshot.conversationId)
      || (!snapshot.queued && composerText(snapshot.composer) !== snapshot.original)) return false;
    snapshot.translated = task.translated;
    snapshot.baseline = outgoingIds();
    editorLocked = true;
    snapshot.composer.focus();
    if (!window.realtimeTranslator?.editComposer) {
      const range = document.createRange();
      range.selectNodeContents(snapshot.composer);
      const selection = window.getSelection();
      selection?.removeAllRanges();selection?.addRange(range);
    }
    return { text: composerText(snapshot.composer) };
  };

  window.__RT_SEND_COMMIT__ = async (task) => {
    const snapshot = activeSend;
    await sleep(0); // Let native input/React update the send button before clicking.
    const button = findSendButton();
    if (hasBlockedChinese(composerText(snapshot?.composer), task.targetLanguage || 'en')) {
      return { dispatched: false, message: '输入框仍含中文，已阻止发送并保留草稿。' };
    }
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
    } finally { nativeClick = null; }
    if (snapshot.queued) {
      // The native send action clears its editor asynchronously. Do not put the
      // next draft back until that transaction has completed.
      for (let n = 0; n < 30; n++) {
        await sleep(10);
        const composer = getComposer();
        if (!composer || targetKey() !== snapshot.targetKey) break;
        if (!composerText(composer)) {
          snapshot.draftRestored = !snapshot.restoreText || await replaceComposerText(composer, snapshot.restoreText);
          if (snapshot.draftRestored) void window.realtimeTranslator?.saveDraft?.(draftTarget(), snapshot.restoreText).catch(() => {});
          break;
        }
      }
    }
    editorLocked = false;
    for (let i = 0; i < (snapshot.queued ? 25 : 150); i += 1) {
      // After dispatch React may replace the editor/header. Guard the peer and
      // navigation revision, not DOM identity; never accept a different chat.
      const currentTarget = targetKey();
      const samePeer = snapshot.targetKey.startsWith('peer:') ? currentTarget === snapshot.targetKey
        : conversationInfo().id === snapshot.conversationId;
      if (navigationRevision !== snapshot.navigationRevision || !samePeer) return { dispatched: true, confirmed: false };
      const receipt = messageContainers().find(container => {
        const id = messageId(container);
        return isOutgoingContainer(container) && id && !id.startsWith('pre:') && !snapshot.baseline.has(id)
          && normalizeMessage(extractMessageText(container)) === normalizeMessage(task.translated);
      });
      if (receipt) {
        rememberSent(task.translated, snapshot.original, snapshot.conversationId, messageId(receipt));
        return { dispatched: true, confirmed: true, messageId: messageId(receipt) };
      }
      await sleep(100);
    }
    return { dispatched: true, confirmed: false, baseline: [...snapshot.baseline], targetKey: snapshot.targetKey };
  };

  window.__RT_SEND_PROBE__ = (task) => {
    if (!Array.isArray(task.baseline) || task.targetKey !== targetKey()) return null;
    const baseline = new Set(task.baseline);
    const receipt = messageContainers().find(container => {
      const id = messageId(container);
      return isOutgoingContainer(container) && id && !id.startsWith('pre:') && !baseline.has(id)
        && normalizeMessage(extractMessageText(container)) === normalizeMessage(task.translated);
    });
    return receipt ? { queued: true, messageId: messageId(receipt) } : null;
  };

  window.__RT_SEND_RELEASE__ = async (id, restore) => {
    const snapshot = activeSend;
    if (snapshot?.id !== id) return;
    editorLocked = false;
    if (snapshot.queued) {
      const composer = getComposer();
      if (!snapshot.draftRestored && composer && targetKey() === snapshot.targetKey && (!composerText(composer) || normalizeMessage(composerText(composer)) === normalizeMessage(snapshot.translated))) {
        await replaceComposerText(composer, snapshot.restoreText || '');
      }
      activeSend = null;
      return;
    }
    if (restore && matchesSnapshot(snapshot) && normalizeMessage(composerText(snapshot.composer)) === normalizeMessage(snapshot.translated)) {
      await replaceComposerText(snapshot.composer, snapshot.original);
    }
  };

  const showPending = () => {
    document.getElementById('rt-send-status')?.remove();
  };

  const recoverPending = async () => {
    if (sending) return;
    const conversation = conversationInfo();
    const key = targetKey();
    if (!conversation.id || !getComposer() || key === lastPendingTarget) return;
    lastPendingTarget = key;
    try {
      const task = await bounded(window.realtimeTranslator?.pendingSend(conversation.id, key), 8000, '读取发送记录超时');
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

  const previewTranslation = (task, settings, snapshot) => new Promise(resolve => {
    const panel = document.createElement('section'); panel.setAttribute('data-rt-ui', 'send-preview'); panel.setAttribute('aria-label', ui('发送译文预览'));
    Object.assign(panel.style, { padding: '10px', background: '#202c33', color: '#e9edef', borderTop: '1px solid #42515a', maxHeight: '260px', overflowY: 'auto' });
    const original = document.createElement('textarea'); original.value = task.request.text; original.readOnly = true; original.setAttribute('aria-label', ui('原文'));
    const translated = document.createElement('textarea'); translated.value = task.translated; translated.setAttribute('aria-label', ui('可编辑译文'));
    for (const area of [original, translated]) { Object.assign(area.style, { width: '100%', boxSizing: 'border-box', minHeight: '50px', background: '#111b21', color: '#e9edef', border: '1px solid #42515a', borderRadius: '6px', padding: '8px' }); panel.appendChild(area); }
    const output = document.createElement('p'); output.style.fontSize = '12px'; panel.appendChild(output);
    const finish = value => { clearInterval(timer); panel.remove(); resolve(value); };
    const timer = setInterval(() => { if (!snapshot.composer.isConnected || navigationRevision !== snapshot.navigationRevision || targetKey() !== snapshot.targetKey) finish(null); }, 250);
    const addButton = (label, run) => { const button = document.createElement('button'); button.textContent = ui(label); Object.assign(button.style, { padding: '7px 12px', marginRight: '8px', color: '#e9edef', background: '#37554b', border: '0', borderRadius: '6px', cursor: 'pointer' }); button.onclick = run; panel.appendChild(button); return button; };
    addButton('发送译文', () => { if (translated.value.trim()) finish(translated.value.trim()); });
    addButton(snapshot.queued ? '暂不发送' : '恢复原文 / 取消发送', () => finish(null));
    if (settings.backTranslation) { const button = addButton('回翻（新翻译，成功按字符计费）', async () => { button.disabled = true; const text = translated.value; try { const value = await window.realtimeTranslator.backTranslateSend(task.id, text); if (text === translated.value) output.textContent = ui('回翻：') + value; } catch (error) { output.textContent = String(error?.message || error); } finally { button.disabled = false; } }); }
    translated.addEventListener('input', () => { output.textContent = ''; });
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); finish(null); } });
    (document.querySelector('#main footer') || document.body).appendChild(panel); translated.focus();
  });

  const renderQueuedSends = () => {
    // Recovery is available in HelloDog records. Never cover native messages or
    // the composer with a second, floating set of outgoing bubbles.
    document.querySelectorAll('[data-rt-ui="outbox"], #rt-send-status').forEach(node => node.remove());
  };
  window.__RT_RETRY_QUEUED_SEND__ = async id => {
    await restoreQueuedSends(true);
    const job = queuedSends.get(id);
    if (job?.state === 'failed' && job.scheduled) {
      const deadline = Date.now() + 5500;
      while (job.scheduled && Date.now() < deadline) await sleep(10);
    }
    if (!job || job.state === 'uncertain' || job.scheduled || job.targetKey !== targetKey()
      || job.conversationId !== conversationInfo().id) return false;
    job.navigationRevision = navigationRevision;
    scheduleQueuedSend(job); return true;
  };
  const scheduleQueuedSend = (job) => {
    if (job.scheduled || job.state === 'uncertain') return;
    job.scheduled = true; job.state = 'translating'; job.error = ''; renderQueuedSends();
    const api = window.realtimeTranslator;
    // Prepare translations concurrently, then serialize only platform dispatch.
    const translated = bounded(api.translateSend(job.id), 45000, '翻译响应较慢，原消息已保存。').then(task => ({ task }), error => ({ error }));
    const settings = bounded(api.getRuntimeSettings(job.conversationId), 5000, '设置暂时无法读取。').then(value => ({ value }), error => ({ error }));
    commitTail = commitTail.catch(() => {}).then(async () => {
      try {
        const prepared = await translated;
        if (prepared.error) throw prepared.error;
        let task = prepared.task;
        if (['uncertain', 'submitting'].includes(task.state)) { job.state = 'uncertain'; return; }
        if (task.state === 'sent') { queuedSends.delete(job.id); return; }
        const runtime = await settings;
        if (runtime.error) throw runtime.error;
        if (targetKey() !== job.targetKey || conversationInfo().id !== job.conversationId) throw new Error('已保留，请回到原对话后重试。');
        if (runtime.value?.previewSend && task.translate !== false) {
          const snapshot = { composer: getComposer(), navigationRevision, targetKey: job.targetKey, queued: true };
          const edited = await previewTranslation(task, runtime.value, snapshot);
          if (edited === null) { job.state = 'failed'; job.error = '原文和译文已保留'; return; }
          task = await api.editSendPreview(job.id, edited);
        }
        // Wait before touching the native editor while the next draft has an
        // active IME candidate. No platform command has been dispatched yet.
        const composeDeadline = Date.now() + 15000;
        while (composingEditors.has(getComposer()) || queuePreparing || nativeEditor || editorLocked || Date.now() - lastUserInputAt < 120) {
          if (targetKey() !== job.targetKey || conversationInfo().id !== job.conversationId) throw new Error('已保留，请回到原对话后重试。');
          if (Date.now() >= composeDeadline) throw new Error('正在输入的内容已保留，请完成选词后重试这条消息。');
          await sleep(50);
        }
        job.state = 'sending'; renderQueuedSends();
        const result = await bounded(api.submitSend(job.id), 15000, '发送正在后台确认。');
        if (result?.state === 'uncertain') job.state = 'uncertain';
        else { queuedSends.delete(job.id); showSendStatus('已发送', 'success'); void translateVisible(); }
      } catch (error) {
        // Translation uncertainty is not platform-send uncertainty. Only a
        // submitted platform command can require a no-resend reconciliation.
        job.state = job.state === 'sending' && /后台确认|未确认/.test(error?.message || '') ? 'uncertain' : 'failed'; job.error = String(error?.message || '暂未发送');
        if(job.state==='failed') {
          const composer = getComposer();
          if (composer && !composerText(composer) && targetKey() === job.targetKey && conversationInfo().id === job.conversationId
            && !editorLocked && !composingEditors.has(composer)) {
            if (await replaceComposerText(composer, job.original)) {
              restoredFailedDraft = { id:job.id, composer, revision:inputRevision };
              void api.saveDraft?.({conversationId:job.conversationId,targetKey:job.targetKey},job.original).catch(() => {});
            }
          }
          reportStatus('error','消息尚未发送，原文已保留。' + job.error);
        }
        else reportStatus('ready', '');
      } finally { job.scheduled = false; renderQueuedSends(); }
    });
  };
  const prepareQueuedSend = async (composer) => {
    if (queuePreparing || editorLocked) return;
    const original = composerText(composer), conversation = conversationInfo(), key = targetKey();
    if (!original || !conversation.id) return;
    const restored = restoredFailedDraft?.composer === composer && restoredFailedDraft.revision === inputRevision
      ? queuedSends.get(restoredFailedDraft.id) : null;
    if (restored && restored.original === original && restored.targetKey === key) {
      if (!restored.scheduled) await window.__RT_RETRY_QUEUED_SEND__(restored.id);
      return;
    }
    const preparation = {};
    queuePreparing = preparation;
    try {
    // An IPC timeout does not prove that the durable write failed. Retrying
    // this unacknowledged compose operation must retain its identity.
    if (!unacknowledgedIntent || unacknowledgedIntent.original !== original || unacknowledgedIntent.key !== key
      || unacknowledgedIntent.conversationId !== conversation.id) unacknowledgedIntent = { original, key, conversationId: conversation.id, id: crypto.randomUUID() };
      const task = await bounded(window.realtimeTranslator.prepareQueuedSend({ text: original, conversationId: conversation.id, targetKey: key,
        intentId: unacknowledgedIntent.id, context: outgoingContext() }), 8000, '本地保存暂时没有响应，请重试。');
      const job = queuedSends.get(task.id) || { id: task.id, original, conversationId: conversation.id, targetKey: key, navigationRevision, state: 'translating', scheduled: false };
      queuedSends.set(task.id, job);
      if (getComposer() !== composer || key !== targetKey() || composerText(composer) !== original
        || !await replaceComposerText(composer, '')) {
        job.state = 'failed'; job.error = '输入内容已变化，原消息已保留。';
        throw new Error('草稿尚未交接，未发送；原消息已保存在记录与恢复。');
      }
      // Clearing the native draft is complete. A following Enter belongs to
      // the next message even while the previous draft-save IPC settles.
      if (queuePreparing === preparation) queuePreparing = false;
      unacknowledgedIntent = null;
      await bounded(window.realtimeTranslator?.saveDraft?.({conversationId:conversation.id,targetKey:key}, ''), 8000, '草稿保存暂时没有响应，原消息已保留。');
      if (['uncertain', 'submitting'].includes(task.state)) { job.state = 'uncertain'; renderQueuedSends(); return; }
      scheduleQueuedSend(job);
    } catch (error) { showSendStatus(String(error?.message || error), 'error'); }
    finally { if (queuePreparing === preparation) queuePreparing = false; }
  };
  let restoringQueue = false, lastQueueRestore = 0;
  const restoreQueuedSends = async (force = false) => {
    if (!window.realtimeTranslator?.pendingSends || restoringQueue || (!force && Date.now() - lastQueueRestore < 5000)) return;
    restoringQueue = true; lastQueueRestore = Date.now();
    try {
      const tasks = await bounded(window.realtimeTranslator.pendingSends(), 8000, '读取发送记录超时');
      for (const task of tasks || []) if (!queuedSends.get(task.id)?.scheduled) queuedSends.set(task.id, { id: task.id, original: task.request.text,
        conversationId: task.conversationId, targetKey: task.targetKey, navigationRevision,
        state: ['uncertain','submitting'].includes(task.state) ? 'uncertain' : 'failed', error: '已保留，点击重试继续原消息。' });
      for (const [id, job] of queuedSends) if (!job.scheduled && !tasks.some(task => task.id === id)) queuedSends.delete(id);
      renderQueuedSends();
    } catch {} finally { restoringQueue = false; }
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
      task = await bounded(api.prepareSend({ text: original, conversationId: conversation.id, targetKey: snapshot.targetKey, context: outgoingContext() }), 8000, '本地保存暂时没有响应，请重试。');
      snapshot.id = task.id;
      if (['uncertain', 'submitting'].includes(task.state)) { reportStatus('ready', ''); showPending(task); return; }
      showSendStatus('正在确认译文，草稿已保留…', 'working', false);
      task = await bounded(api.translateSend(task.id), 90000, '翻译暂时没有返回，草稿已保存。重试会继续原请求。');
      if (!matchesSnapshot(snapshot) || composerText(composer) !== original) throw new Error('对话或草稿已变化，译文已保存，没有发送。');
      const settings = await bounded(api.getRuntimeSettings(conversation.id), 5000, '设置暂时无法读取，请重试。');
      if (settings.previewSend && task.translate !== false) {
        const edited = await previewTranslation(task, settings, snapshot);
        if (edited === null) { await api.cancelSend(task.id); reportStatus('ready', '已取消发送，原文保留在输入框。'); return; }
        if (!matchesSnapshot(snapshot) || composerText(composer) !== original) throw new Error('对话或草稿已变化，没有发送。');
        task = await api.editSendPreview(task.id, edited);
      }
      snapshot.translated = task.translated;
      showSendStatus('译文已保存，正在提交并等待 WhatsApp 确认…', 'working', false);
      const result = await bounded(api.submitSend(task.id), 45000, '发送正在后台确认，可以继续聊天。');
      showSendStatus(result?.state === 'uncertain' ? '' : '已发送', 'success');
      void translateVisible();
    } catch (error) {
      showSendStatus(String(error?.message || error) + ' 原任务已保留。', 'error', false);
      if (task) {
        void api.pendingSend(conversation.id, snapshot.targetKey).then(showPending).catch(() => {});
      }
    } finally { editorLocked = false; activeSend = null; }
  };

  const interceptSendNow = (event, composer) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (window.realtimeTranslator?.prepareQueuedSend) { void prepareQueuedSend(composer); return; }
    if (sending) return;
    sending = true;
    composer.setAttribute('data-rt-sending', 'true');
    void processSend(composer).finally(() => {
      composer.removeAttribute('data-rt-sending');
      sending = false;
    });
  };

  const stopInput = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
  const auxiliaryEditor = target => (target instanceof Element ? target : target?.parentElement)?.closest('[role="dialog"], [data-testid*="media-preview"]');
  const guardAuxiliary = (event, scope) => {
    const text = [...scope.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"], textarea')]
      .map(editor => editor.value || composerText(editor)).join(' ');
    if (/\p{Script=Han}/u.test(text)) { stopInput(event); reportStatus('error', '此编辑窗口中的中文尚未翻译，已阻止发送。请先在聊天输入框翻译后再使用。'); }
  };
  document.addEventListener('compositionstart', event => {
    const composer = getComposer(event.target);
    if (composer?.contains(event.target)) { composingEditors.add(composer); inputRevision++; }
  }, true);
  document.addEventListener('compositionend', event => {
    const composer = getComposer(event.target);
    if (composer?.contains(event.target)) {
      composingEditors.delete(composer);
      // Some IMEs emit a final paragraph event after compositionend in the
      // same key action. The next independent Enter remains available.
      setTimeout(() => nativeParagraphEditors.delete(composer), 0);
    }
  }, true);
  window.addEventListener('keydown', (event) => {
    if(nativeEditor && event.isTrusted && (((event.key.toLowerCase()==='a'||event.key==='End') && event.ctrlKey)||event.key==='Backspace')) return;
    if (editorLocked) { stopInput(event); return; }
    const auxiliary = auxiliaryEditor(event.target);
    if (auxiliary && !auxiliary.closest('[data-rt-ui]')) {
      if (event.key === 'Enter' && !(event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey)) {
        if (event.isComposing || event.keyCode === 229) { event.stopPropagation(); event.stopImmediatePropagation(); }
        else guardAuxiliary(event, auxiliary);
      }
      return;
    }
    const composer = getComposer(event.target);
    if (!composer?.contains(event.target)) return;
    lastUserInputAt = Date.now();
    if (event.isComposing || event.keyCode === 229 || composingEditors.has(composer)) {
      nativeParagraphEditors.add(composer);
      if (event.key === 'Enter') { event.stopPropagation(); event.stopImmediatePropagation(); }
      return;
    }
    if (event.key !== 'Enter') { nativeParagraphEditors.delete(composer); return; }
    if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) { nativeParagraphEditors.add(composer); return; }
    nativeParagraphEditors.delete(composer);
    interceptSendNow(event, composer);
  }, true);
  window.addEventListener('keyup', event => {
    const composer = getComposer(event.target);
    if (composer?.contains(event.target)) {
      nativeParagraphEditors.delete(composer);
      if (event.key === 'Enter' && !(event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey)) stopInput(event);
    }
  }, true);
  document.addEventListener('beforeinput', (event) => {
    if (event.inputType !== 'insertParagraph' || event.isComposing) return;
    const composer = getComposer(event.target);
    if (composer && composer.contains(event.target) && !composingEditors.has(composer) && !nativeParagraphEditors.has(composer)) interceptSendNow(event, composer);
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (editorLocked) { stopInput(event); return; }
    const composer = getComposer();
    if (!composer?.contains(event.target) && !isSendTarget(event.target)
      && !event.target?.closest?.('[data-rt-ui]')) navigationRevision += 1;
  }, true);
  for (const name of ['paste', 'drop']) document.addEventListener(name, (event) => { if (editorLocked) stopInput(event); }, true);
  window.addEventListener('click', (event) => {
    if (nativeClick && (event.target === nativeClick || nativeClick.contains(event.target))) return;
    if (editorLocked) { stopInput(event); return; }
    const auxiliary = auxiliaryEditor(event.target), button = (event.target instanceof Element ? event.target : event.target?.parentElement)?.closest('button,[role="button"]');
    if (auxiliary && button && !auxiliary.closest('[data-rt-ui]')) {
      if (/send|发送|save|保存|confirm|确认/i.test([button.getAttribute('aria-label'),button.getAttribute('data-testid'),button.getAttribute('data-icon')].join(' '))
        || button.querySelector('[data-icon*="send"],[data-testid*="send"],[data-icon="checkmark"]')) guardAuxiliary(event, auxiliary);
      return;
    }
    if (!isSendTarget(event.target)) return;
    const composer = getComposer();
    if (composer) interceptSendNow(event, composer);
    else { stopInput(event); reportStatus('error', '暂时无法确认发送内容，已阻止发送。请重新打开当前对话。'); }
  }, true);

  let restoredDraftTarget = '';
  const draftTarget = () => ({ conversationId: conversationInfo().id, targetKey: targetKey() });
  window.__RT_SAVE_WORKSPACE__ = async () => {
    const composer = getComposer(), target = draftTarget();
    if (!sending && !editorLocked && composer && target.conversationId) await window.realtimeTranslator.saveDraft(target, composerText(composer));
    const draft = Boolean(composer && composerText(composer).trim());
    // Rich composer state and media previews belong to WhatsApp and remain in place.
    const media = Boolean(document.querySelector('[role="dialog"], [data-testid*="media-preview"], [data-testid*="recording"]'));
    for (const track of activeMediaTracks) if (track.readyState === 'ended') activeMediaTracks.delete(track);
    const capturing = activeMediaTracks.size > 0;
    const composing = Boolean(composer && composingEditors.has(composer));
    return { editing: Boolean(editorLocked || composing), media, capturing, busy: Boolean(sending || editorLocked || composing || draft || media || capturing) };
  };
  window.__RT_INSERT_DRAFT__ = async text => {
    const composer = getComposer();
    if (!composer || sending || editorLocked || composingEditors.has(composer) || composerText(composer) || !conversationInfo().id) return false;
    return replaceComposerText(composer, text);
  };
  document.addEventListener('input', event => {
    const composer = getComposer();
    if (!composer || !(event.target instanceof Node) || !composer.contains(event.target)) return;
    inputRevision++;
    if (!nativeEditor && !editorLocked) lastUserInputAt = Date.now();
    if (sending || editorLocked) return;
    const target = draftTarget();
    if (target.conversationId) void window.realtimeTranslator?.saveDraft?.(target, composerText(composer)).catch(() => reportStatus('error', '草稿保存失败，请先复制输入内容。'));
  });
  const restoreDraft = async () => {
    const target = draftTarget(), composer = getComposer();
    if (!composer || !target.conversationId || restoredDraftTarget === target.targetKey || sending) return;
    restoredDraftTarget = target.targetKey;
    const revision = inputRevision;
    try {
      const text = await bounded(window.realtimeTranslator?.getDraft?.(target), 8000, '读取草稿超时');
      if (text && revision === inputRevision && getComposer() === composer && targetKey() === target.targetKey && !composerText(composer)) window.__RT_INSERT_DRAFT__(text);
    } catch { if (restoredDraftTarget === target.targetKey) restoredDraftTarget = ''; }
  };
  setInterval(() => {
    renderQueuedSends(); void restoreQueuedSends();
    window.realtimeTranslator?.reportConnection?.(!navigator.onLine ? 'offline' : document.querySelector('#pane-side, #side') ? 'page-ready' : document.querySelector('[data-ref], [data-testid="qrcode"]') ? 'login-required' : 'loading');
    void restoreDraft();
    if(document.querySelector('#pane-side, #side')){
      const titleCount = Number((document.title.match(/(?:^\(([\d,]+)\)|\(([\d,]+)\)$)/)?.slice(1).find(Boolean) || '0').replace(/,/g,''));
      if (titleCount !== lastUnread) { lastUnread = titleCount; window.realtimeTranslator?.reportUnread?.(titleCount); }
    }
    void recoverPending(); void translateVisible(); }, 1400);
  void translateVisible();
})();
` + whatsappSidebarScript + whatsappContactScript;
