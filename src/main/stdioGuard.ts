// GUI launches may inherit pipes owned by a short-lived installer or launcher.
// Losing that optional console must not crash the running desktop application.
// Keep this module independent of Electron so it can run before other imports.
const guardedStreams = new WeakSet<NodeJS.WritableStream>()
const closedPipeCodes = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])

function isClosedPipeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null &&
    'code' in error && typeof error.code === 'string' && closedPipeCodes.has(error.code)
}

export function installStdioGuard(streams: readonly NodeJS.WritableStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    if (guardedStreams.has(stream)) continue
    guardedStreams.add(stream)
    const write = stream.write
    let closedError: NodeJS.ErrnoException | undefined

    const onError = (error: unknown): void => {
      if (isClosedPipeError(error)) {
        closedError = error
        return
      }
      // Adding a listener must not silently consume unrelated stream failures.
      // Let any existing listener handle them; otherwise retain Node's default
      // uncaught-error behavior without installing a global exception handler.
      if (stream.listenerCount('error') === 1) throw error
    }
    // Run before existing once-listeners remove themselves during dispatch.
    stream.prependListener('error', onError)

    stream.write = function (this: NodeJS.WritableStream, ...args: Parameters<NodeJS.WritableStream['write']>): boolean {
      if (!closedError) {
        try {
          return Reflect.apply(write, this, args)
        } catch (error) {
          if (!isClosedPipeError(error)) throw error
          closedError = error
        }
      }
      // Once disconnected, stop touching the dead pipe. Explicit write callers
      // still receive the error; console writes have no backpressure to await.
      const callback = args[args.length - 1]
      if (typeof callback === 'function') process.nextTick(callback, closedError)
      return true
    } as NodeJS.WritableStream['write']
  }
}

installStdioGuard()
