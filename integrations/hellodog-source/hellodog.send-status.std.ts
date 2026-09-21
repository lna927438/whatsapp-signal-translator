// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only

const pendingRetries = new WeakMap<object, Promise<void>>();

/** A manual retry is still the same native message/job. Clear obsolete display
 * errors while queuing it, but keep native challenges and identity verification.
 * Failed persistence restores only our changes, never a newer delivery receipt. */
export function retryHelloDogMessage<S extends { readonly status: string }, E extends { readonly name?: string }>(options: {
  enabled: boolean;
  identity: object;
  beforeStates: Readonly<Record<string, S>>;
  nextStates: Readonly<Record<string, S>>;
  errors: ReadonlyArray<E> | null | undefined;
  current: () => { states: Readonly<Record<string, S>>; errors: ReadonlyArray<E> | null | undefined };
  update: (states: Readonly<Record<string, S>>, errors: ReadonlyArray<E> | null | undefined) => void;
  enqueue: () => Promise<void>;
}): Promise<void> {
  if (!options.enabled) {
    options.update(options.nextStates, options.errors);
    return options.enqueue();
  }
  const existing = pendingRetries.get(options.identity);
  if (existing) return existing;
  const work = Promise.resolve().then(async () => {
    const latest = options.current(), appliedStates = { ...latest.states };
    for (const [id, state] of Object.entries(options.nextStates)) {
      if (latest.states[id] === options.beforeStates[id]) appliedStates[id] = state;
    }
    const errors = latest.errors === options.errors
      ? options.errors?.filter(error => error.name === 'SendMessageChallengeError' || error.name === 'OutgoingIdentityKeyError')
      : latest.errors;
    options.update(appliedStates, errors);
    try { await options.enqueue(); }
    catch (error) {
      const current = options.current(), restored = { ...current.states };
      let advanced = false;
      for (const [id, state] of Object.entries(appliedStates)) {
        if (state === options.nextStates[id] && current.states[id] === state && options.beforeStates[id]) restored[id] = options.beforeStates[id];
        else if (current.states[id] !== options.beforeStates[id]) advanced = true;
      }
      options.update(restored, !advanced && current.errors === errors ? options.errors : current.errors);
      throw error;
    }
  }).finally(() => { if (pendingRetries.get(options.identity) === work) pendingRetries.delete(options.identity); });
  pendingRetries.set(options.identity, work);
  return work;
}

/** Exact tagged preflight failures only; native transport/partial sends retain
 * Signal's wording. Never infer a reason from arbitrary error message strings. */
export function helloDogPreparationFailureLabel(message: {
  type?: string;
  errors?: ReadonlyArray<{ name?: string }> | null;
  sendStateByConversationId?: Readonly<Record<string, { status: string }>>;
} | undefined, locale: string): { label: string; detail: string } | undefined {
  const errors = message?.errors, states = Object.values(message?.sendStateByConversationId || {});
  if (message?.type !== 'outgoing' || !errors?.length || !states.length
    || !errors.every(error => error.name === 'HelloDogSendPreparationError')
    || !states.every(state => state.status === 'Failed')) return undefined;
  return locale.toLowerCase().startsWith('zh')
    ? { label: '发送前检查未通过', detail: '本次发送前检查未完成，请查看消息详情；如曾发送过，先核对会话，再重试原消息。' }
    : { label: 'Pre-send check failed', detail: 'This attempt did not complete its pre-send checks. Review the message details; if sending was attempted before, check the conversation before retrying the original message.' };
}
