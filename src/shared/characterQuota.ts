export const LOW_CHARACTER_THRESHOLD = 50000
export function lowCharacterBalance(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < LOW_CHARACTER_THRESHOLD
}
