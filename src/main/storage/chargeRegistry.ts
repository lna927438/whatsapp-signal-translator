import { JsonStore } from './jsonStore'

interface ChargeRegistryShape { [fingerprint: string]: number }
let chargeWriteChain: Promise<void> = Promise.resolve()

/**
 * Prevents the same logical translation from decrementing the local character
 * balance twice. This is intentionally separate from the translation cache so
 * even a cache-format migration or a transient cache miss cannot double-charge.
 */
export class ChargeRegistry {
  private readonly store = new JsonStore<ChargeRegistryShape>('charged-translations.json', {})

  async runOnce(fingerprint: string, action: () => Promise<void>): Promise<boolean> {
    let executed = false
    let error: unknown
    chargeWriteChain = chargeWriteChain.then(async () => {
      try {
        const current = await this.store.read()
        if (current[fingerprint]) return
        await action()
        current[fingerprint] = Date.now()
        const keys = Object.keys(current)
        if (keys.length > 25000) {
          keys.sort((a, b) => (current[a] || 0) - (current[b] || 0))
          for (const key of keys.slice(0, keys.length - 20000)) delete current[key]
        }
        await this.store.write(current)
        executed = true
      } catch (e) {
        error = e
      }
    })
    await chargeWriteChain
    if (error) throw error
    return executed
  }
}
