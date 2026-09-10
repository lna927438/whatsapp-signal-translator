import { app } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'

export class JsonStore<T> {
  constructor(private readonly fileName: string, private readonly defaults: T, private readonly strictRead = false) {}

  private get filePath(): string {
    return join(app.getPath('userData'), this.fileName)
  }

  async read(): Promise<T> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8')
      return JSON.parse(text) as T
    } catch (error: any) {
      // A damaged send ledger must never look like an empty ledger: doing so
      // would permit a second platform submission with a new request ID.
      if (this.strictRead && error?.code !== 'ENOENT') throw new Error('无法读取已保存的发送任务，请保留应用数据并重试。')
      return structuredClone(this.defaults)
    }
  }

  async write(value: T): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
