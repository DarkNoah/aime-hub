mastra.ai 参照 \`/Volumes/Data/workspace/ui-dojo/\` 项目中后端的配置

## workspace 工作路径规则

个人聊天线程 `<WORKSPACE_ROOT>/users/<user_id>/<yyyy-MM-dd>-<nanoid(6)>/`

项目聊天线程 `<WORKSPACE_ROOT>/projects/<project_id>/`

## UI框架
统一使用 ai-elements 和 ai-sdk useChat接口 参照:`/Volumes/Data/workspace/ui-dojo/`


## 流式聊天

支持流式聊天, 页面关闭后, 如果当前线程在运行中不要中断, 进入线程则恢复历史信息并且实时流式显示, 是否使用缓存而不是读取数据库
如果是项目聊天线程, 多用户进入同一聊天线程时看到的所有消息应该都一致.





## 获取聊天消息体

分页加载 <https://mastra.ai/docs/memory/message-history#messages>

## mastra.ai基本配置

启用 observational-memory <https://mastra.ai/docs/memory/observational-memory>
不使用mastra的apiRoutes能力,需要在 `api/threads/<threadId>` 接口中封装, 会在 <https://mastra.ai/integrations/agentic-ui/ai-sdk-ui>

## 项目

创建 项目时 需要的参数 : id(nanoid(16), 自动配置无需用户设置), name
项目有项目成员的概念, 可以选择用户加入该项目中, 项目创建者创建时加入, 需要有项目成员角色 owner/admin/member/...


## 获取模型

一个通用的接口, 获取当前聊天模型

getLanguageModel(...)

获取模型配置优先路径:
个人聊天: 优先 个人配置 > 系统默认模型 
项目聊天: 优先 项目默认模型 > 系统默认模型

## 聊天线程说明

> 使用mastra原生thread持久化处理
> ThreadId: 聊天线程唯一ID
> ResourceID: 识别线程归属, `user:<userID>` `project:<projectID>`
> metadata: 元数据中json保存 模型ID "model", 创建者




## 模型ID说明

`<providerId>/<modelID>`


## 获取模型配置
主要是获得模型的思考是否开启和思考等级
每个供应商都有自己独立的 配置 如 https://mastra.ai/models/providers/deepseek#available-options
所以制作一个 const providerOptions = getProviderOptions({reasoningEffort: "xhigh"}) 来获得每个供应商的转换配置
得到 

```js
{
    openai: {
      reasoningContext: "auto",
      reasoningEffort: "xhigh" // 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' 
    },
    deepseek: {
      thinking: "enabled",
      reasoningEffort: "xhigh"
    }
}
```

## 统一线程运行接口

一个线程运行的接口

// 所有消息的输入都是插入消息无论是用户输入还是系统自己输入, 立即(运行中就当前调用tool完成后立即插入, 空闲时立即插入), 队列(线程处于空闲时插入)
// 用户输入的消息可能是图片, 文本混合, 还有思考等级, 模型id, ...

```ts
// 创建线程
const thread = await threadService.createThread({
  threadId: "<threadId>",
  resourceId: "<resourceId>",
  workspace: "/path_to_workspace",
  model: getLanguageModel(...),
  // reasoningEffort: "high",
  ...
});

const thread = await threadService.getThread(threadId);


await thread.run([
{
  type:'text',
  text:'xxx'
},...],{
  isImmediate: false,
  providerOptions,
  ...
});

await thread.abort();
```

## 多模态消息体
// 如果是图片等多模态需要包裹消息体, 没有实体路径的文件则不需要配置路径

```
{ type:'text', text: `<attachment id="File #${fileIndex}" path="${filePart.path}" name="${path.basename(filePart.path)}" size="${filesize(fs.statSync(filePart.path).size)}" mimeType="${mimeType || 'application/octet-stream'}" ${extInfo}>`}
{
  type: 'file',
  mediaType: 'image/jpeg',
  data: { type: 'data', data: readFileSync('./photo.jpg') },
}
{ type:'text', text: `</attachment>`}
{ type:'text', text: `分析这个图片`}
```






## skills说明

https://mastra.ai/docs/skills#filesystem-path-skills


全局级别共用skills:
路径下放置 `<WORKSPACE_ROOT>/.skills/` 支持多层目录skill识别,  如  `<WORKSPACE_ROOT>/.skills/owner/repo/<skill-name>/SKILL.md` 按SKILL.md为识别包, 分组使用 "owner/repo" 作为分组标识, skill-name 为skill id
个人级别skills:
路径下放置 `<WORKSPACE_ROOT>/users/<user_id>/.skills/`, 同上
项目级别skills:
路径下放置 `<WORKSPACE_ROOT>/projects/<project_id>/.skills/`, 同上

遇到相同id, 即不同级别但 `skill-name` 相同的, 个人/项目 级别的覆盖全局工具的skill


