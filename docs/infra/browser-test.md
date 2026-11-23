# 测试说明

常规检查：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:admin:browser
pnpm test:mcp:browser
```

浏览器测试使用隔离的内存数据或一次性演示实例，不读取私有环境文件，不写入部署数据库。PostgreSQL 集成测试需要显式提供测试数据库或开启隔离 Docker 流程；不要把会保存测试内容的 runner 指向真实环境。

重点覆盖：公开读取、管理员认证、栏目和文档树操作、Markdown/OpenAPI 编辑、发布快照、MCP 隔离、来源校验、移动端布局和长文档滚动。
