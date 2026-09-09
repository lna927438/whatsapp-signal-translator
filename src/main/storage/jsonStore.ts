import { app } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'

export class JsonStore<T> {
  constructor(private readonly fileName: string, private readonly defaults: T) {}

  private get filePath(): string {
    return join(app.getPath('userData'), this.fileName)
  }

  async read(): Promise<T> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8')
      return JSON.parse(text) as T
    } catch {
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
