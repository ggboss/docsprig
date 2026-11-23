# 本地运行

## 准备

需要 Node.js 22.22+、pnpm 10+ 和 PostgreSQL。复制 `.env.example` 为 `.env.development.local`，填写自己的数据库连接和管理员密码。

```bash
pnpm install
pnpm build
pnpm db:migrate
pnpm start
```

默认地址是 `http://127.0.0.1:4391`。启动不会自动迁移数据库；修改迁移或新建数据库时，显式运行 `pnpm db:migrate`。

## 前端开发

`pnpm dev` 只启动前端开发服务器（默认端口 3000）。需要完整的管理 API 时，先构建并启动同源服务，再代理到它。为使管理请求通过来源校验，在 `.env.development.local` 中增加 `DOCS_ALLOWED_ORIGINS=http://localhost:3000`，重启后端，然后运行：

```bash
OPEN_DOCS_BACKEND=http://127.0.0.1:4391 pnpm dev
```

实际使用其他前端端口时，同步修改允许的 Origin。生产或预览环境使用 `pnpm build` 后的同源 Node 服务。

## 演示数据

空库默认不写入示例内容。需要演示数据时显式设置 `DOCS_SEED=demo` 后执行迁移；生产目标禁止使用 demo seed。

## 数据库迁移

`pnpm db:migrate` 从 `.env.development.local` 加载配置；`pnpm db:migrate:prod` 从 `.env.production.local` 加载配置并显式启用生产保护。`DOCS_DATABASE` 必须与连接串中的数据库名一致。数据库由部署者预先创建，迁移不会创建数据库。

默认使用 `docs_dev` / `docs_prod`，也支持自定义名称。生产命令禁止演示初始化，即使使用自定义库名也一样。

## 一次性 Docker 演示

显式选择此方案前，需要安装 Docker，并自行准备 `postgres:16-alpine` 镜像。`pnpm demo:docker` 不会自动下载镜像。它启动隔离演示库，退出后停止容器；交互演示的数据卷会保留供下次使用，smoke 流程使用一次性状态。
