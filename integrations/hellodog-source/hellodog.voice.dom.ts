// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
export type SignalVoiceResult = { text: string; translation: string; audioId: string; targetLanguage: 'zh-CN' };
export type SignalVoiceItem = { id: string; conversationId: string; attachmentId: string; expiresAt?: number; ready: boolean };
export type SignalVoiceDependencies = {
  document: Document;
  items(id: string): SignalVoiceItem[];
  selectedConversation(): string | undefined;
  translate(item: SignalVoiceItem, current: () => boolean): Promise<SignalVoiceResult>;
};

/** Display-only, explicit actions. No composer/send APIs or attachment URLs. */
export function createSignalVoiceUi(deps: SignalVoiceDependencies) {
  type State = { item: SignalVoiceItem; busy: boolean; error: string; result?: SignalVoiceResult };
  const states = new Map<string, State>();
  let revision = 0, disposed = false, selected = '';
  const key = (item: SignalVoiceItem) => JSON.stringify([item.id, item.conversationId, item.attachmentId]);
  const allowed = (item: SignalVoiceItem) => !disposed && (item.expiresAt ?? Infinity) > Date.now()
    && deps.selectedConversation() === item.conversationId && deps.items(item.id).some(value => key(value) === key(item) && (value.expiresAt ?? Infinity) > Date.now());
  function scan(): void {
    if (disposed) return;
    const conversation = deps.selectedConversation() || '';
    if (selected !== conversation) { revision++; states.clear(); selected = conversation; }
    for (const [id, state] of states) if (!allowed(state.item)) states.delete(id);
    for (const element of Array.from(deps.document.querySelectorAll<HTMLElement>('[data-hellodog-id]'))) {
      const items = deps.items(element.dataset.hellodogId || '').filter(allowed);
      for (const node of Array.from(element.querySelectorAll<HTMLElement>('[data-hellodog-voice]'))) {
        if (!items.some(item => key(item) === node.dataset.hellodogVoice)) node.remove();
      }
      for (const item of items) {
        const id = key(item);
        let state = states.get(id);
        if (!state) { state = { item, busy: false, error: '' }; states.set(id, state); }
        state.item = item;
        let panel = Array.from(element.querySelectorAll<HTMLElement>('[data-hellodog-voice]')).find(node => node.dataset.hellodogVoice === id);
        if (!panel) {
          panel = deps.document.createElement('section'); panel.dataset.hellodogVoice = id; panel.dataset.hellodogUi = 'voice';
          // Signal's container-outer uses line-height:0 for its media layout.
          // Reset it for our text so wrapped status/results take up real height.
          panel.setAttribute('aria-label', '语音转中文'); panel.style.cssText = 'box-sizing:border-box;padding:7px 10px;max-width:420px;min-width:0;white-space:normal;overflow-wrap:anywhere;font-size:13px;line-height:1.5';
          (element.querySelector('.module-message__container') || element).appendChild(panel);
        }
        const view = JSON.stringify([state.busy, state.error, state.result?.translation, item.ready]);
        if (panel.dataset.voiceState === view) continue;
        panel.dataset.voiceState = view; panel.replaceChildren();
        const button = deps.document.createElement('button');
        button.type = 'button'; button.disabled = state.busy;
        button.textContent = state.busy ? '正在转为中文…' : state.error ? '重试语音翻译' : state.result ? '已转为中文' : '转为中文';
        button.disabled ||= Boolean(state.result);
        button.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid #8887;border-radius:7px;padding:5px 10px;cursor:pointer';
        button.onclick = event => { event.preventDefault(); event.stopPropagation(); void run(state!); };
        panel.appendChild(button);
        const status = deps.document.createElement('div'); status.setAttribute('role', 'status'); status.style.cssText = 'padding-top:6px;white-space:pre-wrap';
        status.textContent = state.result?.translation || state.error || (item.ready ? '仅显示中文，不会发送消息。' : '请先用 Signal 下载这条语音，再点击转为中文。');
        panel.appendChild(status);
      }
    }
    while (states.size > 200) { const idle = [...states].find(([, state]) => !state.busy); if (!idle) break; states.delete(idle[0]); }
  }
  async function run(state: State): Promise<void> {
    const item = state.item, generation = revision;
    if (state.busy || state.result || !allowed(item)) return;
    if (!item.ready) { state.error = '请先下载语音，再重试。'; scan(); return; }
    const current = () => generation === revision && states.get(key(item)) === state && allowed(item);
    state.busy = true; state.error = ''; scan();
    try {
      const result = await deps.translate(item, current);
      if (!current()) return;
      if (!result || result.targetLanguage !== 'zh-CN' || typeof result.translation !== 'string' || !result.translation.trim() || result.translation.length > 20000) throw new Error('invalid result');
      state.result = result;
    } catch { if (current()) state.error = '语音暂未转为中文，请稍后重试。原语音已保留。'; }
    finally { if (current()) { state.busy = false; scan(); } }
  }
  return { scan, reset() { revision++; states.clear(); deps.document.querySelectorAll('[data-hellodog-voice]').forEach(node => node.remove()); scan(); },
    dispose() { disposed = true; revision++; states.clear(); deps.document.querySelectorAll('[data-hellodog-voice]').forEach(node => node.remove()); } };
}
