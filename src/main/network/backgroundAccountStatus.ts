/** Cloud account state is refreshed independently of a chat send. Translation
 * requests still authenticate with the provider on every paid operation. */
export class BackgroundAccountStatus {
  private revision = 0
  private owner = ''
  private token = ''
  private denied = ''
  private checking?: Promise<void>
  constructor(private read: (token: string) => Promise<any>) {}
  setIdentity(owner = '', token = '') {
    if (owner === this.owner && token === this.token) return
    this.revision++; this.owner = owner; this.token = token; this.denied = ''; this.checking = undefined
    void this.refresh()
  }
  assertAvailable() { if (this.denied) throw new Error(this.denied) }
  refresh(): Promise<void> {
    if (!this.owner || !this.token) return Promise.resolve()
    if (this.checking) return this.checking
    const revision = this.revision, owner = this.owner, token = this.token
    const work = (async () => {
      try {
        const result = await this.read(token)
        if (revision !== this.revision) return
        this.denied = result?.user?.id !== owner || result?.profile?.status !== 'active' ? '账号状态不可用，请重新登录或联系管理员。' : ''
      } catch (error: any) {
        if (revision === this.revision && /登录已失效|账号已停用|没有访问权限/.test(error?.message || '')) this.denied = error.message
        // A temporary network outage never holds the editor or impersonates an account suspension.
      }
    })().finally(() => { if (revision === this.revision) this.checking = undefined })
    this.checking = work
    return work
  }
}
