import test from 'node:test'
import assert from 'node:assert/strict'
import { createPilotStore } from '../src/design-pilot/persistence.ts'

type RecordV1 = { schema: 1; title: string }
const valid = (value: unknown): value is RecordV1 => Boolean(
  value && typeof value === 'object'
  && (value as RecordV1).schema === 1
  && typeof (value as RecordV1).title === 'string',
)
const record = (title: string): RecordV1 => ({ schema: 1, title })
const key = 'design-pilot-test'

class FakeStorage {
  disk = new Map<string, string>()
  failRead = false
  failWrite = false
  writes = 0
  getItem(key: string) {
    if (this.failRead) throw Error('read denied')
    return this.disk.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw Error('QuotaExceededError')
    this.writes += 1
    this.disk.set(key, value)
  }
}

test('malformed JSON is exportable and cannot be overwritten by defaults', async () => {
  const storage = new FakeStorage()
  storage.disk.set(key, '{broken-json')
  const store = createPilotStore(key, valid, storage)
  assert.equal(store.read().data, null)
  assert.match(store.read().error, /原始记录已保留/)
  assert.match(await store.write(record('default')), /不会覆盖/)
  assert.equal(store.raw(), '{broken-json')
  assert.equal(storage.disk.get(key), '{broken-json')
  assert.equal(storage.writes, 0)
})

test('valid JSON with a different schema is protected rather than migrated implicitly', async () => {
  const storage = new FakeStorage()
  const original = JSON.stringify({ schema: 2, title: 'future record', extra: true })
  storage.disk.set(key, original)
  const store = createPilotStore(key, valid, storage)
  assert.match(store.read().error, /版本不兼容/)
  assert.match(await store.write(record('older version')), /不会覆盖/)
  assert.equal(storage.disk.get(key), original)
  assert.equal(store.raw(), original)
  assert.equal(storage.writes, 0)
})

test('sequential saves from separate instances reject a stale draft until explicit reload', async () => {
  const storage = new FakeStorage()
  storage.disk.set(key, JSON.stringify(record('original')))
  const first = createPilotStore(key, valid, storage)
  const second = createPilotStore(key, valid, storage)
  assert.equal(await first.write(record('newer')), '')
  assert.deepEqual(second.read().data, record('original'))
  assert.match(await second.write(record('stale')), /另一个页面/)
  assert.deepEqual(JSON.parse(storage.disk.get(key)!), record('newer'))
  assert.deepEqual(second.reload(), { data: record('newer'), error: '' })
  assert.equal(await second.write(record('reconciled')), '')
  assert.deepEqual(second.read(), { data: record('reconciled'), error: '' })
  assert.deepEqual(createPilotStore(key, valid, storage).read().data, record('reconciled'))
})

test('failed writes preserve both the stored record and the original baseline for a later retry', async () => {
  const storage = new FakeStorage()
  const original = JSON.stringify(record('original'))
  storage.disk.set(key, original)
  const store = createPilotStore(key, valid, storage)
  storage.failWrite = true
  assert.match(await store.write(record('draft')), /保存失败/)
  assert.equal(store.raw(), original)
  assert.equal(storage.disk.get(key), original)
  assert.deepEqual(store.read().data, record('original'))
  storage.failWrite = false
  assert.equal(await store.write(record('draft')), '')
  assert.deepEqual(store.read().data, record('draft'))
})

test('a read failure pauses writes and retains the last captured raw record until reload succeeds', async () => {
  const storage = new FakeStorage()
  const original = JSON.stringify(record('original'))
  storage.disk.set(key, original)
  const store = createPilotStore(key, valid, storage)
  storage.failRead = true
  assert.match(store.reload().error, /无法读取/)
  assert.equal(store.raw(), original)
  assert.match(await store.write(record('draft')), /自动保存已暂停/)
  storage.failRead = false
  assert.deepEqual(store.reload(), { data: record('original'), error: '' })
  assert.equal(await store.write(record('draft')), '')
})

test('a read error during commit cannot report success or advance the baseline', async () => {
  const storage = new FakeStorage()
  const original = JSON.stringify(record('original'))
  storage.disk.set(key, original)
  const store = createPilotStore(key, valid, storage)
  storage.failRead = true
  assert.match(await store.write(record('draft')), /保存失败/)
  assert.equal(store.raw(), original)
  assert.equal(storage.disk.get(key), original)
  assert.equal(storage.writes, 0)
})

test('mutating a read result cannot modify the saved snapshot, and invalid writes are rejected', async () => {
  const storage = new FakeStorage()
  storage.disk.set(key, JSON.stringify(record('original')))
  const store = createPilotStore(key, valid, storage)
  const copy = store.read().data!
  copy.title = 'unsaved mutation'
  assert.deepEqual(store.read().data, record('original'))
  assert.match(await store.write({ schema: 2, title: 'wrong schema' } as unknown as RecordV1), /格式不正确/)
  assert.deepEqual(store.read().data, record('original'))
  assert.equal(storage.writes, 0)
})

test('Web Locks serializes the shared key and still detects a second instance conflict', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const lockNames: string[] = []
  let tail: Promise<unknown> = Promise.resolve()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: (name: string, action: () => string) => {
      lockNames.push(name)
      const result = tail.then(action)
      tail = result.catch(() => {})
      return result
    } } },
  })
  try {
    const storage = new FakeStorage()
    const first = createPilotStore(key, valid, storage)
    const second = createPilotStore(key, valid, storage)
    const results = await Promise.all([first.write(record('first')), second.write(record('second'))])
    assert.equal(results[0], '')
    assert.match(results[1], /另一个页面/)
    assert.deepEqual(lockNames, [`design-pilot:${key}`, `design-pilot:${key}`])
    assert.deepEqual(JSON.parse(storage.disk.get(key)!), record('first'))
    assert.equal(storage.writes, 1)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})

for (const externalChange of [true, false]) {
  test(`reload invalidates a queued save even when external data ${externalChange ? 'changed' : 'stayed the same'}`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { locks: { request: (_name: string, action: () => string) => gate.then(action) } },
    })
    try {
      const storage = new FakeStorage()
      storage.disk.set(key, JSON.stringify(record('original')))
      const store = createPilotStore(key, valid, storage)
      const pendingSave = store.write(record('old draft waiting for lock'))
      const current = record(externalChange ? 'saved by another page' : 'original')
      storage.disk.set(key, JSON.stringify(current))
      assert.deepEqual(store.reload(), { data: current, error: '' })
      release()
      assert.match(await pendingSave, /重新读取|已过期/)
      assert.deepEqual(store.read(), { data: current, error: '' })
      assert.deepEqual(JSON.parse(storage.disk.get(key)!), current)
      assert.equal(storage.writes, 0)
      assert.equal(await store.write(record('new draft after reload')), '')
    } finally {
      release()
      if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  })
}
