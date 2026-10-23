import { createTool } from '@mastra/core/tools';
import { PluginTool, type PluginContext } from '@app/plugin-sdk/server';
import { z } from 'zod';
import { newsIndustries } from '../../server/news/catalog.js';
import { parseNewsCursor } from '../../server/news/query.js';
import { StrategyError } from '../../server/strategies/schema.js';
import { quantToolContext, type QuantDependencies } from './context.js';

export class NewsSearchTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_news_search',
      title: '搜索量化资讯',
      description:
        '按标题或摘要搜索已采集资讯；留空查看最新资讯。返回来源、发布时间、正文状态和行业目录，每页 20 条；正文用 news_read 读取。',
      inputSchema: z.object({
        query: z.string().default(''),
        industry: z
          .string()
          .optional()
          .describe('行业名称或返回的行业 key，省略时查询全部'),
        cursor: z
          .string()
          .optional()
          .describe('上一页返回的 next_cursor，原样传回'),
      }),
      execute: (input, execution) =>
        run(execution, async ({ news, config }) => {
          let before;
          try {
            before = parseNewsCursor(input.cursor);
          } catch {
            throw new StrategyError('INVALID_NEWS_CURSOR');
          }
          const industry = input.industry?.trim();
          const category = industry
            ? newsIndustries.find(
                (item) => item.key === industry || item.name === industry,
              )
            : undefined;
          if (industry && !category)
            return {
              error: 'UNKNOWN_NEWS_INDUSTRY',
              industries: newsIndustries,
            };
          const page = await news.list({
            q: input.query.trim(),
            industry: category?.key,
            before,
            limit: 20,
          });
          return {
            articles: page.items.map((item) => ({
              id: item.id,
              title: item.title,
              summary: item.summary,
              url: item.url,
              source: item.sourceName,
              industry: item.industry,
              published_at: item.publishedAt,
              discovered_at: item.discoveredAt,
              content_status: item.contentStatus,
            })),
            next_cursor: page.nextCursor,
            industries: newsIndustries,
            sync_enabled: config.newsEnabled,
          };
        }),
    });
    super(tool);
  }
}

export class NewsReadTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_news_read',
      title: '读取资讯正文',
      description:
        '将 news_search 返回的资讯 id 作为 article_id，读取已保存正文、原文链接及采集状态。正文未就绪或不完整时如实说明，不触发新的抓取。',
      inputSchema: z.object({ article_id: z.string() }),
      execute: (input, execution) =>
        run(execution, async ({ news }) => {
          const article = await news.article(input.article_id);
          if (!article) throw new StrategyError('NEWS_NOT_FOUND', 404);
          return {
            article: {
              id: article.id,
              title: article.title,
              url: article.url,
              source: article.sourceName,
              industry: article.industry,
              published_at: article.publishedAt,
              discovered_at: article.discoveredAt,
              summary: article.summary,
              content: article.content,
              content_status: article.contentStatus,
              content_truncated: article.contentTruncated,
              content_error: article.contentError,
            },
          };
        }),
    });
    super(tool);
  }
}

export function createNewsTools(
  context: PluginContext,
  get: () => QuantDependencies,
) {
  return [new NewsSearchTool(context, get), new NewsReadTool(context, get)];
}
