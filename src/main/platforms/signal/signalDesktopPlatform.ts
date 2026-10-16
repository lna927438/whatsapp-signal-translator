import { join } from 'path'

/** Signal remains an isolated process on both systems. macOS does not use HWND embedding. */
export function signalDesktopLayout(platform: string, root: string, electronRoot: string, nativeRoot: string, packagedExists: (file: string) => boolean) {
  const presentation = platform === 'darwin' ? 'companion' : 'embedded'
  const packaged = platform === 'darwin' ? join(root, 'Signal.app', 'Contents', 'MacOS', 'Signal') : join(root, 'Signal.exe')
  const bundled = packagedExists(packaged)
  return {
    presentation,
    supported: platform === 'win32' || platform === 'darwin',
    executable: bundled ? packaged : platform === 'darwin' ? join(electronRoot, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron') : join(electronRoot, 'dist', 'electron.exe'),
    args: bundled ? [] : [root],
    helper: platform === 'darwin' ? undefined : join(nativeRoot, 'SignalWindowHost.exe'),
    root
  } as const
}

export function signalCompanionVisible(input: { selected: boolean; overlay: boolean; hostVisible: boolean; hostMinimized: boolean; dismissed: boolean; ready: boolean; authorized: boolean }): boolean {
  return input.selected && !input.overlay && input.hostVisible && !input.hostMinimized && !input.dismissed && input.ready && input.authorized
}
