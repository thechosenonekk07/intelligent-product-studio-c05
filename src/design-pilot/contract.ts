import type { Product } from '../model.ts'
import { sourceC05 as exampleSource } from '../example.ts'
import type { Candidate, Run } from './engine.ts'

export const RULE_VERSION = 'c05-local-pilot/1'
export const sourceC05 = exampleSource
export const rules = [
  { id: 'R01', text: '支持 doc、docx、xls、xlsx、pdf；每批 1–20 个。', origin: '自编示例规则' },
  { id: 'R02', text: '单文件非空且 ≤ 50 MiB；不另设批次总量上限。', origin: '自编示例规则' },
  { id: 'R03', text: '格式、数量、大小、批内重名全部通过后，才能处理已有冲突。', origin: '自编示例规则' },
  { id: 'R04', text: '逐项显示进度；一项失败即停止后续，保留已成功项。', origin: '自编示例规则' },
  { id: 'R05', text: '区分加密、损坏、解析失败、空间不足；取消或关闭说明未完成状态。', origin: '自编示例规则' },
  { id: 'D01', text: '重名按完整文件名忽略大小写、统一 Unicode；已有冲突可移除或改名，不覆盖。', origin: '本演示补充 · 非正式业务要求' },
  { id: 'D02', text: '故障可模拟修复后重试未完成项；重新打开时将处理中标记为中断。', origin: '本演示补充 · 非正式业务要求' },
]

export function requirementContent(product: Product) {
  const block = product.blocks.find(item => item.id === 'C05')
  const feature = product.features.find(item => item.sourceId === 'C05')
  return {
    productId: product.id, productName: product.name, sourceName: product.sourceName,
    source: sourceC05,
    workspaceEvidence: block ? { ...block, locator: block.sourceLocator || block.locator } : null,
    feature: feature ?? null,
    rulesVersion: RULE_VERSION, rules,
  }
}
export type RequirementSnapshot = ReturnType<typeof requirementContent> & { id: string; contentHash: string; frozenAt: string }
export async function freezeRequirement(product: Product, at: string): Promise<RequirementSnapshot> {
  const content = structuredClone(requirementContent(product))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)))
  const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return { ...content, id: `C05-${contentHash.slice(0, 16)}`, contentHash, frozenAt: at }
}
export function isCurrent(snapshot: RequirementSnapshot | undefined, product: Product) {
  if (!snapshot) return false
  const { id: _id, contentHash: _hash, frozenAt: _at, ...content } = snapshot
  return JSON.stringify(content) === JSON.stringify(requirementContent(product))
}
export type PilotData = {
  schema: 'c05-pilot-data/1'
  activeRequirementId: string | null
  activeDesignId: string | null
  requirements: RequirementSnapshot[]
  designs: { id: string; [key: string]: unknown }[]
  draft: Candidate[]
  runs: Run[]
}
export const emptyData = (): PilotData => ({ schema: 'c05-pilot-data/1', activeRequirementId: null, activeDesignId: null, requirements: [], designs: [], draft: [], runs: [] })
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const candidate = (v: unknown): v is Candidate => record(v) && typeof v.id === 'string' && !!v.id && typeof v.name === 'string' && typeof v.size === 'number' && Number.isSafeInteger(v.size) && v.size >= 0 && (v.fault === undefined || ['encrypted','corrupt','parse','capacity'].includes(String(v.fault)))
const queueRow = (v: unknown) => record(v) && ['pending','processing','success','failed','cancelled'].includes(String(v.status)) && typeof v.progress === 'number' && Number.isFinite(v.progress) && v.progress >= 0 && v.progress <= 100 && typeof v.message === 'string' && candidate(v)
const unique = (items: unknown[]) => items.every(item => record(item) && typeof item.id === 'string') && new Set(items.map(item => (item as {id:string}).id)).size === items.length
export function validPilotData(value: unknown): value is PilotData {
  if (!record(value) || value.schema !== 'c05-pilot-data/1' || !(value.activeRequirementId === null || typeof value.activeRequirementId === 'string') || !(value.activeDesignId === null || typeof value.activeDesignId === 'string')) return false
  if (!Array.isArray(value.draft) || !value.draft.every(candidate) || !Array.isArray(value.requirements) || !Array.isArray(value.designs) || !Array.isArray(value.runs)) return false
  if (!value.requirements.every(s => record(s) && typeof s.id === 'string' && !!s.id && typeof s.contentHash === 'string' && /^[a-f0-9]{64}$/.test(s.contentHash) && typeof s.frozenAt === 'string' && record(s.source) && typeof s.source.text === 'string' && Array.isArray(s.rules) && typeof s.productId === 'string' && typeof s.rulesVersion === 'string' && (s.feature === null || record(s.feature)))) return false
  if (!value.designs.every(d => record(d) && typeof d.id === 'string' && !!d.id && d.schema === 'design-pilot/design-snapshot/v1' && record(d.tokens) && record(d.cssVariables) && Array.isArray(d.sourceFiles) && Array.isArray(d.approvedComponents))) return false
  if (![value.requirements,value.designs,value.runs,value.draft].every(items => unique(items as {id:string}[]))) return false
  if ((value.activeRequirementId === null) !== (value.activeDesignId === null)) return false
  if (value.activeRequirementId !== null && (!value.requirements.some(s => s.id === value.activeRequirementId) || !value.designs.some(d => d.id === value.activeDesignId))) return false
  return value.runs.every(r => record(r) && typeof r.id === 'string' && !!r.id && typeof r.requirementId === 'string' && typeof r.designId === 'string'
    && (value.requirements as {id:string}[]).some(s => s.id === r.requirementId) && (value.designs as {id:string}[]).some(d => d.id === r.designId)
    && ['running','completed','failed','cancelled','interrupted'].includes(String(r.status)) && typeof r.createdAt === 'string' && typeof r.updatedAt === 'string'
    && Array.isArray(r.rows) && r.rows.length > 0 && r.rows.every(queueRow) && unique(r.rows as {id:string}[])
    && Array.isArray(r.events) && r.events.every(e => record(e) && typeof e.at === 'string' && typeof e.type === 'string' && typeof e.message === 'string'))
}
export const composition = {
  id: 'c05-upload-composition/1', ruleVersion: RULE_VERSION,
  slots: ['source-confirmation', 'design-binding', 'file-selection', 'validation', 'conflict-resolution', 'queue-progress', 'run-evidence'],
  actions: ['freeze', 'select-metadata', 'validate', 'rename-or-remove', 'simulate-sequential-upload', 'stop', 'simulate-repair-and-retry', 'export'],
  renderer: 'local-react-native-adapter', generator: 'explicit-rules-no-model',
  persistence: 'isolated-browser-localStorage', fileContentRead: false, remoteUpload: false,
}
