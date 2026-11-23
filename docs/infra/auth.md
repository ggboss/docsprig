# 管理认证

管理端使用单进程管理员账号，账号和密码来自环境变量 `DOCS_ADMIN_USERNAME`、`DOCS_ADMIN_PASSWORD`。登录后服务端签发进程内 HttpOnly、SameSite cookie；重启服务会使会话失效。

登录、退出和管理写请求要求请求来源与 `DOCS_PUBLIC_ORIGIN` 匹配，并拒绝跨站写请求。公开浏览端和公开 MCP 不需要登录。当前认证适合单机或单实例部署，不包含多用户、角色管理、账号注册或分布式会话。

生产环境必须更换示例密码并启用 HTTPS。不要把密码、cookie 或 MCP 令牌写入仓库、日志或前端配置。
