import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Product } from '../model'
import design from './design-snapshot.json'
import { advanceRun, cancelRun, createRun, recoverRun, retryRun, validateCandidates, type Candidate, type Run } from './engine'
import { composition, emptyData, freezeRequirement, isCurrent, requirementContent, rules, sourceC05, validPilotData, type PilotData } from './contract'
import { createPilotStore } from './persistence'
import './pilot.css'

const now = () => new Date().toISOString()
const labels = { pending: '未开始', processing: '演练中', success: '模拟成功', failed: '模拟失败', cancelled: '已停止', running: '演练中', completed: '本轮完成', interrupted: '已中断' }
const faults = { encrypted: '文件加密', corrupt: '文件损坏', parse: '解析失败', capacity: '空间不足' }
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`
const timeLabel = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false })
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function observations(run: Run) {
  const failed = run.rows.findIndex(row => row.status === 'failed')
  return [
    `已绑定需求 ${run.requirementId} 与设计 ${run.designId}。`,
    `当前 ${run.rows.filter(row => row.status === 'success').length} 项模拟成功，${run.rows.filter(row => row.status === 'pending').length} 项未开始。`,
    failed >= 0 ? `第 ${failed + 1} 项失败；其后 ${run.rows.slice(failed + 1).length} 项${run.rows.slice(failed + 1).every(row => row.status === 'pending' && row.progress === 0) ? '均未启动' : '状态需人工复核'}。` : '本次当前状态没有失败项；不能据此证明故障分支已验证。',
    '以上仅记录本地状态机的可观察结果；真实文件解析、服务存储和正式验收仍待验证。',
  ]
}

export default function UploadDesignPilot({ product, onClose }: { product: Product; onClose: () => void }) {
  const [store] = useState(() => createPilotStore<PilotData>(`c05-public-example:v1:${product.id}`, validPilotData))
  const [data, setData] = useState<PilotData>(() => store.read().data ?? emptyData())
  const [storageError, setStorageError] = useState(() => store.read().error)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<'rules' | 'upload' | 'records'>(() => data.activeRequirementId ? 'upload' : 'rules')
  const [message, setMessage] = useState('')
  const [checked, setChecked] = useState(false)
  const [closeAsked, setCloseAsked] = useState(false)
  const [reloadAsked, setReloadAsked] = useState(false)
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [ownership, setOwnership] = useState<'checking' | 'owned' | 'observing' | 'unavailable'>('checking')
  const dialog = useRef<HTMLDialogElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const state = useRef(data)
  const pending = useRef(false)
  const ownershipRef = useRef(ownership)
  const unsavedRef = useRef(!!storageError)
  const closePrompt = useRef<HTMLDivElement>(null)
  const closeRef = useRef<() => void>(() => {})
  state.current = data
  unsavedRef.current = !!storageError
  ownershipRef.current = ownership
  const requirement = data.requirements.find(item => item.id === data.activeRequirementId)
  const current = isCurrent(requirement, product) && data.activeDesignId === design.id && data.designs.some(item => item.id === design.id)
  const feature = requirementContent(product).feature
  const latest = data.runs.at(-1)
  const running = latest?.status === 'running'
  const locked = saving || !!storageError || !!running || ownership !== 'owned'
  const existingNames = data.runs.flatMap(run => run.rows.filter(row => row.status === 'success').map(row => row.name))
  const validation = validateCandidates(data.draft, existingNames)
  const canStart = current && feature?.review !== '已排除' && data.draft.length > 0 && validation.errors.length === 0 && validation.conflicts.length === 0 && !locked
  const viewedRun = data.runs.find(run => run.id === selectedRun) ?? latest

  async function commit(next: PilotData) {
    if (pending.current || ownershipRef.current !== 'owned') return false
    pending.current = true; setSaving(true); state.current = next; setData(next)
    try { const failure = await store.write(next); setStorageError(failure); return !failure }
    catch { setStorageError('试点记录保存失败。当前结果仍在本页，请导出后再离开。'); return false }
    finally { pending.current = false; setSaving(false) }
  }
  function requestClose() {
    if (pending.current) { setMessage('正在保存，请稍候再返回。'); return }
    if ((running && ownership === 'owned') || storageError) { setCloseAsked(true); return }
    onClose()
  }
  closeRef.current = requestClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal()
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ((ownershipRef.current === 'owned' && state.current.runs.at(-1)?.status === 'running') || pending.current || unsavedRef.current) { event.preventDefault(); event.returnValue = '' }
    }
    const navigate = (event: Event) => { event.preventDefault(); closeRef.current() }
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('c05-example:before-navigate', navigate)
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('c05-example:before-navigate', navigate); dialog.current?.close(); previous?.focus() }
  }, [store])
  useEffect(() => {
    let alive = true, release: (() => void) | undefined
    const key = `c05-public-example:v1:${product.id}`
    const timer = setTimeout(() => {
      if (!navigator.locks) { setOwnership('unavailable'); return }
      void navigator.locks.request(`${key}:session`, { ifAvailable: true }, async lock => {
        if (!alive) return
        if (!lock) { ownershipRef.current = 'observing'; setOwnership('observing'); return }
        ownershipRef.current = 'owned'; setOwnership('owned')
        const loaded = store.reload()
        setStorageError(loaded.error)
        if (!loaded.error) {
          const saved = loaded.data ?? emptyData(); state.current = saved; setData(saved)
          if (saved.runs.some(run => run.status === 'running')) {
            await commit({ ...saved, runs: saved.runs.map(run => recoverRun(run, now())) })
            setMessage('检测到上次未完成的演练，已标记中断。成功项保留，未完成项需要显式重试。')
          }
        }
        if (alive) await new Promise<void>(resolve => { release = resolve })
      }).catch(() => { if (alive) setOwnership('unavailable') })
    }, 0)
    const observe = (event: StorageEvent) => {
      if (event.key !== key || ownershipRef.current !== 'observing') return
      const loaded = store.reload(); setStorageError(loaded.error)
      if (!loaded.error) { const saved = loaded.data ?? emptyData(); state.current = saved; setData(saved) }
    }
    window.addEventListener('storage', observe)
    return () => { alive = false; clearTimeout(timer); release?.(); window.removeEventListener('storage', observe) }
  }, [store])
  useEffect(() => { if (closeAsked) { closePrompt.current?.scrollIntoView({ block: 'start' }); closePrompt.current?.focus() } }, [closeAsked])
  useEffect(() => { content.current?.scrollTo({ top: 0 }) }, [tab])
  useEffect(() => {
    if (!running || saving || storageError || ownership !== 'owned') return
    const timer = setTimeout(() => {
      const saved = state.current
      const run = saved.runs.at(-1)
      if (run?.status === 'running') void commit({ ...saved, runs: saved.runs.map(item => item.id === run.id ? advanceRun(item, now()) : item) })
    }, 350)
    return () => clearTimeout(timer)
  }, [data, running, saving, storageError, ownership])

  async function confirmRules() {
    if (!checked || !feature || feature.review === '已排除' || locked) return
    setMessage('正在冻结本轮规则…')
    try {
      const snapshot = await freezeRequirement(product, now())
      const saved = state.current
      if (await commit({ ...saved, activeRequirementId: snapshot.id, activeDesignId: design.id, requirements: saved.requirements.some(item => item.id === snapshot.id) ? saved.requirements : [...saved.requirements, snapshot], designs: saved.designs.some(item => item.id === design.id) ? saved.designs : [...saved.designs, design] })) {
        setMessage('本轮演练规则已冻结。示例功能不因此变成正式业务审批。'); setTab('upload'); setChecked(false)
      }
    } catch { setMessage('冻结未完成，请重试。原规则未改变。') }
  }
  async function choose(candidates: Candidate[]) {
    if (locked) return
    const saved = await commit({ ...state.current, draft: [...state.current.draft, ...candidates] })
    if (saved) setMessage('已记录文件名称和大小；没有读取、上传文件内容。')
    if (fileInput.current) fileInput.current.value = ''
  }
  function samples(withFailure: boolean) {
    if (locked) return
    const items: Candidate[] = [
      { id: crypto.randomUUID(), name: '示例说明.docx', size: 24 * 1024 },
      { id: crypto.randomUUID(), name: '示例数据.xlsx', size: 64 * 1024 },
      { id: crypto.randomUUID(), name: '示例附件.pdf', size: 380 * 1024, ...(withFailure ? { fault: 'parse' as const } : {}) },
      { id: crypto.randomUUID(), name: '示例补充.doc', size: 12 * 1024 },
    ]
    void choose(items)
  }
  async function startRun() {
    if (!canStart || !requirement) return
    try {
      const run = createRun(data.draft, { requirementId: requirement.id, designId: design.id }, now(), crypto.randomUUID())
      if (await commit({ ...state.current, draft: [], runs: [...state.current.runs, run] })) { setSelectedRun(run.id); setMessage('本地演练已开始。每项完成后才处理下一项。') }
    } catch (error) { setMessage(error instanceof Error ? error.message : '启动失败，请检查文件列表。') }
  }
  async function stop(close = false) {
    const saved = state.current, run = saved.runs.at(-1)
    if (!run) return
    const success = await commit({ ...saved, runs: saved.runs.map(item => item.id === run.id ? cancelRun(item, now()) : item) })
    setCloseAsked(false); setMessage('演练已停止。成功项保留，其他项没有完成；可在运行记录中查看。')
    if (close && success) onClose()
  }
  async function retry() {
    if (!latest || !current || latest.requirementId !== requirement?.id || latest.designId !== design.id || locked) return
    try {
      const next = retryRun(latest, now())
      if (await commit({ ...state.current, runs: state.current.runs.map(run => run.id === next.id ? next : run) })) { setTab('upload'); setMessage('已模拟修复故障，仅重试未完成项。没有连接真实解析服务。') }
    } catch (error) { setMessage(error instanceof Error ? error.message : '不能重试。') }
  }
  async function rename(id: string) {
    const name = renames[id]?.trim()
    if (!name || locked) return
    await commit({ ...state.current, draft: state.current.draft.map(row => row.id === id ? { ...row, name } : row) })
  }
  function exportEvidence() {
    download(`C05-设计联动证据-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({
      ...state.current, schema: 'c05-pilot-evidence/1', dataSchema: state.current.schema, exportedAt: now(), savedLocally: !storageError && !saving,
      scope: 'local-simulation-only', composition,
      observations: state.current.runs.map(run => ({ runId: run.id, notes: observations(run) })),
      pendingVerification: ['真实五格式文件解析', '服务器容量及权限', '正式组件库接入与兼容性', '正式需求审批与交付验收'],
    }, null, 2))
  }
  async function reload() {
    if (pending.current) return
    const next = store.reload(); setStorageError(next.error)
    if (next.error) { setMessage('已保存的记录无法读取，原始数据已保留。'); return }
    const loaded = next.data ?? emptyData()
    state.current = loaded; setData(loaded); setReloadAsked(false); setCloseAsked(false)
    if (ownership === 'owned' && loaded.runs.some(run => run.status === 'running')) await commit({ ...loaded, runs: loaded.runs.map(run => recoverRun(run, now())) })
    setMessage('已读取浏览器内保存的记录。')
  }

  return <dialog ref={dialog} className="pilot-dialog" style={design.cssVariables as CSSProperties} aria-labelledby="pilot-title" onCancel={event => { event.preventDefault(); requestClose() }}>
    <div className="pilot-shell">
      <header className="pilot-header"><div><span className="pilot-eyebrow">公开示例 / C05 交互试验室</span><h1 id="pilot-title">让示例规则进入交互</h1><p>需求依据 → 冻结设计 → 上传演练 → 运行记录</p></div><div className="pilot-header-actions"><button onClick={exportEvidence}>导出证据包</button><button onClick={requestClose} aria-label="关闭设计联动试点">返回示例首页</button></div></header>
      <div className="pilot-boundary"><strong>本地演练</strong><span>仅保存文件元数据与交互记录，不读取或上传文件内容。AI、真实五格式解析、正式验收尚未接入。</span></div>
      <nav className="pilot-tabs" aria-label="试点步骤">{([['rules','01','规则与设计'],['upload','02','上传演练'],['records','03','运行记录']] as const).map(([id, number, title]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><span>{number}</span>{title}{id === 'records' && <small>{data.runs.length}</small>}</button>)}<span className="pilot-save-state" role="status">{saving ? '正在保存…' : storageError ? '保存异常' : '记录保存在此浏览器'}</span></nav>
      <div ref={content} className="pilot-content">
        {ownership === 'observing' && <div className="pilot-feedback warning" role="status">另一页面正在使用试点。本页只读展示已保存记录，不会中断那里的演练。关闭另一页面的试点后，可返回示例首页并重新打开。</div>}
        {ownership === 'unavailable' && <div className="pilot-feedback danger" role="alert">当前浏览器无法取得试点操作锁，已暂停修改以保护其他页面的记录。请使用支持 Web Locks 的浏览器重新打开。</div>}
        {storageError && <div className="pilot-feedback danger" role="alert"><strong>{storageError}</strong><p>本页结果仍保留。请导出后再处理保存问题。</p><div className="pilot-actions"><button disabled={saving} onClick={() => void commit(state.current)}>重试保存本页记录</button><button onClick={() => download('C05-原始记录.json', store.raw() ?? 'null')}>导出原始记录</button><button disabled={saving} onClick={() => setReloadAsked(true)}>读取已保存记录</button></div>{reloadAsked && <p>重新读取会丢弃本页未保存的修改。<button disabled={saving} onClick={() => void reload()}>确认重新读取</button><button onClick={() => setReloadAsked(false)}>保留本页</button></p>}</div>}
        {message && <div className="pilot-feedback" role="status">{message}</div>}
        {closeAsked && <div ref={closePrompt} tabIndex={-1} className="pilot-feedback warning" role="alert"><strong>{running ? '本轮仍有未完成项。停止后，成功项保留，后续项不会执行。' : '有未保存的记录。请先导出，离开会丢失本页修改。'}</strong><div className="pilot-actions">{running ? <button disabled={saving || !!storageError} onClick={() => void stop(true)}>停止演练并返回</button> : <button disabled={saving} onClick={onClose}>放弃未保存修改并返回</button>}<button onClick={() => setCloseAsked(false)}>留在试点</button>{storageError && <><button onClick={exportEvidence}>导出本页证据</button>{running && <button disabled={saving} onClick={onClose}>放弃本页修改并返回</button>}</>}</div></div>}
        {requirement && !current && <div className="pilot-feedback warning" role="alert">C05 依据或功能定义已变化。旧记录保留，但不再代表当前规则；请重新核对并冻结。<button onClick={() => setTab('rules')}>核对变更</button></div>}
        {tab === 'rules' && <>
          <div className="pilot-intro"><div><h2>先对齐依据，再开始演练</h2><p>这次确认仅作用于演示。示例功能状态仍为“{feature?.review ?? '未找到'}”。</p></div><span className={`pilot-badge ${current ? 'good' : ''}`}>{current ? '本轮规则已冻结' : '等待核对'}</span></div>
          <div className="pilot-two-column">
            <section className="pilot-card"><div className="pilot-card-label">01 / 需求依据</div><h3>批量上传文件</h3><p className="pilot-caption">{sourceC05.locator}</p><blockquote>{sourceC05.text}</blockquote><p className="pilot-caption">来源归属：{sourceC05.basis}。全部内容为本演示自编，不引用真实需规或内部项目。</p><details><summary>查看自编 C05 示例定义</summary><p>来源定位：{requirementContent(product).workspaceEvidence?.locator ?? '缺失'}</p><p>{requirementContent(product).workspaceEvidence?.text}</p><p>功能状态：{feature?.review ?? '缺失'}</p><p>成功结果：{feature?.success || '未填写'}</p><p>失败处理：{feature?.failure || '未填写'}</p><p className="pilot-caption">本轮执行下方固定规则；完整示例定义随快照导出，未自动转换为新规则。</p></details></section>
            <section className="pilot-card"><div className="pilot-card-label">02 / 冻结设计</div><h3>示例设计 · {design.release}</h3><p>使用 {Object.keys(design.tokens).length} 个自编设计变量，演示设计快照与交互的绑定。</p><div className="pilot-swatches">{(['primary','textPrimary','border','surfaceBackground'] as const).map(key => { const token = design.tokens[key]; return <span key={key}><i style={{ backgroundColor: String(token.value) }}/><code>{String(token.value)}</code></span> })}</div><p className="pilot-caption">{design.runtime.usage}</p><details><summary>查看示例边界与来源</summary><ul>{design.dataQualityNotes.map(note => <li key={note}>{note}</li>)}</ul><p>上传、进度、反馈使用本地原生控件适配，未伪称为已批准组件。</p><p className="pilot-code">快照：{design.id}<br/>来源：{design.originSource}</p></details></section>
          </div>
          <section className="pilot-card"><h3>本轮可执行规则</h3><div className="pilot-rules">{rules.map(rule => <div key={rule.id}><code>{rule.id}</code><p>{rule.text}<small>{rule.origin}</small></p></div>)}</div><div className="pilot-confirm"><label><input type="checkbox" checked={checked} disabled={locked || feature?.review === '已排除' || !feature} onChange={e => setChecked(e.target.checked)}/><span>我已核对示例约定与本轮设计补充，确认用于本地演练。</span></label><button className="pilot-primary" disabled={!checked || locked || !feature || feature.review === '已排除'} onClick={() => void confirmRules()}>冻结规则并进入演练</button></div>{feature?.review === '已排除' && <p role="alert">C05 已被排除，请先复核示例范围。</p>}</section>
        </>}
        {tab === 'upload' && <>
          <div className="pilot-intro"><div><h2>批量上传演练</h2><p>先完成校验与重名处理，再观察顺序执行、失败停止及恢复。</p></div><span className="pilot-badge">最多 20 个 · 单件 ≤ 50 MiB</span></div>
          {!current && <div className="pilot-feedback warning">请先在“规则与设计”中冻结本轮规则，再启动演练。<button onClick={() => setTab('rules')}>前往核对</button></div>}
          <section className="pilot-card">
            <input ref={fileInput} type="file" accept=".doc,.docx,.xls,.xlsx,.pdf" multiple hidden onChange={e => void choose(Array.from(e.target.files ?? []).map(file => ({ id: crypto.randomUUID(), name: file.name, size: file.size })))}/>
            <button className="pilot-drop" disabled={locked} onClick={() => fileInput.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!locked) void choose(Array.from(e.dataTransfer.files).map(file => ({ id: crypto.randomUUID(), name: file.name, size: file.size }))) }}><strong>选择文件，或拖放到这里</strong><span>Word / Excel / PDF · 只读取名称和大小</span></button>
            <div className="pilot-actions pilot-sample-actions"><span>快速体验</span><button disabled={locked} onClick={() => samples(false)}>加入正常样本</button><button disabled={locked} onClick={() => samples(true)}>加入第 3 项失败样本</button></div>
            {data.draft.length > 0 && <><div className="pilot-list-heading"><h3>待提交 · {data.draft.length} 个</h3><button disabled={locked} onClick={() => void commit({ ...state.current, draft: [] })}>取消选择</button></div><div className="pilot-rows">{data.draft.map((row, index) => <div className="pilot-file" key={row.id}><span className="pilot-file-number">{String(index + 1).padStart(2,'0')}</span><div className="pilot-file-info"><strong>{row.name}</strong><small>{sizeLabel(row.size)}</small></div><label className="pilot-fault">演练故障<select aria-label={`${row.name}的演练故障`} disabled={locked} value={row.fault ?? ''} onChange={e => void commit({ ...state.current, draft: state.current.draft.map(item => item.id === row.id ? { ...item, fault: e.target.value ? e.target.value as Candidate['fault'] : undefined } : item) })}><option value="">无</option>{Object.entries(faults).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label><button disabled={locked} aria-label={`移除${row.name}`} onClick={() => void commit({ ...state.current, draft: state.current.draft.filter(item => item.id !== row.id) })}>移除</button></div>)}</div></>}
            {data.draft.length > 0 && validation.errors.length > 0 && <div className="pilot-feedback danger" role="alert"><strong>提交前校验未通过</strong><ul>{validation.errors.map((error,index) => <li key={index}>{error}</li>)}</ul><p>请先移除不符合规则的文件，之后再处理已有冲突。</p></div>}
            {validation.errors.length === 0 && validation.conflicts.length > 0 && <div className="pilot-feedback warning" role="alert"><strong>与试点中已成功的文件重名</strong><p>补充规则：改名或移除，不覆盖已有记录。</p>{data.draft.filter(row => validation.conflicts.includes(row.id)).map(row => <div key={row.id} className="pilot-rename"><label>{row.name}<input aria-label={`${row.name}的新名称`} value={renames[row.id] ?? row.name} onChange={e => setRenames({ ...renames, [row.id]: e.target.value })}/></label><button disabled={locked || !renames[row.id]?.trim()} onClick={() => void rename(row.id)}>应用新名称</button><button disabled={locked} onClick={() => void commit({ ...state.current, draft: state.current.draft.filter(item => item.id !== row.id) })}>移除</button></div>)}</div>}
            <footer className="pilot-start"><span>{data.draft.length ? `合计 ${sizeLabel(data.draft.reduce((sum,row) => sum + row.size,0))} · 不额外限制批次总量` : '尚未选择文件'}</span><button className="pilot-primary" disabled={!canStart} onClick={() => void startRun()}>开始本地演练</button></footer>
          </section>
          {latest && <section className="pilot-card"><div className="pilot-list-heading"><h3>当前运行 <span className={`pilot-badge ${latest.status === 'completed' ? 'good' : ''}`}>{labels[latest.status]}</span></h3>{running && <button disabled={saving || !!storageError || ownership !== 'owned'} onClick={() => void stop()}>停止演练</button>}</div><Queue run={latest}/>{!running && latest.status !== 'completed' && <div className="pilot-actions"><button className="pilot-primary" disabled={locked || !current || latest.requirementId !== requirement?.id || latest.designId !== design.id} onClick={() => void retry()}>模拟修复并重试未完成项</button><span>保留成功项；清除注入故障后重试。</span></div>}<button className="pilot-link" onClick={() => { setSelectedRun(latest.id); setTab('records') }}>查看本轮依据与事件记录 →</button></section>}
        </>}
        {tab === 'records' && <>
          <div className="pilot-intro"><div><h2>每次运行，都能追到依据</h2><p>这些是本地交互证据，正式验收仍需真实文件、服务与人工确认。</p></div><button onClick={exportEvidence}>导出全部运行记录</button></div>
          {!viewedRun ? <section className="pilot-card pilot-empty"><h3>还没有运行记录</h3><p>先冻结规则并运行一批样本。提交前取消不会产生运行记录。</p><button onClick={() => setTab('upload')}>前往上传演练</button></section> : <div className="pilot-record-layout"><aside className="pilot-history" aria-label="历史运行">{[...data.runs].reverse().map((run,index) => <button key={run.id} aria-pressed={run.id === viewedRun.id} onClick={() => setSelectedRun(run.id)}><strong>第 {data.runs.length - index} 轮 · {labels[run.status]}</strong><span>{timeLabel(run.createdAt)}</span></button>)}</aside><section className="pilot-card"><div className="pilot-list-heading"><h3>{labels[viewedRun.status]}</h3><span className="pilot-badge">{viewedRun.requirementId === requirement?.id && current && viewedRun.designId === design.id ? '与当前快照一致' : '历史依据 · 需重新验证'}</span></div><dl className="pilot-bindings"><dt>需求快照</dt><dd>{viewedRun.requirementId}</dd><dt>设计快照</dt><dd>{viewedRun.designId}</dd><dt>运行编号</dt><dd>{viewedRun.id}</dd></dl><Queue run={viewedRun}/><h4>本轮观察</h4><ul className="pilot-observations">{observations(viewedRun).map(note => <li key={note}>{note}</li>)}</ul><h4>事件记录</h4><ol className="pilot-events">{viewedRun.events.map((event,index) => <li key={index}><time>{timeLabel(event.at)}</time><span>{event.message}</span></li>)}</ol></section></div>}
        </>}
      </div>
    </div>
  </dialog>
}

function Queue({ run }: { run: Run }) {
  return <ol className="pilot-queue" aria-label="逐项处理状态">{run.rows.map(row => <li key={row.id} data-status={row.status}><div><strong>{row.name}</strong><span>{labels[row.status]}</span></div><progress value={row.progress} max={100} aria-label={`${row.name}进度`}/><small>{row.message || (row.status === 'pending' ? '等待前序完成' : `${row.progress}%`)}</small></li>)}</ol>
}
