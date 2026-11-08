import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import UploadDesignPilot from './design-pilot/UploadDesignPilot'
import { exampleProduct } from './example'
import './page.css'

function App() {
  const [open, setOpen] = useState(true)
  return <main className="example-page">
    <div className="example-intro"><span className="example-kicker">C05 / PUBLIC INTERACTION EXAMPLE</span><h1>设计规则，走进每一步交互。</h1><p>通过一个虚构的批量资料导入场景，体验规则确认、设计冻结、顺序处理、故障停止与可追溯运行记录。</p><button onClick={() => setOpen(true)}>进入交互示例 <span aria-hidden="true">↗</span></button><div className="example-notes"><p>示例内容为自行编写；不包含真实业务需规、内部产品数据或已有用户记录。</p><p>文件仅读取名称和大小。运行结果保存在你的浏览器，证据包需自行下载。没有真实文件上传或 AI 服务。</p></div></div>
    <div className="example-flow" aria-label="示例流程"><div><span>01</span><strong>核对规则</strong><small>自编场景与明确约定</small></div><div><span>02</span><strong>冻结设计</strong><small>合成快照绑定每轮运行</small></div><div><span>03</span><strong>体验演练</strong><small>顺序处理、失败与恢复</small></div><div><span>04</span><strong>追溯证据</strong><small>查看记录并自行导出</small></div></div>
    {open && <UploadDesignPilot product={exampleProduct} onClose={() => setOpen(false)} />}
  </main>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
