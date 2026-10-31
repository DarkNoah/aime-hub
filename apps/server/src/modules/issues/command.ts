import type { IssueState } from '@aime/shared/issues';

export const issueHelp = `issue list [--state open|all|decision|todo|in_progress|done] [--cursor 123] [--limit 30]
issue create --title "任务标题" --body "任务与验收标准" [--state todo|decision] [--start]
issue view 123 [--cursor 评论游标]
issue edit 123 [--title "新标题"] [--body "新描述"] [--state decision|todo|in_progress|done] [--message "继续执行的指令" --delivery wait|immediate] [--stop]
issue close 123
issue reopen 123
issue comment 123 --body "评论"
issue help
范围自动绑定当前个人/项目聊天，不能通过命令跨范围访问。create 默认仅创建任务线程；--start 会提交任务。评论不执行任务。edit --message 加入原生消息队列，wait 等待当前执行结束，immediate 立即处理。--stop 中止执行、清空队列并回到待办。close 标记完成并保留线程，不中断当前回复。`;

type Action =
  'list' | 'create' | 'view' | 'edit' | 'close' | 'reopen' | 'comment' | 'help';
const options: Record<Action, string[]> = {
  list: ['state', 'cursor', 'limit'],
  create: ['title', 'body', 'state', 'start'],
  view: ['cursor'],
  edit: ['title', 'body', 'state', 'message', 'delivery', 'stop'],
  close: [],
  reopen: [],
  comment: ['body'],
  help: [],
};
type Token = { value: string; quoted: boolean };
/** Parse only text. Shell expansion, filesystem access and execution are never used. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let value = '',
    quote = '',
    quoted = false,
    started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (
      char === '\\' &&
      quote !== "'" &&
      i + 1 < command.length &&
      /[\\"'\s]/.test(command[i + 1]!)
    ) {
      value += command[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push({ value, quoted });
      value = '';
      quoted = false;
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (quote) throw new Error('引号未闭合');
  if (started) tokens.push({ value, quoted });
  return tokens;
}

export function parseIssueState(value: string): IssueState {
  const aliases: Record<string, IssueState> = {
    decision: 'decision',
    待决策: 'decision',
    todo: 'todo',
    待办: 'todo',
    in_progress: 'in_progress',
    'in-progress': 'in_progress',
    进行中: 'in_progress',
    done: 'done',
    closed: 'done',
    已完成: 'done',
  };
  const state = Object.hasOwn(aliases, value) ? aliases[value] : undefined;
  if (!state) throw new Error('状态应为 decision、todo、in_progress 或 done');
  return state;
}

export function parseIssueCommand(command: string) {
  const tokens = tokenize(command.trim());
  if (tokens[0]?.value === 'issue') tokens.shift();
  const action = (tokens.shift()?.value ?? 'help') as Action;
  if (!Object.hasOwn(options, action)) throw new Error('未知命令，请使用 help');
  let id: number | undefined;
  if (['view', 'edit', 'close', 'reopen', 'comment'].includes(action)) {
    const value = tokens.shift()?.value.replace(/^#/, '') ?? '';
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error('请提供有效的 Issue 编号，例如 view 123');
    id = Number(value);
  }
  const values: Record<string, string> = {};
  while (tokens.length) {
    const token = tokens.shift()!;
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(token.value);
    if (!match || !options[action].includes(match[1]!))
      throw new Error(`不支持的参数：${token.value}`);
    const key = match[1]!;
    if (Object.hasOwn(values, key)) throw new Error(`重复参数：--${key}`);
    if (key === 'stop' || key === 'start') {
      if (match[2] !== undefined) throw new Error(`--${key} 不接受参数值`);
      values[key] = 'true';
      continue;
    }
    const parts = match[2] !== undefined ? [match[2]] : [];
    while (
      tokens.length &&
      (tokens[0]!.quoted || !tokens[0]!.value.startsWith('--'))
    )
      parts.push(tokens.shift()!.value);
    if (!parts.length) throw new Error(`--${key} 缺少参数值`);
    values[key] = parts.join(' ');
  }
  if (action === 'create' && !values.title?.trim())
    throw new Error('create 需要 --title');
  if (action === 'comment' && !values.body?.trim())
    throw new Error('comment 需要 --body');
  if (action === 'edit' && !Object.keys(values).length)
    throw new Error('edit 需要至少一个修改参数');
  if (
    values.state &&
    !(action === 'list' && ['open', 'all'].includes(values.state))
  )
    values.state = parseIssueState(values.state);
  if (values.delivery && !['wait', 'immediate'].includes(values.delivery))
    throw new Error('--delivery 应为 wait 或 immediate');
  if (values.delivery && !values.message)
    throw new Error('--delivery 需要与 --message 一起使用');
  if (values.stop && values.message)
    throw new Error('--stop 不能与 --message 同时使用');
  if (values.stop && values.state && values.state !== 'todo')
    throw new Error('--stop 会回到待办，请不要同时指定其他状态');
  if (values.state === 'done' && (values.message || values.start))
    throw new Error('已完成的 Issue 需要 reopen 后才能执行');
  if (values.message !== undefined && !values.message.trim())
    throw new Error('--message 不能为空');
  for (const key of action === 'list'
    ? ['cursor', 'limit']
    : action === 'view'
      ? ['cursor']
      : [])
    if (
      values[key] &&
      (!/^[1-9]\d*$/.test(values[key]) ||
        !Number.isSafeInteger(Number(values[key])))
    )
      throw new Error(`--${key} 需要正整数`);
  return { action, id, values };
}
