export type PilotStore<T> = {
  read(): { data: T | null; error: string }
  write(data: T): Promise<string>
  reload(): { data: T | null; error: string }
  raw(): string | null
}

type PilotStorage = Pick<Storage, 'getItem' | 'setItem'>

/** A separate JSON record with an explicit reload boundary for stale drafts. */
export function createPilotStore<T>(
  key: string,
  validate: (value: unknown) => value is T,
  storage?: PilotStorage,
): PilotStore<T> {
  let expectedRaw: string | null = null
  let loadError = ''
  let reloadEpoch = 0
  const getStorage = () => storage ?? globalThis.localStorage

  // read() never silently adopts another tab's changes or advances the baseline.
  // Parsing a fresh copy also keeps callers from mutating the saved snapshot.
  const read = (): { data: T | null; error: string } => ({
    data: loadError || expectedRaw === null ? null : JSON.parse(expectedRaw) as T,
    error: loadError,
  })

  const reload = () => {
    // Every reload invalidates already submitted drafts, even if it fails or
    // reads identical bytes. A pending lock must not adopt a newer baseline.
    reloadEpoch += 1
    let current: string | null
    try {
      current = getStorage().getItem(key)
    } catch {
      loadError = '无法读取试点记录，自动保存已暂停；此前读取的原始记录已保留，请检查浏览器存储后重新读取。'
      return read()
    }

    // Even an unreadable document remains available for raw export.
    expectedRaw = current
    loadError = ''
    if (current !== null) {
      try {
        const value: unknown = JSON.parse(current)
        if (!validate(value)) loadError = '试点记录格式或版本不兼容，原始记录已保留且不会覆盖，请先导出并核对。'
      } catch {
        loadError = '试点记录无法解析或校验，原始记录已保留且不会覆盖，请先导出并核对。'
      }
    }
    return read()
  }

  const write = async (data: T): Promise<string> => {
    if (loadError) return loadError
    const submittedRaw = expectedRaw
    const submittedEpoch = reloadEpoch
    let next: string
    try {
      if (!validate(data)) return '待保存的试点记录格式不正确，本次未写入，当前输入请保留。'
      const serialized = JSON.stringify(data)
      if (typeof serialized !== 'string' || !validate(JSON.parse(serialized))) {
        return '试点记录无法完整保存，本次未写入，当前输入请保留。'
      }
      next = serialized
    } catch {
      return '试点记录无法序列化或校验，本次未写入，当前输入请保留。'
    }

    // No await belongs inside this read/compare/write section. Without Web
    // Locks it still detects stale sequential saves; it is not a cross-tab lock.
    const commit = (): string => {
      if (submittedEpoch !== reloadEpoch) {
        return '等待保存期间已重新读取试点记录，这次提交已过期且未写入。请核对当前记录后重新提交。'
      }
      if (loadError) return loadError
      try {
        const target = getStorage()
        if (target.getItem(key) !== submittedRaw) {
          return '另一个页面已更新试点记录，本次未保存。请保留当前草稿，重新读取后核对。'
        }
        if (next !== submittedRaw) target.setItem(key, next)
        expectedRaw = next
        return ''
      } catch {
        return '试点记录保存失败，可能是存储空间不足或浏览器限制。本次未确认保存，此前读取的原始记录已保留。'
      }
    }

    try {
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return await navigator.locks.request(`design-pilot:${key}`, commit)
      }
      return commit()
    } catch {
      return '无法取得试点保存锁，本次未保存，当前输入请保留后重试。'
    }
  }

  reload()
  return { read, write, reload, raw: () => expectedRaw }
}
