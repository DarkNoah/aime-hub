mastra.ai 参照 \`/Volumes/Data/workspace/ui-dojo/\` 项目中后端的配置

要点 , 每个

## workspace 工作路径规则

个人聊天线程 `<WORKSPACE_ROOT>/users/<user_id>/<yyyy-MM-dd>-<uuid(6)>/`

项目聊天线程 `<WORKSPACE_ROOT>/projects/<project_id>/`

## 流式聊天

支持流式聊天, 页面管理后, 如果当前线程不要中断, 进入线程则恢复历史信息

## 获取聊天消息体

分页加载 <https://mastra.ai/docs/memory/message-history#messages>

## mastra.ai基本配置

启用 observational-memory <https://mastra.ai/docs/memory/observational-memory>
不使用mastra的apiRoutes能力,需要在 `api/threads/<threadId>` 接口中封装, 会在 <https://mastra.ai/integrations/agentic-ui/ai-sdk-ui>

## 获取模型

一个通用的接口, 获取当前聊天模型

getLanguageModel(...)

获取模型配置优先路径:
个人聊天: 优先 个人配置 > 系统默认模型 > 环境变量
项目聊天: 优先 项目元数据 > 系统默认模型 > 环境变量

## 聊天线程说明

> 使用mastra原生thread持久化处理
> ThreadId: 聊天线程唯一ID
> ResourceID: 识别线程归属, `user:<userID>` `project:<projectID>`
> metadata: 元数据中json保存 模型ID "model"

## 模型ID说明

`<providerId>/<modelID>`

## 模型ID说明

## 获取模型配置

getProviderOptions()

## 统一线程运行接口

一个线程运行的接口

```ts
// 创建线程
const thread = await threadService.startThread({
  threadId: "<threadId>",
  resourceId: "<resourceId>",
  workspace: "/path_to_workspace",
  model: getLanguageModel(...),
  reasoningEffort: "high",
  ...
});

// 所有消息的输入都是插入消息无论是用户输入还是系统自己输入, 立即(当前调用tool完成后立即插入), 队列(线程处于空闲/完成时插入)
await thread.run([
{
  type:'text',
  text:'xxx'
}],{
  isImmediate: false,
  ...
})
```
