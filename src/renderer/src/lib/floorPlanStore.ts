export interface FloorPlanRecord {
  name: string
  dataUrl: string
  width: number
  height: number
  importedAt: number
}
/**
 * 平面图底图的本地存储（业主 2026-11-12）。
 *
 * 为什么用 IndexedDB 而不是设置表 / localStorage：
 *   - 平面图是一张图片，几 MB 很常见，localStorage 的 5 MB 配额不够；
 *   - 渲染层没有文件系统权限，主进程复制图片再回传路径会多一条 IPC 与目录治理；
 *   - IndexedDB 能存 Blob/字符串，且在同一用户数据目录下持久化。
 *
 * 记录只保存一张「当前平面图」。设备在平面图上的位置不在这里：它跟着设备记录走
 * （installation.floorX/floorY），所以换一张平面图时设备仍按比例落在新图上。
 */
const DB_NAME = 'hais-floor-plan'
const DB_VERSION = 1
const STORE_NAME = 'floor-plans'
const KEY = 'active'

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

export async function loadFloorPlan(): Promise<FloorPlanRecord | null> {
  const db = await openDatabase()
  if (!db) return null
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(KEY)
    request.onsuccess = () => {
      const value = request.result as FloorPlanRecord | undefined
      db.close()
      resolve(value && typeof value.dataUrl === 'string' ? value : null)
    }
    request.onerror = () => {
      db.close()
      resolve(null)
    }
  })
}

export async function saveFloorPlan(record: FloorPlanRecord): Promise<boolean> {
  const db = await openDatabase()
  if (!db) return false
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(record, KEY)
    transaction.oncomplete = () => {
      db.close()
      resolve(true)
    }
    transaction.onerror = () => {
      db.close()
      resolve(false)
    }
  })
}

export async function clearFloorPlan(): Promise<void> {
  const db = await openDatabase()
  if (!db) return
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(KEY)
    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      resolve()
    }
  })
}
