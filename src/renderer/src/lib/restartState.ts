const preparations = new Set<() => Promise<unknown>>()
window.__HELLODOG_PREPARE_RESTART__ = async () => {
  for (const prepare of preparations) await prepare()
  return true
}
export function prepareBeforeRestart(prepare: () => Promise<unknown>) {
  preparations.add(prepare)
  return () => { preparations.delete(prepare) }
}
