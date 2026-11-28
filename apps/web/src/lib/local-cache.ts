/**
 * Kho IndexedDB nhỏ cho cache dữ liệu trên máy (vòng 3 tốc độ) + dọn sạch khi đăng xuất.
 *
 * KHÔNG lưu token/mật khẩu ở đây (token ở localStorage như cũ); chỉ lưu kết quả query đã dehydrate, khoá theo
 * người dùng + công ty (xem `query-persist.ts`). Mọi hàm nuốt lỗi: IndexedDB bị chặn (chế độ riêng tư) ⇒ coi như không có cache.
 */

export const IDB_NAME = 'trinity-cache'
const STORE = 'kv'

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await open()
  if (!db) return undefined
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      r.onsuccess = () => {
        db.close()
        resolve(r.result as T | undefined)
      }
      r.onerror = () => {
        db.close()
        resolve(undefined)
      }
    } catch {
      db.close()
      resolve(undefined)
    }
  })
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await open()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = tx.onabort = () => {
        db.close()
        resolve()
      }
    } catch {
      db.close()
      resolve()
    }
  })
}

export async function idbDelete(key: string): Promise<void> {
  const db = await open()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = tx.onabort = () => {
        db.close()
        resolve()
      }
    } catch {
      db.close()
      resolve()
    }
  })
}

const WIPE_CHANNEL = 'trinity-wipe'
const WIPE_STORAGE_KEY = 'trinity-wipe-at'
const wipeListeners = new Set<() => void>()
let channel: BroadcastChannel | null = null
let wired = false

function emitLocal(): void {
  for (const fn of [...wipeListeners]) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

function wire(): void {
  if (wired || typeof window === 'undefined') return
  wired = true
  try {
    channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(WIPE_CHANNEL) : null
    if (channel) channel.onmessage = () => emitLocal()
  } catch {
    channel = null
  }
  // Dự phòng khi không có BroadcastChannel: sự kiện `storage` chỉ bắn ở tab KHÁC.
  window.addEventListener('storage', (e) => {
    if (e.key === WIPE_STORAGE_KEY) emitLocal()
  })
}

/**
 * Đăng ký nhận tín hiệu xoá cache (từ tab này hoặc tab khác). Nhận được thì dừng ghi + xoá cache trong bộ nhớ.
 * Trả hàm huỷ đăng ký.
 */
export function onWipe(fn: () => void): () => void {
  wire()
  wipeListeners.add(fn)
  return () => {
    wipeListeners.delete(fn)
  }
}

/**
 * Xoá mọi cache trên máy: toàn bộ IndexedDB `trinity-cache` + bộ nhớ HTML của Service Worker, và báo mọi tab khác
 * (BroadcastChannel + `storage`) để chúng dừng ghi và xoá cache trong bộ nhớ. Gọi từ `clearTokens()`
 * (đăng xuất, hết phiên, đổi tài khoản). Không chặn, không ném lỗi.
 */
export function wipeLocalCaches(): void {
  if (typeof window === 'undefined') return
  wire()
  emitLocal()
  try {
    channel?.postMessage('wipe')
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.setItem(WIPE_STORAGE_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
  try {
    indexedDB?.deleteDatabase(IDB_NAME)
  } catch {
    /* ignore */
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'clear-pages' })
  } catch {
    /* ignore */
  }
}
