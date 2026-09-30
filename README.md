# Aime Hub

按 `docs/PRD.md` 分阶段构建的 AI 工作空间。已实现账号认证、后台导航、用户管理和模型供应商管理，后续模块等待验收确认。

## 已实现

- 用户名／密码登录，用户名＋邮箱＋密码注册，注册自动登录、持久会话、退出登录。
- Better Auth 的 `username` 和 `admin` 插件；密码哈希、HttpOnly Cookie、来源校验及请求限流。
- 登录态和管理员路由守卫、响应式侧栏、移动端无障碍导航抽屉。
- 用户管理：管理员用户列表、邮箱/显示名称搜索、服务端分页、创建/编辑用户、角色调整、重置密码、封禁/解封、撤销全部会话、删除用户。
- 模型供应商管理：供应商及模型 CRUD、OpenAI 兼容 `/models` 拉取、models.dev 能力匹配、默认模型及思考模式持久化。
- 工作台和管理概览提供模块入口；独立系统设置页说明当前可用配置。模型默认设置仍位于供应商页面。
- 认证表由 Better Auth 配置生成；业务表使用 TypeORM 实体、显式迁移、snake_case 列名和三个日期装饰器。

## 技术栈

- pnpm workspace；`apps/web`：Vite 7、React 19、React Router 7、Tailwind CSS 4。
- UI：shadcn/ui 风格源码组件、Radix UI、Lucide、CVA；独立实现，不依赖本地 `ui-dojo`。
- 已安装 AI SDK 6 `ai` / `@ai-sdk/react` 3；AI Elements 官方 registry 源码已添加至 `apps/web/src/components/ai-elements`，包含 `conversation`、`message`、`prompt-input`、`reasoning`、`suggestion` 及其 `shimmer` 依赖。配套 Radix UI、Streamdown、Motion、滚动跟随与动画样式已接入，尚未连接聊天 API。
- `apps/server`：Express 5；`packages/auth`：Better Auth；`packages/db`：TypeORM + PostgreSQL。
- Better Auth 使用官方 PostgreSQL adapter 管理认证读写和表结构；TypeORM 只管理供应商、模型和设置等业务表，不定义认证实体或自建用户管理 API。

## 用户管理

管理员访问 `/admin/users`。页面直接调用 Better Auth `authClient.admin.*`，实际请求路径为 `/api/auth/admin/*`，由插件执行权限验证和数据操作；不新增自建用户 CRUD 接口。供应商使用 `/api/admin/providers/*`，模型默认配置使用 `/api/admin/settings/models`；这些业务接口独立校验管理员权限和写请求来源。

- 每页 20 条，按创建时间倒序；可按邮箱或显示名称搜索。
- 创建用户需提供用户名、显示名称、邮箱和密码；可指定普通用户或管理员。编辑资料不修改用户名。
- 支持永久或 1/7/30 天封禁，可填写原因；封禁立即撤销现有会话，解封后需重新登录。到期封禁在列表中显示为正常。
- 重置密码**不会撤销已有会话**，如需强制退出，另外执行“撤销全部会话”。
- 删除是插件的硬删除，需要输入目标用户邮箱确认，无法恢复；临时停用优先使用封禁。
- 页面禁用当前账号的角色调整、封禁、删除和会话撤销，减少误操作。这是界面防误触，不是额外的服务端安全策略；后端沿用插件权限，未添加“最后一个管理员”保护规则。
- 中英文文案、加载/空/失败状态、重试、提交防重复和弹窗焦点恢复均已接入。

## 模型供应商管理

管理员从后台导航进入 `/admin/providers`，管理 OpenAI 兼容供应商，并通过“模型”按钮打开右侧抽屉管理各供应商的持久化模型；模型新增、编辑和删除确认在独立弹窗中完成。

- 初始化时执行 `pnpm db:migrate`，先由 Better Auth 初始化认证表，再由 TypeORM 创建 `providers`、`provider_models`、`settings` 三张业务表。重复执行只应用待执行变更。
- 供应商可新增、编辑、启停、删除。API Key 仅保存在服务端数据库，不回传浏览器；编辑时留空保留原值，显式勾选清除才删除密钥。数据库目前为明文存储，应限制数据库/备份访问权限。metadata 不用于保存密钥。
- Base URL 填写 API 根地址（包括所需的 `/v1`），同步时追加 `/models`。为防 SSRF，仅允许公共网络 HTTP(S) 地址；阻止内网、回环、链路本地地址和重定向，DNS 校验后固定连接地址。携带密钥的网络请求强制使用 HTTPS；本阶段不支持本地 Ollama 等私网端点。
- 同步成功后新增模型，并根据本次列表双向更新 `deprecated`。缺失模型仅标记，不禁用、不删除；失败不会改动模型。models.dev 不可用时仍导入 ID，显示能力补全警告。
- 新模型优先精确匹配 models.dev 模型 ID，否则匹配 ID 最后一段，忽略供应商分组；多候选按供应商键排序稳定选择。保存匹配模型 raw JSON 为 metadata。已有模型的手工字段始终保留，同步仅更新过时标记。
- 模型支持手工创建、编辑 ID/名称/显示名称、输入输出能力、思考/工具调用和上下文/输出长度，启用状态使用 Switch。上下文长度预设 32k/64k/128k/256k/512k，输出长度预设 16k/32k/64k/128k/256k/512k（1k = 1,000 tokens），通过输入框下方的 Badge 点击填写，也可输入自定义整数；留空或点击“按模型默认”保存为 null。模型弹窗不编辑 metadata、deprecated 和 passTest，更新请求省略这些字段以保留已有值。模型能力使用带悬停及键盘提示的图标展示，启用、过时与测试状态使用 Badge 展示；新模型默认未测试，不会自动调用收费推理或生成接口。
- 模型以 `(provider_id, id)` 复合主键存储，支持不同供应商同名以及含 `/` 的模型 ID。模型引用采用 `<providerId>/<完整模型ID>`。
- 默认模型、快速模型、图片生成模型及思考模式（自动/开启/关闭）保存在 `settings` 的 `models` 行；只允许选择启用供应商下的启用模型，图片生成默认项要求图片输出能力。取消默认配置后才能删除、停用或修改被引用模型 ID；过时模型仍可作为默认项。
- 删除供应商或模型为软删除；供应商删除同时清除其密钥。再次拉取不会恢复手工删除的模型或重命名前的旧 ID；需要恢复时可手工使用原 ID 新建。删除需要输入名称或模型 ID 确认。
- 后端 `ProviderService.getProvider(id)` 供服务端读取持久化配置及密钥；HTTP 使用脱敏 DTO。`getModel(reference)` 仅读数据库，提供 `supportsImageInput`、`supportsVideoInput`、`supportsAudioInput`、`context` 等属性。
- 模型同步每供应商每分钟最多一次，HTTP 请求有超时及响应大小限制；限流为单进程内存机制。聊天执行、默认模型运行时回退和思考参数适配留待聊天阶段实现。

## 前端 AI 组件

```tsx
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  Conversation,
  ConversationContent,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
} from '@/components/ai-elements/prompt-input';
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from '@/components/ai-elements/reasoning';
import { Suggestions, Suggestion } from '@/components/ai-elements/suggestion';
```

组件源自 `https://registry.ai-sdk.dev/{name}.json`，配套 UI 源自 shadcn/ui registry；保留原有登录页 Button/Input，并适配当前 TypeScript、React Hooks 规则与项目主题。AI Elements 是源码组件，不需要安装同名运行时包。`useChat` 的模型请求待聊天模块实现时再连接后端，API 密钥不得放入前端环境变量。

继续添加其他组件可在根目录运行（已有文件不要直接覆盖）：

```sh
pnpm dlx shadcn@latest add @ai-elements/<组件名> --cwd apps/web
```

## 国际化

当前页面使用 `i18next` / `react-i18next`，翻译资源位于 `apps/web/src/i18n/locales`。

- 启动时按 `navigator.languages` 的偏好顺序匹配，中文区域变体使用简体中文，英文区域变体使用英文；没有匹配语言时回退到英文。
- 页面跟随浏览器 `languagechange` 事件更新，同时同步 HTML `lang`、页面标题和描述；目前没有手动语言选择或账号语言设置。
- 登录、注册、导航、用户管理、管理占位页、404、会话提示和认证校验均已接入。错误状态保存翻译键，在渲染时翻译，语言变化后已有错误提示也会更新。
- 新文案先添加到 `en.ts`，再补齐 `zh-CN.ts`；TypeScript 校验键名和两种语言的键集合。组件中使用 `useTranslation()`，不要在模块顶层缓存翻译结果。
- 尚未接入聊天页面的 AI Elements 保留上游默认文案，接入聊天模块时再统一适配。服务端及 CLI 日志保持原样。

## 首次启动

需要 Node.js **22.12+**（推荐当前 LTS）、pnpm 10、PostgreSQL，以及一个已创建的空数据库。

```sh
pnpm install
cp .env.example .env
openssl rand -base64 32
```

编辑根目录 `.env`：

- `DATABASE_URL`：实际 PostgreSQL 连接串，不要指向其他应用的已有数据库。
- `BETTER_AUTH_SECRET`：填入上一步生成的随机值，至少 32 字符，不要提交到版本库。
- `BETTER_AUTH_URL=http://127.0.0.1:5173`：浏览器使用的应用地址，不是内部 API 端口。
- `WEB_ORIGIN=http://127.0.0.1:5173`：与浏览器地址一致；不要混用 `localhost` 和 `127.0.0.1`。
- `SERVER_PORT=3001`：API 监听端口。
- `ADMINS=admin`：逗号分隔的保留管理员用户名，例如 `admin,owner`；大小写统一为小写。

在项目根目录执行：

```sh
pnpm db:migrate
pnpm auth:create-admin
pnpm dev
```

初始化命令会交互询问用户名、邮箱和密码，密码隐藏输入且不写入配置；需要创建多个管理员时重复执行。用户名必须在 `ADMINS` 内。**没有默认密码，也不会通过公开注册自动授予管理员权限**。更改 `ADMINS` 只改变保留用户名，不自动修改已有账号角色；后续角色调整由 Better Auth admin 插件负责。

前端默认 `http://127.0.0.1:5173`，API 仅监听 `127.0.0.1:3001`。Vite 将 `/api` 转发至后端，同源 Cookie 不需要开发期跨域。端口占用时不会自动切换或结束其他进程；更换前端端口后同步修改 `BETTER_AUTH_URL`、`WEB_ORIGIN`，再用 `pnpm --filter @aime/web dev --port <新端口>` 启动前端。

### 开发启动与登录排查

在根目录运行 `pnpm dev` 或 `npm run dev` 均可同时启动前后端；后者内部仍调用 pnpm，因此仍需安装 pnpm。修改 `.env` 后，需要停止并重新启动开发服务，不能只刷新页面。

统一使用以下配置及访问地址：

```env
BETTER_AUTH_URL=http://127.0.0.1:5173
WEB_ORIGIN=http://127.0.0.1:5173
SERVER_PORT=3001
```

浏览器打开 `http://127.0.0.1:5173`。协议、主机名和端口必须与配置一致；`localhost` 与 `127.0.0.1` 属于不同来源。

- **登录或退出提示失败，后端出现 `Invalid origin`**：检查浏览器地址与上述两个认证配置是否一致，修正后重启服务。不要关闭来源校验或 CSRF 防护。
- **`环境配置无效 ... BETTER_AUTH_SECRET`**：密钥不能为空，且至少 32 字符。使用 `openssl rand -hex 32` 生成随机值并填入 `.env`；已有有效密钥无需重复生成。
- **`ECONNREFUSED 127.0.0.1:5432`**：该地址没有可连接的数据库服务，检查 PostgreSQL 是否启动及 `DATABASE_URL` 的端口、库名和凭据。
- **页面能打开，但 `/api/health` 失败**：只代表 Vite 已启动，后端可能仍因配置、数据库连接或未执行迁移而启动失败，应查看终端的 server 日志。

### 数据库重建与账号

项目不提供默认账号。清空认证表或更换数据库后，先执行 `pnpm db:migrate`，再执行 `pnpm auth:create-admin` 创建管理员；旧账号和登录会话不会恢复。

`pnpm db:migrate` 是初始化／增量迁移命令，不会清空已有数据。认证表结构以 `packages/auth/src/index.ts` 的 Better Auth 配置及插件为唯一来源，不保留手写认证迁移或 TypeORM 认证实体。认证表没有 `deleted_at`；用户删除使用 Better Auth 的硬删除，停用账号使用封禁。

开发数据库需要自行启动并通过 `DATABASE_URL` 配置。临时 PostgreSQL 不保证长期保留，正式开发请使用持久化数据库。重启服务不会修改密码；更改 `BETTER_AUTH_SECRET` 会使旧会话失效。

## 常用命令

| 命令                                | 用途                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                          | concurrently 启动前端和 API                              |
| `pnpm db:migrate`                   | 执行 Better Auth 认证迁移与 TypeORM 业务迁移，可重复运行 |
| `pnpm auth:create-admin`            | 通过 Better Auth admin 插件创建保留管理员                |
| `pnpm typecheck`                    | 工作区及脚本类型检查                                     |
| `pnpm lint`                         | ESLint                                                   |
| `pnpm format` / `pnpm format:check` | Prettier 格式化／检查                                    |
| `pnpm build`                        | 构建前后端                                               |
| `pnpm start`                        | 启动编译后的 API，不启动前端静态服务器                   |
| `pnpm test`                         | 单元测试；未提供测试库时明确跳过 PostgreSQL 集成测试     |

集成测试使用真实 PostgreSQL，在指定数据库内创建随机 schema，测试结束只删除该 schema，不操作已有业务表。建议使用专用测试数据库；测试账号需有创建 schema 的权限。

```sh
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/aime_hub_test pnpm test
```

覆盖：Better Auth 独立建表、插件字段与迁移幂等、TypeORM 业务实体一致性、注册、密码哈希、登录、会话、退出、多管理员、保留用户名、客户端提权拦截、服务端权限、跨来源拒绝和限流；以及管理员 HTTP 创建、重复账号拒绝、用户搜索/排序/分页、编辑、角色变更、密码重置、会话查询/撤销、封禁/解封、自我封禁/删除拒绝、硬删除及关联数据清理。

## 目录

前端页面按 `pages/<模块>/page.tsx` 组织，后台页面位于 `pages/admin/<模块>/`，专属组件、请求和 hooks 就近存放。跨页面认证逻辑放在 `features/auth`，应用布局放在 `layouts`。后端业务按 `modules/auth`、`health`、`providers`、`settings` 拆分，`app.ts` 负责组装。完整边界和目录见 [模块组织](docs/architecture.md)。

```text
apps/web/       Vite React UI
apps/server/    Express API
packages/auth/  Better Auth 工厂、插件、字段映射与官方迁移入口
packages/db/    TypeORM 业务实体、数据源及业务迁移
packages/shared/ 共享逻辑与仅服务端使用的环境加载
scripts/        迁移、管理员初始化、测试
```

PRD 中 `packages/db` 和 `packages/database` 的业务持久化职责统一放在 `packages/db`；认证结构由 `packages/auth` 内的 Better Auth 配置管理。数据库 `synchronize` 关闭，启动服务会检查认证表／字段／索引和业务迁移是否就绪，缺失时提示运行 `pnpm db:migrate`，不会自动修改表结构。业务实体使用 `@DeleteDateColumn` 保留软删除能力。

## 生产部署边界

1. 设置生产 `.env`（或注入环境变量），`NODE_ENV=production`，认证地址与 `WEB_ORIGIN` 必须为 HTTPS。
2. 先执行迁移，再构建并在根目录运行 `pnpm start`。进程在 pnpm 下从 `INIT_CWD` 读取根 `.env`；直接 `node apps/server/dist/index.js` 时需在根目录运行或注入环境变量。
3. 用 Web 服务器托管 `apps/web/dist`，为 SPA 路由提供 `index.html` 回退，并将同域 `/api/*` 代理至内部 API。
4. 生产 TLS 应由反向代理终止；不直接暴露内部 API。当前内存限流适合单实例，部署多实例前需配置共享限流存储。后端使用实际连接地址做限流，不信任客户端提交的代理头；默认代理部署会按代理地址共享额度。对公网部署前应在受控代理中清洗转发头，并配置可信代理及真实客户端 IP 解析，否则不同用户可能共用登录额度。
5. 本阶段没有邮箱验证、找回密码或邮件发送功能。注册邮箱只作为账号标识，不代表已验证邮箱所有权。需要对公网开放时，先按实际运营要求补齐邮件验证和注册防滥用策略。

## 当前验收范围

账号认证、用户管理、模型供应商管理已完成实现与测试。当前 69 项测试全部通过（含隔离 PostgreSQL 集成、供应商权限/密钥/同步/defaults、前端表单及长度预设），类型检查、Lint、生产构建通过；浏览器验证供应商/模型创建与编辑、模型抽屉及嵌套弹窗焦点恢复、长度预设/自定义/清空、默认配置保存及桌面/移动端响应式布局。上游模型接口使用受控 fixture 验证，未使用真实供应商密钥进行联网或收费推理测试。

本次修改文件通过格式检查；全仓格式检查仍报告已有 `.vscode/settings.json` 格式问题，未修改用户编辑器配置。页面已按路由懒加载，当前入口 JS 约 463 kB（gzip 约 149 kB），不再出现单块超过 500 kB 的提示；依赖库注释提示仍存在，不影响构建成功。

PRD 模型供应商项已勾选，等待用户验收确认后再进入下一阶段。聊天、项目、独立系统设置 CRUD、Mastra 等不在本阶段实现范围内。

模块整理与 UI 优化已通过类型检查、Lint、生产构建及 69 项测试（含隔离 PostgreSQL 集成）。浏览器验证了供应商搜索、模型抽屉及编辑弹窗取消后的焦点恢复、用户创建弹窗、移动端导航和桌面/390px 窄屏布局；本轮未提交界面中的数据变更，也未调用真实供应商同步或推理。
