/** Match the advertised browser platform to Chromium's real desktop platform. */
export function desktopBrowserIdentity(platform = process.platform as string, chromeVersion = process.versions.chrome || '140.0.0.0') {
  const os = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'
  return {
    userAgent: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    // Chromium uses a reduced Intel Mac OS X user agent on Apple Silicon too.
    clientHintPlatform: platform === 'darwin' ? '"macOS"' : platform === 'win32' ? '"Windows"' : '"Linux"'
  }
}
