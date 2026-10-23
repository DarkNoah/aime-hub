import { Badge } from '@app/plugin-ui';
import type { NewsSummary } from '../../news-types';
export function newsError(code: string) {
  const messages: Record<string, string> = {
    WECHAT_VERIFICATION_REQUIRED: '微信要求验证码或环境验证，未取得正文',
    WECHAT_ARTICLE_UNAVAILABLE: '微信文章已失效、删除或限制访问',
    WECHAT_CONTENT_MISSING: '微信页面缺少有效正文',
    ARTICLE_INCOMPLETE: '正文不完整，需要重新读取',
    ARTICLE_TIMEOUT: '正文读取超时',
    ARTICLE_VERIFICATION_REQUIRED: '网站要求验证码或人机验证，未取得正文',
    REQUEST_FAILED: '网络请求失败',
    FETCH_FAILED: '正文读取失败',
    WEB_FETCH_FAILED: '正文读取失败',
    TOO_LARGE: '响应超过安全读取上限，未保存部分正文',
    INVALID_FEED_XML: '响应不是有效的 RSS/Atom 订阅',
  };
  const key = code.replace(/^RSS_/, '');
  return (
    messages[key] ??
    (/(?:FEED|ARTICLE)_HTTP_\d+/.test(key)
      ? `${key.startsWith('FEED') ? '订阅' : '正文'}请求返回 HTTP ${key.split('_').at(-1)}`
      : code)
  );
}

export function newsTime(value: number | null | undefined) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(value * 1000)
    : '未提供';
}
export function ContentBadge({ article }: { article: NewsSummary }) {
  return (
    <Badge
      variant={article.contentStatus === 'failed' ? 'destructive' : 'secondary'}
      className="shrink-0 text-[11px]"
    >
      {article.contentStatus === 'ready'
        ? article.contentTruncated
          ? '等待完整正文'
          : '正文已保存'
        : article.contentStatus === 'failed'
          ? '正文待重试'
          : '正文采集中'}
    </Badge>
  );
}
