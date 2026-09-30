# 模块组织

前后端按业务模块组织。路由地址和 HTTP 数据结构保持不变；业务数据库由 `packages/db` 管理，认证表由 `packages/auth` 的 Better Auth 配置管理。

## 前端

```text
apps/web/src/
├── app.tsx                    # 路由组合与页面懒加载
├── layouts/                   # 应用外壳、侧栏、导航定义
├── features/auth/             # 跨页面认证客户端、会话与路由守卫
├── features/models/           # 全局可用模型 hook 与会话级共享缓存
├── pages/
│   ├── auth/page.tsx          # 登录、注册
│   ├── workspace/page.tsx     # 工作空间入口
│   ├── errors/                # 404
│   └── admin/
│       ├── overview/page.tsx  # 管理入口
│       ├── settings/page.tsx  # 系统设置入口
│       ├── users/
│       │   ├── page.tsx
│       │   └── components/    # 用户操作弹窗
│       └── providers/
│           ├── page.tsx
│           ├── api.ts         # 请求与表单转换
│           ├── api.test.ts
│           ├── hooks/         # 供应商资源读取
│           └── components/    # 默认配置、模型抽屉及操作弹窗
├── components/                # 跨模块的页面标题、加载与状态组件
│   ├── model-selector/        # 公共模型选择弹窗、选项类型与搜索分组
│   ├── ui/                    # 基础 UI 组件
│   └── ai-elements/           # AI 展示组件
├── i18n/                      # 中英文资源与初始化
└── lib/                       # 无业务归属的工具
```

- 页面入口统一使用 `page.tsx`；专属组件、hooks、请求和测试就近放在该模块。
- 跨页面能力放在 `features/`；通用视觉组件放在 `components/`，避免通用层反向导入页面。
- 页面通过动态 import 分包。布局内的 Suspense 保留导航，加载内容使用骨架状态。
- `useAvailableModels()` 从 `GET /api/models` 读取 `{ providers: [{ id, name, type, enabled, models }] }`，返回 `providers`、展开的 `models`、`loading`、`error` 和 `refresh()`。`AvailableModelsProvider` 挂载在会话 Provider 内，各组件共享同一请求和缓存；切换会话重建缓存，窗口重新聚焦及供应商/模型变更后刷新。默认模型设置只单独读取管理员默认配置，模型目录使用全局 hook。
- 模型选择统一使用 `@/components/model-selector` 导出的 `ModelSelector`。组件直接使用全局 hook，调用方提供 `value`、`onValueChange` 和字段名称 `label`，`imageOnly` 可限定图像输出模型；`noneLabel`、`emptyHint` 可覆盖未选择及空列表文案。组件处理加载、错误重试、搜索、供应商分组和选择交互，保存由调用方负责。
- `model-selector/model-options.ts` 提供选项类型及纯函数，可将共享模型数据转换为选项；界面本身不依赖管理页面或其 API。
- 用户管理仍直接使用 Better Auth admin 客户端，不新增重复 API。

## 后端

```text
apps/server/src/
├── index.ts                   # 环境、数据库和服务生命周期
├── app.ts                     # Express 组装及中间件顺序
├── middleware/
│   ├── admin-api.ts           # 来源校验、不缓存响应、业务错误处理
│   └── error-handler.ts       # 最终异常响应
└── modules/
    ├── auth/
    │   ├── routes.ts          # Better Auth handler 与 /api/me
    │   └── require-admin.ts   # 业务管理接口的会话、角色校验
    ├── health/routes.ts       # /api/health
    ├── models/routes.ts       # GET /api/models，所有已登录用户
    ├── providers/
    │   ├── routes.ts          # 供应商与模型 HTTP 路由
    │   ├── service.ts         # 持久化与业务规则
    │   └── network.ts         # 受限供应商网络请求
    └── settings/routes.ts     # /api/admin/settings/models
```

`app.ts` 只组装模块；新增业务路由放到对应的 `modules/<name>/routes.ts`。Better Auth handler 在 JSON body parser 之前注册，继续由插件处理 `/api/auth/admin/*`。业务管理接口先校验管理员，再校验写入来源、解析请求体、执行路由，最后处理错误。

默认模型引用与供应商可用性密切相关，因此 settings 路由复用 ProviderService 中的引用验证与持久化规则，避免复制同一套逻辑。

## 数据库

- `packages/auth` 使用 Better Auth 官方 PostgreSQL adapter；`users`、`sessions`、`accounts`、`verifications` 的字段及插件扩展由认证配置确定，不定义对应的 TypeORM 实体或手写迁移。
- `packages/db` 只注册 `Provider`、`ProviderModel`、`Setting` 等业务实体及其迁移。
- `pnpm db:migrate` 将 `createAuthOptions` 生成的认证配置传入官方 `getMigrations`，初始化／迁移认证表，再执行 TypeORM 业务迁移。运行时与迁移共用同一份配置；认证迁移可重复运行，本次重建不保留旧认证迁移历史。
- 服务启动检查两部分结构，缺失时退出并提示迁移；建表只在显式迁移命令中执行。
- 认证读写和用户管理通过 Better Auth API；认证表不使用 TypeORM 的软删除字段，账号停用使用封禁能力。

## 验证

运行 `pnpm typecheck`、`pnpm lint`、`pnpm build` 与 `pnpm test`。真实数据库集成需显式传入 `TEST_DATABASE_URL`，在随机 schema 内运行；不操作已有业务表。当前浏览器检查使用只读浏览与打开、取消弹窗，不修改已有用户或供应商配置。

## 可用模型目录

`GET /api/models` 只要求有效登录会话，匿名返回 401；管理接口继续要求管理员权限。单次查询返回启用且未软删除的供应商及其启用且未软删除的模型，空供应商保留 `models: []`。可用性沿用默认模型的启用规则，`deprecated` / `passTest` 不额外限制手动启用的模型。响应使用字段白名单，不返回 API Key、baseUrl、metadata 或测试状态，也不会探测上游服务。
