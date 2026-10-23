import { useId, useState, type FormEvent } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@app/plugin-ui';
import { toast } from 'sonner';
import type { NewsIndustry, NewsSourceView } from '../../news-types';

export function SourceEditor({
  pluginId,
  source,
  industries,
  onSave,
  onClose,
}: {
  pluginId: string;
  source?: NewsSourceView;
  industries: NewsIndustry[];
  onSave(source: NewsSourceView): void;
  onClose(): void;
}) {
  const id = useId();
  const [name, setName] = useState(source?.name ?? '');
  const [url, setUrl] = useState(source?.url ?? '');
  const [industry, setIndustry] = useState(
    source?.industry ?? industries[0]?.key ?? '',
  );
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [contentMode, setContentMode] = useState<'page' | 'feed'>(
    source?.contentMode ?? 'page',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await pluginRequest<NewsSourceView>(
        pluginId,
        source ? `/news/sources/${source.id}` : '/news/sources',
        {
          method: source ? 'PATCH' : 'POST',
          body: JSON.stringify({
            name: name.trim(),
            url: url.trim(),
            industry,
            enabled,
            contentMode,
          }),
        },
      );
      onSave(result);
      toast.success(source ? '资讯源已更新' : '资讯源已添加');
      onClose();
    } catch (reason) {
      const message =
        reason instanceof Error && reason.message === 'SOURCE_CONFLICT'
          ? '该 RSS 地址已存在，请编辑已有来源。'
          : '保存失败，请检查名称、分类和 HTTP(S) RSS 地址。';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{source ? '编辑资讯源' : '新增资讯源'}</DialogTitle>
          <DialogDescription>
            填写 RSS 或 Atom 订阅地址，启用后会在后台采集。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>名称</Label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-url`}>RSS 地址</Label>
            <Input
              id={`${id}-url`}
              type="url"
              placeholder="https://example.com/feed.xml"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-industry`}>分类</Label>
            <Select value={industry} onValueChange={setIndustry}>
              <SelectTrigger id={`${id}-industry`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {industries.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-content`}>正文来源</Label>
            <Select
              value={contentMode}
              onValueChange={(value) =>
                setContentMode(value as 'page' | 'feed')
              }
            >
              <SelectTrigger id={`${id}-content`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="page">读取原文网页</SelectItem>
                <SelectItem value="feed">仅保存 RSS 自带正文</SelectItem>
              </SelectContent>
            </Select>
            {contentMode === 'feed' ? (
              <p className="text-xs text-muted-foreground">
                仅保存带正文字段的条目；只有摘要或正文为空时跳过，不补抓原文网页。
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor={`${id}-enabled`}>启用采集</Label>
            <Switch
              id={`${id}-enabled`}
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
