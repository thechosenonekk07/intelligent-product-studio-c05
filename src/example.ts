import type { Product } from './model.ts'

/** Written specifically for this public demonstration; not a customer or project requirement. */
export const sourceC05 = {
  id: 'C05',
  title: '示例资料批量导入',
  locator: '自编演示说明 · 场景 C05',
  text: '设想一个资料收集页面：使用者一次选取 1 至 20 份 Word、Excel 或 PDF 文件。每份文件要有内容，且大小不超过 50 MiB。先核对文件类型、数量、大小和批内同名，再解决与已记录文件的名字冲突。队列每次演练一份；遇到设定的故障就暂停后续文件，并保留先前的成功记录。关闭或取消时说明哪些项目尚未完成。这些约定仅用于演示交互，不代表任何真实产品规则。',
  basis: '为公开演示专门编写的虚构场景',
}
export const exampleProduct: Product = {
  id: 'public-c05-example',
  name: 'C05 交互示例',
  sourceName: '自编演示说明',
  blocks: [{ id: 'C05', locator: sourceC05.locator, text: sourceC05.text, basis: sourceC05.basis }],
  features: [{ id: 'example-feature-C05', sourceId: 'C05', title: sourceC05.title, review: '待复核', success: '所有条目完成本地模拟后，形成可导出的运行记录。', failure: '展示模拟故障原因，停止后续条目；已成功条目保留。' }],
}
