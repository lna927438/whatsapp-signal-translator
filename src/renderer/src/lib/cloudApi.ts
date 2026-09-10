export const cloudApi = {
  me: () => window.desktopAPI.readCloud('/api/me'),
  wallet: () => window.desktopAPI.readCloud('/api/wallet'),
  usage: () => window.desktopAPI.readCloud('/api/usage')
}
