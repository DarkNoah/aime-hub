---
name: 'Aime Hub'
description: '项目协作台的双主题、文字层级与共享控件'
colors:
  background: '#f7f9f8'
  foreground: '#202d25'
  card: '#ffffff'
  primary: '#2d6348'
  primary-foreground: '#ffffff'
  secondary: '#eef2ef'
  secondary-foreground: '#3f4942'
  muted: '#f1f4f2'
  muted-foreground: '#5e6b63'
  accent: '#e6eee9'
  accent-foreground: '#263e32'
  destructive: '#b42332'
  destructive-foreground: '#ffffff'
  border: '#e0e6e2'
  input: '#d4ddd6'
  ring: '#416c53'
  sidebar: '#eef2f0'
  feature-surface: '#244b38'
  selection: '#dce9d8'
  selection-foreground: '#203729'
  dark-background: '#141917'
  dark-foreground: '#e5eee8'
  dark-card: '#1b231f'
  dark-primary: '#99c8a7'
  dark-primary-foreground: '#14251a'
  dark-secondary: '#25352b'
  dark-secondary-foreground: '#dce9e0'
  dark-muted: '#202e25'
  dark-muted-foreground: '#a5b7aa'
  dark-accent: '#2c4032'
  dark-accent-foreground: '#e3f1e7'
  dark-destructive: '#ed8493'
  dark-destructive-foreground: '#321219'
  dark-border: '#34413a'
  dark-input: '#43594a'
  dark-ring: '#99c8a7'
  dark-sidebar: '#171e1a'
  dark-feature-surface: '#254936'
  dark-selection: '#3b5e45'
  dark-selection-foreground: '#f0f8f2'
typography:
  headline:
    fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', ui-sans-serif, system-ui, sans-serif"
    fontSize: '1.5rem'
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', ui-sans-serif, system-ui, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 500
    lineHeight: '1.25rem'
  body:
    fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', ui-sans-serif, system-ui, sans-serif"
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.5
  description:
    fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', ui-sans-serif, system-ui, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: '1.5rem'
  label:
    fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', ui-sans-serif, system-ui, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 500
    lineHeight: 1
  caption:
    fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', ui-sans-serif, system-ui, sans-serif"
    fontSize: '0.75rem'
    fontWeight: 400
    lineHeight: '1rem'
rounded:
  sm: '6px'
  md: '8px'
  lg: '10px'
  xl: '14px'
  pill: '9999px'
spacing:
  1: '0.25rem'
  2: '0.5rem'
  3: '0.75rem'
  4: '1rem'
  5: '1.25rem'
  6: '1.5rem'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.primary-foreground}'
    rounded: '{rounded.md}'
    height: '2.25rem'
    padding: '0.5rem 1rem'
  button-secondary:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.secondary-foreground}'
    rounded: '{rounded.md}'
    height: '2.25rem'
    padding: '0.5rem 1rem'
  button-outline:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    height: '2.25rem'
    padding: '0.5rem 1rem'
  button-ghost:
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    height: '2.25rem'
    padding: '0.5rem 1rem'
  button-destructive:
    backgroundColor: '{colors.destructive}'
    textColor: '{colors.destructive-foreground}'
    rounded: '{rounded.md}'
    height: '2.25rem'
    padding: '0.5rem 1rem'
  button-link:
    textColor: '{colors.primary}'
    rounded: '{rounded.md}'
    height: '2.25rem'
    padding: '0.5rem 1rem'
  input:
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    height: '2.25rem'
    padding: '0.25rem 0.75rem'
  nav-active:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.primary}'
    rounded: '{rounded.lg}'
    height: '2.25rem'
    padding: '0 0.75rem'
  badge-secondary:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.secondary-foreground}'
    rounded: '{rounded.pill}'
    padding: '0.125rem 0.5rem'
  card:
    backgroundColor: '{colors.card}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.xl}'
    padding: '1.5rem 0'
---

# Aime Hub 设计规范

## Overview

**Creative North Star: "项目协作台"**

成员从项目里的对话标题和更新时间找到上次讨论，再打开共享文件核对内容。首屏把空间留给项目名称、对话和常用操作。成员管理放在侧面板里，关闭后仍能看见原来的项目列表。

同一套界面也用于个人聊天和管理后台。并排比较多条记录时，用对齐、分隔线和简短标签组织信息。在窄屏上让导航收进抽屉，让项目名称、正文和操作保有足够空间。

**Key Characteristics:**

- 选中的导航项同时改变底色、文字颜色和字重。
- 项目对话行将标题与更新时间放在一起，活动状态和管理操作单独对齐。
- 明暗主题按同一组语义角色配色，主操作、输入焦点和错误都能区分。

## Colors

浅色主题在灰绿色画布上铺白色内容面，深色主题用深绿灰区分侧栏、内容和弹层。上方颜色表的无前缀键对应浅色值，`dark-` 前缀对应同一角色在深色下的值。实现时使用 `bg-primary`、`text-foreground` 等语义样式，切换由应用根元素的 `.dark` 控制。

| 界面位置           | 颜色角色与用途                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 项目与对话的主操作 | `primary` 搭配 `primary-foreground`。创建对话或提交表单时使用实色按钮。                                                       |
| 侧栏导航           | `sidebar` 区分导航与正文。顶层当前项使用 `accent` 底、`primary` 文字和半粗体。展开项目内的 Bot 快捷入口使用 `card` 底。       |
| 内容、说明与分隔   | `background` 承载页面，`card` 承载独立面板，`foreground` 显示文件名和正文。更新时间用 `muted-foreground`，分隔线用 `border`。 |
| 成员角色与次要操作 | `secondary` 搭配 `secondary-foreground`，适合只读角色徽章和次按钮。                                                           |
| 输入与反馈         | `input` 勾出字段边界，`ring` 表示键盘焦点。危险操作用 `destructive` 搭配文字标签，校验失败同时提供错误说明。                  |

**The Paired Color Rule.** 同时使用相应的背景与前景角色。深色主题会替换两者，主按钮上的文字也随之变深。

## Typography

界面共用一套无衬线字体。西文优先 Inter，中文依次回退到苹方、微软雅黑和系统字体。项目名称、对话标题和成员角色的层次主要来自字号、字重和位置。基础字号以 16px 为准。

| 角色     | 字号 / 行高 / 字重 | 用例                                         |
| -------- | ------------------ | -------------------------------------------- |
| 页面标题 | 24px / 30px / 600  | 共用 PageHeader 中的项目名称或设置页标题     |
| 列表标题 | 14px / 20px / 500  | 项目对话标题，过长时在列表内单行截断         |
| 说明文字 | 14px / 24px / 400  | 页头说明，宽度上限 42rem                     |
| 表单标签 | 14px / 14px / 500  | 字段名称，与输入值分行                       |
| 辅助信息 | 12px / 16px / 400  | 更新时间。徽章使用相同字号，字重提高到 500。 |

登录页单独使用更大的标题，窄屏 30px，从 640px 起为 34px。普通字段在 768px 以下保留 16px 输入字号，宽屏收至 14px。标题允许自然换行，按钮标签应直接写出要执行的动作。

## Elevation

主布局用背景色、留白和 1px 边界区分区域。标准 Card 以边框界定内容，常规输入框与描边按钮使用很轻的 `shadow-xs`。Dialog 使用 `shadow-lg`，并以 50% 黑色遮罩保留原页面的轮廓。

导航交互的颜色过渡为 180ms。对话框、侧面板和弹出菜单通常以 200ms 打开、150ms 关闭。遵循系统减少动态效果的偏好，保留颜色、焦点和文本反馈。

**The Overlay Rule.** 让阴影只承担层级提示。连续的对话行使用分隔线，编辑弹窗通过遮罩和投影与原页面分开。

## Components

### 页面与导航

桌面主侧栏宽 240px，从 768px 起常驻。窄屏通过左侧 Sheet 打开导航，宽度以 288px 和视口宽度减 32px 的较小值为准。顶层导航行高 36px，图标与文字间距 12px。项目页标题与操作组可分别换行，单条对话的管理菜单紧贴对应行。

### 按钮与字段

标准按钮高 36px、圆角 8px，文字按钮水平内边距 16px。带图标时收至 12px。主操作用实色，成员与设置等并列入口用描边，行尾菜单用低强调度的图标按钮并提供可读名称。共享 Input 同样高 36px、圆角 8px，横向内边距 12px。两者都用 3px 焦点环，禁用时减至 50% 不透明度。登录提交按钮在此基础上加高至 44px。

### 对话、文件与成员

项目页以分隔线排列对话，行内上下各留 16px。先读标题，再读更新时间。活动状态与更多操作各有位置。共享文件沿用 FileManager 的文件树、文件动作与预览。长文件名应能在详情或预览中核对。成员列表放在 Sheet 中，有管理权限时才提供对应的角色选择或移除动作，只读角色用次要 Badge 展示。

### 容器、状态与编辑

标准 Card 圆角 14px，上下内边距 24px，标题、正文和页脚各自提供 24px 横向内边距。Badge 用 12px 中等字重和胶囊轮廓呈现简短状态。启用和停用使用 Switch。创建或编辑单条记录时复用 Dialog 或 Sheet。表单较长时让字段区滚动，确保提交操作在手机上可达。

## Do's and Don'ts

### Do

- 沿用项目的共享模型选择器、PasswordInput 和 ScrollArea，让跨页面的交互一致。
- 保存单条记录后就地更新该行，用 Sonner 提示结果，保留页码、滚动位置和输入上下文。
- 在空列表给出适合当前权限的下一步，在加载、失败和无权限时分别说明状态。

### Don't

- 避免用虚构统计、示例项目或模拟聊天填充页面。
- 避免把尚未实现的功能画成可点击入口。需要展示时明确标注待开放。
- 避免装饰抢占管理界面的内容空间，例如给每条对话单独包一层投影卡片。

实现依据见 [主题样式](apps/web/src/index.css)、[共享控件](apps/web/src/components/ui/)、[项目页](apps/web/src/pages/projects/project-page.tsx) 和 [成员面板](apps/web/src/pages/projects/components/members-sheet.tsx)。
