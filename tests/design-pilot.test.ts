import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceRun, cancelRun, createRun, recoverRun, retryRun, validateCandidates } from '../src/design-pilot/engine.ts'
import type { Candidate, Run } from '../src/design-pilot/engine.ts'

const at = '2026-10-26T09:00:00.000Z'
const later = '2026-10-26T09:01:00.000Z'
const binding = { requirementId: 'requirement-C05-frozen-1', designId: 'example-design-v1' }
const files = (count: number): Candidate[] => Array.from({ length: count }, (_, index) => ({ id: `f${index}`, name: `研究-${index}.pdf`, size: 100 }))
const run = (candidates = files(4)) => createRun(candidates, binding, at, 'run-1')
function ticks(input: Run, count: number): Run {
  let result = input
  for (let index = 0; index < count; index++) result = advanceRun(result, later)
  return result
}

test('C05 accepts five formats and case differences, but rejects unsupported formats and empty selections', () => {
  assert.deepEqual(validateCandidates(['a.DOC', 'b.docx', 'c.XLS', 'd.xlsx', 'e.PDF'].map((name, index) => ({ id: String(index), name, size: 1 })), []), { errors: [], conflicts: [] })
  assert.match(validateCandidates([{ id: 'a', name: 'image.png', size: 100 }], []).errors.join(), /仅支持/)
  assert.match(validateCandidates([], []).errors.join(), /至少一个/)
  assert.throws(() => run([]), /至少一个/)
})

test('C05 permits 20 files and rejects 21, without imposing a batch-byte limit', () => {
  assert.equal(validateCandidates(files(20).map(file => ({ ...file, size: 50 * 1024 * 1024 })), []).errors.length, 0)
  assert.match(validateCandidates(files(21), []).errors.join(), /最多 20/)
})

test('C05 accepts exactly 50 MiB, but rejects one extra byte, empty, negative, fractional, and nonfinite sizes', () => {
  assert.equal(validateCandidates([{ ...files(1)[0], size: 50 * 1024 * 1024 }], []).errors.length, 0)
  assert.match(validateCandidates([{ ...files(1)[0], size: 50 * 1024 * 1024 + 1 }], []).errors.join(), /不能超过/)
  for (const size of [0, -1, NaN, Infinity, 1.5]) {
    assert.ok(validateCandidates([{ ...files(1)[0], size }], []).errors.length > 0)
  }
})

test('batch duplicates use Unicode NFC and case normalization even if sizes differ', () => {
  const duplicate = [{ id: 'a', name: 'Café.PDF', size: 1 }, { id: 'b', name: 'Cafe\u0301.pdf', size: 2 }]
  assert.match(validateCandidates(duplicate, []).errors.join(), /批内存在同名/)
  assert.throws(() => run(duplicate), /批内存在同名/)
})

test('existing-name conflicts identify candidates separately, without silently renaming or accepting them', () => {
  const candidates = [{ id: 'a', name: 'REPORT.PDF', size: 4 }, { id: 'b', name: 'unique.doc', size: 2 }]
  assert.deepEqual(validateCandidates(candidates, ['report.pdf']), { errors: [], conflicts: ['a'] })
  assert.equal(candidates[0].name, 'REPORT.PDF')
})

test('missing or duplicate row identifiers and missing snapshot bindings cannot create a run', () => {
  assert.throws(() => run([{ ...files(1)[0], id: '' }]), /标识/)
  assert.throws(() => run([{ id: 'same', name: 'one.pdf', size: 1 }, { id: 'same', name: 'two.pdf', size: 1 }]), /标识/)
  assert.throws(() => createRun(files(1), { ...binding, designId: '' }, at, 'run-1'), /冻结快照/)
})

test('each tick advances only the current file, with at most one processing row', () => {
  const initial = run()
  const first = advanceRun(initial, later)
  assert.deepEqual(first.rows.map(row => row.progress), [25, 0, 0, 0])
  assert.deepEqual(ticks(initial, 4).rows.map(row => row.status), ['success', 'pending', 'pending', 'pending'])
  const fifth = ticks(initial, 5)
  assert.deepEqual(fifth.rows.map(row => row.progress), [100, 25, 0, 0])
  assert.equal(fifth.rows.filter(row => row.status === 'processing').length, 1)
  assert.deepEqual(initial.rows.map(row => row.progress), [0, 0, 0, 0])
})

test('failure in the third file stops the fourth and retains the two successes', () => {
  const candidates = files(4)
  candidates[2].fault = 'parse'
  const failed = ticks(run(candidates), 12)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.rows.map(row => row.status), ['success', 'success', 'failed', 'pending'])
  assert.equal(failed.rows[3].progress, 0)
  assert.match(failed.rows[3].message, /未开始/)
  assert.equal(failed.events.filter(event => event.type === 'file-started').length, 3)
  assert.deepEqual(ticks(failed, 100), failed)
})

test('each injected failure gives a specific cause without claiming a real upload or repair', () => {
  for (const [fault, expected] of [['encrypted', /加密/], ['corrupt', /损坏/], ['parse', /解析失败/], ['capacity', /空间不足/]] as const) {
    const failed = ticks(run([{ ...files(1)[0], fault }]), 4)
    assert.equal(failed.status, 'failed')
    assert.match(failed.rows[0].message, expected)
    assert.match(failed.rows[0].message, /演练故障/)
  }
})

test('cancelling a partial queue preserves successes and separates cancelled from unstarted rows', () => {
  const cancelled = cancelRun(ticks(run(files(3)), 5), later)
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(cancelled.rows.map(row => row.status), ['success', 'cancelled', 'pending'])
  assert.deepEqual(cancelled.rows.map(row => row.progress), [100, 25, 0])
  assert.deepEqual(ticks(cancelled, 20), cancelled)
  const beforeProcessing = cancelRun(run(), later)
  assert.equal(beforeProcessing.rows.filter(row => row.status === 'success').length, 0)
})

test('explicit rehearsal retry repairs only unfinished rows and never reprocesses successes', () => {
  const candidates = files(4)
  candidates[2].fault = 'encrypted'
  const failed = ticks(run(candidates), 12)
  const retry = retryRun(failed, later)
  assert.deepEqual(retry.rows.map(row => row.status), ['success', 'success', 'pending', 'pending'])
  assert.equal(retry.rows[2].fault, undefined)
  assert.equal(failed.rows[2].fault, 'encrypted')
  const completed = ticks(retry, 8)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.events.filter(event => event.type === 'file-succeeded').length, 4)
  assert.equal(completed.events.filter(event => event.type === 'file-started' && event.message.includes('研究-0.pdf')).length, 1)
  assert.match(retry.events.at(-1)!.message, /模拟解除故障/)
  assert.throws(() => retryRun(completed, later), /仅可重试/)
  assert.throws(() => retryRun(run(), later), /仅可重试/)
})

test('reopening running state yields interrupted state and requires explicit retry', () => {
  const running = ticks(run(files(3)), 5)
  const recovered = recoverRun(JSON.parse(JSON.stringify(running)), later)
  assert.equal(recovered.status, 'interrupted')
  assert.deepEqual(recovered.rows.map(row => row.status), ['success', 'cancelled', 'pending'])
  assert.deepEqual(ticks(recovered, 20), recovered)
  assert.deepEqual(recoverRun(recovered, later), recovered)
  assert.equal(ticks(retryRun(recovered, later), 8).status, 'completed')
  assert.equal(running.status, 'running')
})

test('all transitions preserve frozen requirement/design binding and original creation time', () => {
  const initial = run()
  for (const state of [advanceRun(initial, later), cancelRun(initial, later), recoverRun(initial, later), retryRun(cancelRun(initial, later), later), ticks(initial, 16)]) {
    assert.equal(state.requirementId, binding.requirementId)
    assert.equal(state.designId, binding.designId)
    assert.equal(state.id, 'run-1')
    assert.equal(state.createdAt, at)
    assert.equal(state.updatedAt, later)
  }
})

test('state transitions never mutate frozen inputs or nested rows/events', () => {
  const input = run()
  input.rows.forEach(Object.freeze)
  input.events.forEach(Object.freeze)
  Object.freeze(input.rows)
  Object.freeze(input.events)
  Object.freeze(input)
  assert.doesNotThrow(() => advanceRun(input, later))
  assert.doesNotThrow(() => cancelRun(input, later))
  assert.doesNotThrow(() => recoverRun(input, later))
  const stopped = cancelRun(input, later)
  stopped.rows.forEach(Object.freeze)
  Object.freeze(stopped.rows)
  Object.freeze(stopped.events)
  Object.freeze(stopped)
  assert.doesNotThrow(() => retryRun(stopped, later))
})
