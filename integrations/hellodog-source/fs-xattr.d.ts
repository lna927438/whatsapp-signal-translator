// Windows builds omit the macOS-only optional dependency. This declaration
// matches the sole upstream call, which is guarded by platform === 'darwin'.
declare module 'fs-xattr' {
  export function setAttribute(path: string, name: string, value: string | Uint8Array): Promise<void>;
}
