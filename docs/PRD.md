## 介绍

使用 vite 前后端分离架构

前端界面使用 ai-sdk, ai-elements 组件库, 参照 `/Volumes/Data/workspace/ui-dojo` 项目, 但不要使用
前端UI使用 shadcn reactbits 组件库
提示或错误提示统一使用toast消息弹出

## 实现功能模块

* 用户认证 功能, 使用 better-auth <https://better-auth.com/docs/plugins/admin>
  目前实现账号密码注册/登录, `.env` 可配置多系统管理员默认 admin  ADMINS=admin,...

* 个人聊天线程 功能
  创建个人聊天线程

* 项目聊天线程 功能
  项目仪表盘
  项目聊天线程 mastra 用

* 模型供应商 (需要admin权限), 参照 `./模型供应商模块.md`
  配置 默认模型, 快速模型, 图片生成模型, 默认思考模式, 记录在 settings 表中
  模型供应商 crud, 供应商配置添加 "模型" 按钮, 默认使用 /models 拉取模型列表

* 用户管理(需要admin权限), 使用 better-auth 的 admin 插件实现 <https://better-auth.com/docs/plugins/admin>, 不要自己代码实现

* 系统设置(需要admin权限)

* i18n功能, 默认根据系统识别语言

## .env环境变量

```
ADMINS=admin,...
DATABASE_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://xxx
WORKSPACE_ROOT=workspaces
DEFAULT_MODEL=gpt-6-sol
```

## 数据结构

> 业务表使用 TypeORM, 使用 @CreateDateColumn @DeleteDateColumn @UpdateDateColumn；认证表由 Better Auth 配置、插件和官方迁移管理，不定义 TypeORM 认证实体。
> 映射规则

```
TypeScript              PostgreSQL
---------------------------------------
userId          →       user_id
organizationId  →       organization_id
createdAt       →       created_at
deletedAt       →       deleted_at
```

projects 项目

* id
* name
* metadata 项目元数据
* created\_by
* created\_at
* deleted\_at

providers 模型供应商

* id
* name
* type 目前默认只有openai类型可选
* base\_url
* api\_key
* enabled
* metadata 供应商元数据
* created\_at
* updated\_at
* deleted\_at

provider\_models 模型供应商模型配置

* id 模型id
* provider\_id
* name 模型名称
* display\_name 显示名称(可选)
* enabled
* metadata 模型元数据 jsonb 格式

settings 系统配置

* id
* value
* created\_at
* updated\_at
* deleted\_at

## Commands

```
pnpm run dev - Start both backend servers and Vite servers use concurrently.
pnpm run build - Build for production
pnpm run lint - Lint code
pnpm run format - Format code with Prettier
```

## 目录结构

```
aime-hub/
├── docs/                     # 文档
├── scripts/                  # 放置开发测试脚本
├── apps/
│   ├── web/                  # Vite + React
│   │   ├── src/
│   │   └── vite.config.ts
│   │
│   └── server/               # Node 后端
│       └── src/
│           ├── mastra/       # mastra 项目文件包括tools, agents, 等 参考mastra skill
│           └── lib/
├── packages/
│   ├── db/
│   ├── auth/
│   ├── shared/               # 前后端共享
│   │   ├── types/
│   │   ├── schemas/
│   │   └── constants/
│   │
│   └── database/
│       ├── schema/
│       └── client.ts
├── plugins/                  # 插件
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.json
```

## 页面

/projects/<projectId> 项目仪表盘页面
/threads/<threadId> 聊天线程页面

/admin 后台管理页面
/admin/settings 系统配置页面
/admin/providers 模型供应商配置页面
/admin/users 用户管理配置页面

## api接口

GET api/threads/<threadId> 获取当前聊天线程元数据(状态, id, 消息队列等所有状态)
GET api/threads/<threadId>/messages 获取当前消息sse

api/projects/<projectId>/\* 项目仪表盘
GET api/projects/<projectId> 获取项目元数据

api/auth/admin/\* 用户管理（Better Auth admin 插件提供，不另建 CRUD API）
api/admin/providers/\* 模型供应商
api/admin/settings/\* 系统配置

## 验收步骤

注意按步骤验收, 构建完毕后更改为\[x], 实现完成才做一下步骤, 先让用户确认, 每个步骤都需要提交一个git

\[x] 登录/注册实现, 侧边栏(后台管理)不是实现具体功能（实现及测试完成，待用户确认后进入下一阶段）
\[x] 实现用户管理模块（Better Auth admin 插件；实现及测试完成，待用户确认后进入下一阶段）
\[x] 模型供应商管理模块（右侧抽屉管理模型，长度支持预设、自定义及留空按模型默认；实现及测试完成，待用户验收确认）
\[ ] 参照 `./harness.md` 构建个人聊天页面功能(暂时不构建项目聊天)