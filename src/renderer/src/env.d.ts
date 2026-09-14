/// <reference types="vite/client" />

declare global {
  interface Window {
    desktopAPI: any
    realtimeTranslator?: any
    __HELLODOG_PREPARE_RESTART__?: () => Promise<boolean>
  }
}
export {}
