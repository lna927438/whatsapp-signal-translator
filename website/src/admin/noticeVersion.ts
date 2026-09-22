import {validNoticeVersion} from '../../../src/shared/clientNotices'

/** An old notification can be retired without assigning it to a new release. */
export function noticeVersionForSave(value:unknown,active:unknown):string|undefined {
  if(typeof active!=='boolean'||typeof value!=='string')throw new Error('invalid_notice_version')
  if(value===''&&!active)return undefined
  if(!validNoticeVersion(value))throw new Error('invalid_notice_version')
  return value
}
