export type ViewBounds = { x: number; y: number; width: number; height: number }
export function clampViewBounds(value: ViewBounds, width: number, height: number, zoom = 1): ViewBounds | null {
  if (![value?.x, value?.y, value?.width, value?.height, width, height, zoom].every(Number.isFinite) || zoom <= 0) return null
  value = { x: value.x * zoom, y: value.y * zoom, width: value.width * zoom, height: value.height * zoom }
  const x = Math.max(0, Math.min(width, Math.round(value.x)))
  const y = Math.max(0, Math.min(height, Math.round(value.y)))
  return { x, y, width: Math.max(0, Math.min(width - x, Math.round(value.width))), height: Math.max(0, Math.min(height - y, Math.round(value.height))) }
}
