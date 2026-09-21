import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { patchSignalSendStatus } from './patch-signal-send-status.mjs';
const root=resolve(import.meta.dirname,'..'), upstream=resolve(root,'integrations/signal-desktop');
async function replace(file,oldValue,newValue){const path=resolve(upstream,file);let value=(await readFile(path,'utf8')).replace(/\r\n/g,'\n');if(value.includes(newValue))return;if(!value.includes(oldValue))throw new Error('Upstream anchor changed: '+file);await writeFile(path,value.replace(oldValue,newValue));}
for(const [from,to] of [['hellodog.main.ts','app/hellodog.main.ts'],['hellodog.preload.ts','ts/hellodog/hellodog.preload.ts'],['hellodog.recovery.preload.ts','ts/hellodog/hellodog.recovery.preload.ts'],['hellodog.focus.preload.ts','ts/hellodog/hellodog.focus.preload.ts'],['fs-xattr.d.ts','ts/hellodog/fs-xattr.d.ts']]){const path=resolve(upstream,to);await mkdir(dirname(path),{recursive:true});await copyFile(resolve(root,'integrations/hellodog-source',from),path);}
await copyFile(resolve(root,'resources/brand/hellodog-icon.png'),resolve(upstream,'images/hellodog-icon.png'));
await replace('app/user_config.main.ts',"if (config.has('storagePath')) {", "if (process.env.HELLODOG_EMBEDDED === '1' && process.env.HELLODOG_SIGNAL_USER_DATA) {\n  userData = process.env.HELLODOG_SIGNAL_USER_DATA;\n} else if (config.has('storagePath')) {");
if (!(await readFile(resolve(upstream,'app/main.main.ts'),'utf8')).includes("import { attachHelloDog, helloDogEmbedded } from './hellodog.main.ts';")) await replace('app/main.main.ts',"import * as bounce from '../ts/services/bounce.main.ts';", "import { attachHelloDog, helloDogEmbedded } from './hellodog.main.ts';\nimport * as bounce from '../ts/services/bounce.main.ts';");
{const file=resolve(upstream,'app/main.main.ts');let seen=false;const value=(await readFile(file,'utf8')).replace(/^import \{ attachHelloDog, helloDogEmbedded \} from '.\/hellodog.main.ts';\r?\n/gm,line=>{if(seen)return '';seen=true;return line});await writeFile(file,value);}
await replace('app/main.main.ts','!app.getLoginItemSettings().wasOpenedAsHidden && !startInTray;', '!helloDogEmbedded && !app.getLoginItemSettings().wasOpenedAsHidden && !startInTray;');
if (!(await readFile(resolve(upstream,'app/main.main.ts'),'utf8')).includes('attachHelloDog(mainWindow);')) await replace('app/main.main.ts','mainWindow = new BrowserWindow(windowOptions);','if (helloDogEmbedded) Object.assign(windowOptions, {frame:false,minWidth:1,minHeight:1,autoHideMenuBar:true});\n  mainWindow = new BrowserWindow(windowOptions);\n  attachHelloDog(mainWindow);');
await replace('app/main.main.ts','{frame:false,minWidth:1,minHeight:1,autoHideMenuBar:true}','{frame:false,thickFrame:false,minWidth:1,minHeight:1,autoHideMenuBar:true}');
await replace('app/main.main.ts','async function readyForUpdates() {','async function readyForUpdates() {\n  if (helloDogEmbedded) return;');
await replace('app/main.main.ts','async function forceUpdate() {','async function forceUpdate() {\n  if (helloDogEmbedded) return;');
await replace('app/main.main.ts',"if (!app.isDefaultProtocolClient('sgnl')) {", "if (!helloDogEmbedded && !app.isDefaultProtocolClient('sgnl')) {");
await replace('app/main.main.ts',"if (!app.isDefaultProtocolClient('signalcaptcha')) {", "if (!helloDogEmbedded && !app.isDefaultProtocolClient('signalcaptcha')) {");
await replace('app/main.main.ts','app.setLoginItemSettings({','if (!helloDogEmbedded) app.setLoginItemSettings({');
await replace('app/main.main.ts', `  systemTrayService = new SystemTrayService({
    i18n: getResolvedMessagesLocale().i18n,
  });
  systemTrayService.setMainWindow(mainWindow);
  systemTrayService.setEnabled(
    shouldMinimizeToSystemTray(await systemTraySettingCache.get())
  );`, `  if (!helloDogEmbedded) {
    systemTrayService = new SystemTrayService({
      i18n: getResolvedMessagesLocale().i18n,
    });
    systemTrayService.setMainWindow(mainWindow);
    systemTrayService.setEnabled(
      shouldMinimizeToSystemTray(await systemTraySettingCache.get())
    );
  }`);
await replace('app/main.main.ts', 'const usingTrayIcon = shouldMinimizeToSystemTray(', 'const usingTrayIcon = !helloDogEmbedded && shouldMinimizeToSystemTray(');
await replace('app/startup_config.main.ts', 'export const AUMID = `org.whispersystems.${packageJson.name}`;', "export const AUMID = process.env.HELLODOG_EMBEDDED === '1' && typeof process.send === 'function' ? 'com.local.whatsappsignaltranslator' : `org.whispersystems.${packageJson.name}`;");
await replace('app/WindowsNotifications.main.ts', "import { AUMID } from './startup_config.main.ts';", "import { AUMID } from './startup_config.main.ts';\nimport { helloDogEmbedded, forwardHelloDogNotification } from './hellodog.main.ts';");
await replace('app/WindowsNotifications.main.ts', '(_event: IpcMainInvokeEvent, data: WindowsNotificationData) => {', '(_event: IpcMainInvokeEvent, data: WindowsNotificationData) => {\n      if (helloDogEmbedded) { forwardHelloDogNotification(_event.sender.id, {silent:true}); return; }');
await replace('app/WindowsNotifications.main.ts', "ipc.handle('windows-notifications:clear-all', () => {", "ipc.handle('windows-notifications:clear-all', () => {\n    if (helloDogEmbedded) return;");
// All three automatic/default login writers, including the preferences action.
{const file=resolve(upstream,'app/main.main.ts');let value=await readFile(file,'utf8');value=value.replace(/(?<!if \(!helloDogEmbedded\) )app\.setLoginItemSettings\(\{/g,'if (!helloDogEmbedded) app.setLoginItemSettings({');await writeFile(file,value);}
await replace('app/main.main.ts',"ipc.handle('set-auto-launch', async (_event, value) => {", "ipc.handle('set-auto-launch', async (_event, value) => {\n  if (helloDogEmbedded) throw new Error('开机启动请在 HelloDog 设置中管理。');");
if (!(await readFile(resolve(upstream,'ts/jobs/helpers/sendNormalMessage.preload.ts'),'utf8')).includes("import { translateHelloDogMessage }")) await replace('ts/jobs/helpers/sendNormalMessage.preload.ts',"import lodash from 'lodash';", "import { translateHelloDogMessage } from '../../hellodog/hellodog.preload.ts';\nimport lodash from 'lodash';");
{const file=resolve(upstream,'ts/jobs/helpers/sendNormalMessage.preload.ts');let seen=false;const value=(await readFile(file,'utf8')).replace(/^import \{ translateHelloDogMessage \} from '..\/..\/hellodog\/hellodog.preload.ts';\r?\n/gm,line=>{if(seen)return '';seen=true;return line});await writeFile(file,value);}
if (!(await readFile(resolve(upstream,'ts/jobs/helpers/sendNormalMessage.preload.ts'),'utf8')).includes('if (!await prepareHelloDogSend(')) await replace('ts/jobs/helpers/sendNormalMessage.preload.ts','    const {\n      attachments,\n      body,','    await translateHelloDogMessage(message, conversation, editedMessageTimestamp);\n    const {\n      attachments,\n      body,');
await replace('ts/jobs/helpers/sendNormalMessage.preload.ts',"import { translateHelloDogMessage } from '../../hellodog/hellodog.preload.ts';", "import { translateHelloDogMessage } from '../../hellodog/hellodog.preload.ts';\nimport { prepareHelloDogSend } from '../../hellodog/hellodog.recovery.preload.ts';");
await replace('ts/jobs/helpers/sendNormalMessage.preload.ts', '    await translateHelloDogMessage(message, conversation, editedMessageTimestamp);', `    if (!await prepareHelloDogSend(
      () => translateHelloDogMessage(message, conversation, editedMessageTimestamp),
      error => markMessageFailed({ message, errors: [error], targetTimestamp }),
      () => Boolean(message.get('isErased') || message.get('deletedForEveryone'))
    )) return;`);
await replace('ts/state/ducks/composer.preload.ts', 'const debouncedSaveDraft = debounce(saveDraft, 100);', `const debouncedSaveDraft = debounce(saveDraft, 100);
export async function flushHelloDogDrafts(): Promise<void> {
  debouncedSaveDraft.flush();
  await Promise.all(window.ConversationController.getAll()
    .filter(conversation => conversation.get('draftChanged'))
    .map(conversation => DataWriter.updateConversation(conversation.attributes)));
}`);
await replace('ts/windows/main/phase3-post-signal.preload.ts',"import '../../background.preload.ts';", "import '../../background.preload.ts';\nimport { startHelloDogMessages } from '../../hellodog/hellodog.preload.ts';\nstartHelloDogMessages();");
await replace('ts/components/conversation/Message.dom.tsx','data-testid={timestamp}','data-testid={timestamp}\n          data-hellodog-id={this.props.id}');
// Use the native send action for both mouse and keyboard. A just-typed message
// must not be rejected because React's dirty flag has not rendered yet.
await replace('ts/components/CompositionArea.dom.tsx', '      if (!canSend) {', '      if (isDisabled || draftAttachments.some(attachment => attachment.pending) || (editedMessageId ? !canSend : !message.trim() && draftAttachments.length === 0)) {');
await replace('ts/components/CompositionArea.dom.tsx', '      conversationId,\n      canSend,', '      conversationId,\n      isDisabled,\n      canSend,');
await replace('ts/components/CompositionArea.dom.tsx', '            {!dirty ? micButtonFragment : null}\n            {editMessageFragment}\n            {composerAddMenuButton}', '            {!dirty && draftAttachments.length === 0 ? micButtonFragment : null}\n            {editMessageFragment}\n            {composerAddMenuButton}\n            {dirty || draftAttachments.length > 0 ? sendButtonFragment : null}');
await replace('ts/components/CompositionArea.dom.tsx', "            label={i18n('icu:sendMessageToContact')}\n            onClick={handleForceSend}", "            label={i18n('icu:sendMessageToContact')}\n            disabled={isDisabled || !canSend}\n            onClick={handleForceSend}");
await replace('ts/components/CompositionInput.dom.tsx', '    if (emojiCompletion === undefined || mentionCompletion === undefined) {\n      return false;\n    }\n\n    if (emojiCompletion.results.length)', '    if (emojiCompletion?.results.length)');
await replace('ts/components/CompositionInput.dom.tsx', '    if (mentionCompletion.results.length)', '    if (mentionCompletion?.results.length)');
await replace('ts/components/CompositionInput.dom.tsx', '    const didSend = onSubmit(text, bodyRanges, timestamp);\n\n    if (!didSend) {\n      canSendRef.current = true;\n    }', '    let didSend = false;\n    try { didSend = Boolean(onSubmit(text, bodyRanges, timestamp)); }\n    finally { if (!didSend) canSendRef.current = true; }');

await copyFile(resolve(root,'integrations/hellodog-source/hellodog.quick-reply.dom.ts'),resolve(upstream,'ts/hellodog/hellodog.quick-reply.dom.ts'));
await replace('ts/components/CompositionInput.dom.tsx', "import { RecoveryKeyPasteWarning } from './RecoveryKeyPasteWarning.dom.tsx';", "import { RecoveryKeyPasteWarning } from './RecoveryKeyPasteWarning.dom.tsx';\nimport { installHelloDogQuickReply } from '../hellodog/hellodog.quick-reply.dom.ts';");
await replace('ts/components/CompositionInput.dom.tsx', '  useImperativeHandle(inputApi, () => {', `  useEffect(() => installHelloDogQuickReply(window, () => ({
    conversationId,
    editable: Boolean(isActive && !disabled && !draftEditMessage && !isViewOnceActive && quillRef.current?.isEnabled()),
    empty: quillRef.current?.getLength() === 1,
    insert: text => { setContents(text, [], true); focus(); },
  })), [conversationId, isActive, disabled, draftEditMessage, isViewOnceActive, setContents, focus]);

  useImperativeHandle(inputApi, () => {`);
for(const [from,to] of [['hellodog.privacy.main.ts','app/hellodog.privacy.main.ts'],['hellodog.privacy.preload.ts','ts/hellodog/hellodog.privacy.preload.ts']]) await copyFile(resolve(root,'integrations/hellodog-source',from),resolve(upstream,to));
await replace('app/main.main.ts', "import { attachHelloDog, helloDogEmbedded } from './hellodog.main.ts';", "import { attachHelloDog, helloDogEmbedded } from './hellodog.main.ts';\nimport { attachHelloDogPrivacy } from './hellodog.privacy.main.ts';");
await replace('app/main.main.ts', '  attachHelloDog(mainWindow);', '  attachHelloDog(mainWindow);\n  attachHelloDogPrivacy(mainWindow);');
await replace('ts/services/MessageCache.preload.ts', "import lodash from 'lodash';", "import lodash from 'lodash';\nimport { recordHelloDogContent } from '../hellodog/hellodog.privacy.preload.ts';");
await replace('ts/services/MessageCache.preload.ts', 'public saveMessage(', 'public async saveMessage(');
await replace('ts/services/MessageCache.preload.ts', '    return DataWriter.saveMessage(attributes, {', '    await recordHelloDogContent([attributes]);\n    return DataWriter.saveMessage(attributes, {');
await replace('ts/util/cleanup.preload.ts', "import { pick } from 'lodash';", "import { pick } from 'lodash';\nimport { recordHelloDogContent } from '../hellodog/hellodog.privacy.preload.ts';");
await replace('ts/util/cleanup.preload.ts', '  const originalAttributes = message.attributes;', '  await recordHelloDogContent([message.attributes], true);\n  const originalAttributes = message.attributes;');
await replace('ts/util/cleanup.preload.ts', '  // First, handle any calls that need to be deleted', '  await recordHelloDogContent(messages, true);\n  // First, handle any calls that need to be deleted');
{const file=resolve(upstream,'ts/sql/Client.preload.ts');let value=await readFile(file,'utf8');if(!value.includes("import { recordHelloDogContent }")) value="import { recordHelloDogContent } from '../hellodog/hellodog.privacy.preload.ts';\n"+value;await writeFile(file,value);}
await replace('ts/sql/Client.preload.ts', '  await writableChannel.removeMessages(messageIds);', '  await recordHelloDogContent(messages, true);\n  await writableChannel.removeMessages(messageIds);');
// Native notification preferences still decide when to alert. The host shows
// one private HelloDog notification, avoiding duplicate Signal taskbar entries.
{const file=resolve(upstream,'ts/services/notifications.preload.ts');const value=(await readFile(file,'utf8')).replace("    if (process.env.HELLODOG_EMBEDDED === '1' && process.env.HELLODOG_BRIDGE_ACTIVE === '1') { window.dispatchEvent(new Event('hellodog-notification')); return; }\n",'');await writeFile(file,value);}
await replace('ts/services/notifications.preload.ts', "    log.info('NotificationService: showing a notification', sentAt);", "    if (process.env.HELLODOG_EMBEDDED === '1' && process.env.HELLODOG_BRIDGE_ACTIVE === '1') { window.dispatchEvent(new CustomEvent('hellodog-notification', {detail:{silent}})); return; }\n    log.info('NotificationService: showing a notification', sentAt);");
await copyFile(resolve(root,'integrations/hellodog-source/hellodog.send-status.std.ts'),resolve(upstream,'ts/hellodog/hellodog.send-status.std.ts'));
for (const file of ['ts/state/ducks/conversations.preload.ts', 'ts/components/conversation/MessageMetadata.dom.tsx']) {
  const path = resolve(upstream,file);
  await writeFile(path,patchSignalSendStatus(file,await readFile(path,'utf8')));
}
console.log('Pinned Signal Desktop HelloDog patches applied');
