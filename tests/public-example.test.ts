import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { exampleProduct, sourceC05 } from '../src/example.ts'
import { emptyData, freezeRequirement, isCurrent, validPilotData } from '../src/design-pilot/contract.ts'
import { createRun } from '../src/design-pilot/engine.ts'

const design = JSON.parse(readFileSync(new URL('../src/design-pilot/design-snapshot.json', import.meta.url), 'utf8'))

test('public scenario binds self-authored requirement and synthetic design, without importing host data', async () => {
  const snapshot = await freezeRequirement(exampleProduct, '2026-11-08T00:00:00Z')
  assert.equal(snapshot.source.basis, '为公开演示专门编写的虚构场景')
  assert.equal(snapshot.source.text, sourceC05.text)
  assert.equal(isCurrent(snapshot, exampleProduct), true)
  assert.equal(design.sourceReadMode, 'self-authored-synthetic-example')
  assert.deepEqual(design.approvedComponents, [])
  const run = createRun([{ id: 'one', name: 'example.pdf', size: 10 }], { requirementId: snapshot.id, designId: design.id }, snapshot.frozenAt, 'public-run')
  const data = { ...emptyData(), activeRequirementId: snapshot.id, activeDesignId: design.id, requirements: [snapshot], designs: [design], runs: [run] }
  assert.equal(validPilotData(data), true)
  assert.equal(validPilotData({ ...data, designs: [] }), false)
  assert.equal(validPilotData({ ...data, requirements: [] }), false)
})

test('changed example rules invalidate the requirement snapshot rather than silently approving a new definition', async () => {
  const product = structuredClone(exampleProduct)
  const snapshot = await freezeRequirement(product, '2026-11-08T00:00:00Z')
  product.features[0].success = 'Different example outcome'
  assert.equal(isCurrent(snapshot, product), false)
  assert.notEqual(snapshot.feature?.success, product.features[0].success)
})
