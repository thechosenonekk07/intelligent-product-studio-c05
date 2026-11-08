# C05 批量上传交互演练

这是一个使用虚构需求和示例设计变量的静态演练。体验顺序为核对规则、冻结快照、加入样本、演练队列并查看运行记录。

[打开 GitHub Pages 演练](https://thechosenonekk07.github.io/intelligent-product-studio-c05/)

浏览器保留文件名、大小和运行记录。文件内容留在本机。演练使用本地模拟故障，支持失败停止、取消、重试和 JSON 证据包导出。浏览器须支持 Web Locks。

## 更新站点

使用 Node.js 24 或更新版本。修改源码后运行以下命令。

```sh
npm ci
npm test
npm run build
```

提交源码和 `docs/` 构建结果并推送 `main`。GitHub Pages 从 `main` 的 `/docs` 目录发布。
