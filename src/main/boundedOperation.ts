export function boundedOperation<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
