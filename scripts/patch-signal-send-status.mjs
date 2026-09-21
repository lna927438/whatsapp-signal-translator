// Pure transformation so tests can exercise pinned native code without writing
// the shared Signal checkout. Refuse drift and make repeated patching a no-op.
export function patchSignalSendStatus(file, source) {
  let text = source.replace(/\r\n/g, '\n');
  const replace = (before, after) => {
    if (text.includes(after)) return;
    if (text.split(before).length !== 2) throw new Error('Signal send-status anchor changed: ' + file);
    text = text.replace(before, after);
  };
  if (file === 'ts/state/ducks/conversations.preload.ts') {
    const imported = "import { retryHelloDogMessage } from '../../hellodog/hellodog.send-status.std.ts';\n";
    if (!text.includes(imported)) text = imported + text;
    replace('    message.set({ sendStateByConversationId: newSendStateByConversationId });\n\n    if (isStory(message.attributes)) {', `    await retryHelloDogMessage({
      enabled: process.env.HELLODOG_EMBEDDED === '1' && process.env.HELLODOG_BRIDGE_ACTIVE === '1',
      identity: message,
      beforeStates: oldSendStateByConversationId,
      nextStates: newSendStateByConversationId,
      errors: message.get('errors'),
      current: () => ({ states: message.get('sendStateByConversationId') || {}, errors: message.get('errors') }),
      update: (states, errors) => { message.set({ sendStateByConversationId: states, errors }); },
      enqueue: async () => {
    if (isStory(message.attributes)) {`);
    replace("    dispatch(noopAction('retryMessageSend'));", "      },\n    });\n\n    dispatch(noopAction('retryMessageSend'));");
  } else if (file === 'ts/components/conversation/MessageMetadata.dom.tsx') {
    const imported = "import { helloDogPreparationFailureLabel } from '../../hellodog/hellodog.send-status.std.ts';\n";
    if (!text.includes(imported)) text = imported + text;
    replace("            statusInfo = i18n('icu:sendFailed');", `            const preparationFailure = helloDogPreparationFailureLabel(window.MessageCache?.getById(id)?.attributes, i18n.getLocale());
            statusInfo = preparationFailure
              ? <span title={preparationFailure.detail}>{preparationFailure.label}</span>
              : i18n('icu:sendFailed');`);
  } else throw new Error('Unsupported Signal send-status file: ' + file);
  return text;
}
