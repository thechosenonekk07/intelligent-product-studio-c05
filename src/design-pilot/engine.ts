/** Metadata-only local C05 rehearsal. This module never reads or uploads file bytes. */
export type Candidate = {
  id: string
  name: string
  size: number
  fault?: 'encrypted' | 'corrupt' | 'parse' | 'capacity'
}

export type QueueRow = Candidate & {
  status: 'pending' | 'processing' | 'success' | 'failed' | 'cancelled'
  progress: number
  message: string
}

export type Run = {
  id: string
  requirementId: string
  designId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  rows: QueueRow[]
  events: { at: string; type: string; message: string }[]
  createdAt: string
  updatedAt: string
}

const MAX_FILES = 20
const MAX_BYTES = 50 * 1024 * 1024
const formats = new Set(['doc', 'docx', 'xls', 'xlsx', 'pdf'])
const normalizeName = (name: string) => name.normalize('NFC').toLowerCase()
const faultMessages: Record<NonNullable<Candidate['fault']>, string> = {
  encrypted: '演练故障：文件已加密，请解除加密后重试。',
  corrupt: '演练故障：文件损坏，请更换完整文件后重试。',
  parse: '演练故障：文件解析失败，请检查文件格式后重试。',
  capacity: '演练故障：存储空间不足，请释放空间后重试。',
}

/** Existing-name conflicts are separate from batch errors so the UI resolves them afterward. */
export function validateCandidates(candidates: Candidate[], existingNames: string[]): { errors: string[]; conflicts: string[] } {
  const errors: string[] = []
  const conflicts: string[] = []
  if (!candidates.length) errors.push('请先选择至少一个文件。')
  if (candidates.length > MAX_FILES) errors.push('每批最多 20 个文件，请减少文件后重试。')
  const names = new Set<string>()
  const ids = new Set<string>()
  const existing = new Set(existingNames.map(normalizeName))
  for (const candidate of candidates) {
    const name = normalizeName(candidate.name)
    const extension = name.slice(name.lastIndexOf('.') + 1)
    if (!candidate.id.trim() || ids.has(candidate.id)) errors.push('文件标识缺失或重复，请重新选择文件。')
    ids.add(candidate.id)
    if (!candidate.name.trim() || !name.includes('.') || !formats.has(extension)) {
      errors.push(`${candidate.name || '未命名文件'}：仅支持 doc、docx、xls、xlsx、pdf。`)
    }
    if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0) {
      errors.push(`${candidate.name}：文件必须非空，且大小须为有效的字节数。`)
    } else if (candidate.size > MAX_BYTES) {
      errors.push(`${candidate.name}：单文件不能超过 50 MiB（52,428,800 字节）。`)
    }
    if (names.has(name)) errors.push(`${candidate.name}：批内存在同名文件，请移除或改名。`)
    names.add(name)
    if (existing.has(name)) conflicts.push(candidate.id)
  }
  return { errors, conflicts }
}

export function createRun(candidates: Candidate[], binding: { requirementId: string; designId: string }, at: string, id: string): Run {
  const { errors } = validateCandidates(candidates, [])
  if (errors.length) throw new Error(errors.join('\n'))
  if (!binding.requirementId.trim() || !binding.designId.trim() || !id.trim()) {
    throw new Error('缺少运行标识或冻结快照，不能开始演练。')
  }
  return {
    id,
    requirementId: binding.requirementId,
    designId: binding.designId,
    status: 'running',
    rows: candidates.map(candidate => ({ ...candidate, status: 'pending', progress: 0, message: '等待本地演练' })),
    events: [{ at, type: 'run-started', message: `开始 ${candidates.length} 项本地演练；仅使用文件元数据，不上传或解析原件。` }],
    createdAt: at,
    updatedAt: at,
  }
}

/** Each call advances exactly one file by 25%; a failure stops the remaining queue. */
export function advanceRun(run: Run, at: string): Run {
  if (run.status !== 'running') return run
  const index = run.rows.findIndex(row => row.status === 'processing' || row.status === 'pending')
  if (index < 0) return run
  const rows = run.rows.map(row => ({ ...row }))
  const row = rows[index]
  const events = [...run.events]
  if (row.status === 'pending') events.push({ at, type: 'file-started', message: `开始演练：${row.name}` })
  row.status = 'processing'
  row.progress = Math.min(100, row.progress + 25)
  row.message = '本地模拟处理中；未上传原件'
  let status: Run['status'] = 'running'
  if (row.progress === 100) {
    if (row.fault) {
      row.status = 'failed'
      row.message = faultMessages[row.fault]
      status = 'failed'
      for (const remaining of rows.slice(index + 1)) {
        if (remaining.status === 'pending') remaining.message = '未开始：前一项失败，队列已停止'
      }
      events.push({ at, type: 'file-failed', message: `${row.name}：${row.message}` })
      events.push({ at, type: 'run-failed', message: '已停止后续文件；成功项保留为本地演练记录。' })
    } else {
      row.status = 'success'
      row.message = '演练完成；未上传或解析原件'
      events.push({ at, type: 'file-succeeded', message: `演练完成：${row.name}` })
      if (rows.every(item => item.status === 'success')) {
        status = 'completed'
        events.push({ at, type: 'run-completed', message: '本批本地演练已完成；不代表真实文件服务验收。' })
      }
    }
  }
  return { ...run, status, rows, events, updatedAt: at }
}

export function cancelRun(run: Run, at: string): Run {
  if (run.status !== 'running') return run
  return {
    ...run,
    status: 'cancelled',
    rows: run.rows.map(row => row.status === 'processing'
      ? { ...row, status: 'cancelled', message: '处理已取消，未完成' }
      : row.status === 'pending' ? { ...row, message: '未开始：演练已取消' } : { ...row }),
    events: [...run.events, { at, type: 'run-cancelled', message: '用户取消演练；保留成功项，未完成项未记为成功。' }],
    updatedAt: at,
  }
}

/** Reopening a saved running queue never silently resumes it or marks it successful. */
export function recoverRun(run: Run, at: string): Run {
  if (run.status !== 'running') return run
  return {
    ...run,
    status: 'interrupted',
    rows: run.rows.map(row => row.status === 'processing'
      ? { ...row, status: 'cancelled', message: '页面关闭或刷新导致中断，未完成' }
      : row.status === 'pending' ? { ...row, message: '未开始：页面已中断' } : { ...row }),
    events: [...run.events, { at, type: 'run-interrupted', message: '恢复了上次未完成的本地记录；未自动继续，可显式重试未完成项。' }],
    updatedAt: at,
  }
}

/** Rehearsal-only repair: clear injected faults and retry unfinished rows, never successes. */
export function retryRun(run: Run, at: string): Run {
  if (run.status === 'running' || run.status === 'completed' || !run.rows.some(row => row.status !== 'success')) {
    throw new Error('仅可重试已停止演练中的未完成项。')
  }
  return {
    ...run,
    status: 'running',
    rows: run.rows.map(row => {
      if (row.status === 'success') return { ...row }
      const { fault: _fault, ...candidate } = row
      return { ...candidate, status: 'pending', progress: 0, message: '模拟故障已解除，等待重试' }
    }),
    events: [...run.events, { at, type: 'run-retried', message: '模拟解除故障后重试未完成项；成功项不重复处理，不代表原文件已修复。' }],
    updatedAt: at,
  }
}
