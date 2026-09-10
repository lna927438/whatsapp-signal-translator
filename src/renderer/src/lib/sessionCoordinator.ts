export interface BridgedSession { user: { id: string; email?: string; user_metadata?: Record<string, unknown> }; access_token: string }
export interface WorkspaceSession { userId: string | null; revision: number }

/** Token rotation is an identity update, not a new workspace. */
export class SessionCoordinator {
  private sequence = 0
  private state: WorkspaceSession = { userId: null, revision: 0 }
  constructor(private readonly bridge: (session: BridgedSession | null) => Promise<unknown>,
    private readonly changed: (state: WorkspaceSession) => void) {}

  async apply(session: BridgedSession | null): Promise<void> {
    const sequence = ++this.sequence
    const userId = session?.user?.id && session.access_token ? session.user.id : null
    // Signed-out/changed-user UI must disappear immediately, before slow IPC.
    if (this.state.userId && this.state.userId !== userId) {
      this.state = { userId: null, revision: this.state.revision + 1 }
      this.changed({ ...this.state })
    }
    await this.bridge(userId ? session : null)
    if (sequence !== this.sequence) return
    const revision = this.state.revision + (this.state.userId !== userId ? 1 : 0)
    this.state = { userId, revision }
    this.changed({ ...this.state })
  }
}
