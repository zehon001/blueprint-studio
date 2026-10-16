import type { Middleware, PluginRecord } from './types'

const DB_NAME = 'blueprint-studio'
const VERSION = 2
const STORE_MIDDLEWARES = 'middlewares'
const STORE_PLUGINS = 'plugins'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_MIDDLEWARES)) {
        db.createObjectStore(STORE_MIDDLEWARES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_PLUGINS)) {
        db.createObjectStore(STORE_PLUGINS, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const req = run(tx.objectStore(storeName))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

export async function listMiddlewares(): Promise<Middleware[]> {
  const all = await withStore<Middleware[]>(STORE_MIDDLEWARES, 'readonly', (s) => s.getAll())
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export function putMiddleware(mw: Middleware) {
  return withStore(STORE_MIDDLEWARES, 'readwrite', (s) => s.put(mw)).then(
    () => undefined,
  ) as Promise<void>
}

export async function listPlugins(): Promise<PluginRecord[]> {
  const all = await withStore<PluginRecord[]>(STORE_PLUGINS, 'readonly', (s) => s.getAll())
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function putPlugin(plugin: PluginRecord) {
  return withStore(STORE_PLUGINS, 'readwrite', (s) => s.put(plugin)).then(() => undefined) as Promise<void>
}

export function deletePluginById(id: string) {
  return withStore(STORE_PLUGINS, 'readwrite', (s) => s.delete(id)).then(() => undefined) as Promise<void>
}

export function deleteMiddlewareById(id: string) {
  return withStore(STORE_MIDDLEWARES, 'readwrite', (s) => s.delete(id)).then(
    () => undefined,
  ) as Promise<void>
}
