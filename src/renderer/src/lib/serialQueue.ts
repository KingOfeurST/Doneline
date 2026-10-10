/** Writes for the same note stay ordered even when its editor is remounted. */
export class KeyedSerialQueue {
  private queues = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task)
    this.queues.set(key, result)
    const clear = () => {
      if (this.queues.get(key) === result) this.queues.delete(key)
    }
    result.then(clear, clear)
    return result
  }

  wait(key: string): Promise<unknown> {
    return (this.queues.get(key) ?? Promise.resolve()).catch(() => {})
  }
}
