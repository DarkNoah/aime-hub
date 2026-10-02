## 目录组织

- 前端 `apps/web/src/pages/` 按业务模块分文件夹，页面及其专属组件、逻辑就近组织。
- 判断组件是否可共用, 放置在前端项目 `apps/web/src/components/` 下
- 后端也按业务模块分文件夹，避免业务代码集中平铺。
- 多处使用的交互应提取为可复用组件，例如模型选择器。

## UI 组件与展示
- 尽量使用 shacdn ai-elements reactbits UI组件库而非自己实现
- Item 类 编辑尽量使用 shadcn  `Dialog` 或 `Sheet` 组件，实现对表单的编辑/创建。
- 统一使用 sonner 的 toast 来进行修改成功/错误的通知展示
- 注重 UI 美化和组件风格的一致性。
- 状态用 `Badge` 表示。
- 的启用／停用操作使用 `Switch`。
- 尽量更改某个表格中的Item时全部刷新数据, 只更新该Item数据, 否则会导致页码重置或滚动重置
- 密码输入统一使用 `PasswordInput` 组件

## 其他要点
- 尽量不要使用aime的关键字进行类的命名或cookie之类的前序命名组件中的字符串等