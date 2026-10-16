const base = require('../package.json').build
module.exports = {
  ...base,
  directories: { output: 'release/macos-arm64' },
  publish: null,
  extraResources: [
    { from: 'integrations/signal-desktop/release/hellodog-macos-arm64/mac-arm64/Signal.app', to: 'signal-desktop/Signal.app' },
    { from: 'integrations/notices', to: 'signal-source-notices', filter: ['**/*'] },
    { from: 'resources/voice/bin-macos-arm64', to: 'voice', filter: ['**/*'] },
    { from: 'resources/voice', to: 'voice-notices', filter: ['LICENSE-*.txt'] }
  ],
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    artifactName: 'HelloDog-${version}-mac-arm64-preview.${ext}',
    category: 'public.app-category.social-networking',
    minimumSystemVersion: '14.0',
    icon: 'resources/brand/hellodog-icon.png',
    identity: '-',
    hardenedRuntime: true,
    notarize: false,
    entitlements: 'resources/macos/entitlements.plist',
    entitlementsInherit: 'resources/macos/entitlements.plist',
    // Voice hashes are taken after ad-hoc signing. The companion app has already
    // been signed as a complete bundle; do not rewrite either resource here.
    signIgnore: ['Contents/Resources/voice/', 'Contents/Resources/signal-desktop/'],
    extendInfo: {
      NSMicrophoneUsageDescription: 'HelloDog uses the microphone when you record a voice message.',
      NSCameraUsageDescription: 'HelloDog uses the camera when you choose a supported video feature.'
    }
  },
  dmg: { sign: false }
}
