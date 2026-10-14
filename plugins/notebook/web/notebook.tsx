import { useId, useRef, useState } from 'react';
import { useNotes, type Note } from './use-notes';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PageHeader,
  Textarea,
} from '@app/plugin-ui';
import { toast } from 'sonner';

export function Notebook({
  pluginId,
  compact = false,
}: {
  pluginId: string;
  compact?: boolean;
}) {
  const { notes, setNotes, loading, error, reload } = useNotes(pluginId);
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const note = await pluginRequest<Note>(pluginId, '/notes', {
        method: 'POST',
        body: JSON.stringify({ title, content }),
      });
      setNotes((current) => [note, ...current].slice(0, 50));
      setOpen(false);
      setTitle('');
      setContent('');
      toast.success('笔记已保存');
    } catch {
      toast.error('保存失败，请确认插件仍已启用后重试');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  async function remove(id: string) {
    if (deleting) return;
    setDeleting(id);
    try {
      await pluginRequest(pluginId, `/notes/${id}`, { method: 'DELETE' });
      setNotes((current) => current.filter((note) => note.id !== id));
      toast.success('笔记已删除');
    } catch {
      toast.error('删除失败，请重试');
    } finally {
      setDeleting(null);
    }
  }
  return (
    <div className="space-y-6">
      {compact ? (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted-foreground">
            随手记录想法，笔记与个人笔记页面同步。
          </p>
          <Button size="sm" className="w-full" onClick={() => setOpen(true)}>
            新建笔记
          </Button>
        </div>
      ) : (
        <PageHeader
          title="个人笔记"
          description="记录想法，也可以在聊天中选择「笔记助手」来查询和整理。"
          actions={<Button onClick={() => setOpen(true)}>新建笔记</Button>}
        />
      )}
      {loading ? (
        <p role="status">正在加载笔记…</p>
      ) : error ? (
        <div role="alert" className="space-y-3">
          <p>读取失败，请稍后重试。</p>
          <Button variant="outline" onClick={reload}>
            重试
          </Button>
        </div>
      ) : notes.length ? (
        <div className={compact ? 'grid gap-3' : 'grid gap-4 md:grid-cols-2'}>
          {notes.map((note) => (
            <article
              key={note.id}
              className={
                compact
                  ? 'space-y-3 rounded-xl border bg-background p-4'
                  : 'space-y-4 rounded-xl border bg-card p-5'
              }
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 font-medium [overflow-wrap:anywhere]">
                  {note.title}
                </h2>
                <Badge variant="secondary">个人</Badge>
              </div>
              <p className="text-sm whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                {note.content}
              </p>
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-xs text-muted-foreground">
                  {note.slug}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!deleting}
                  onClick={() => void remove(note.id)}
                >
                  删除
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <h2 className="font-medium">从第一条笔记开始</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            只有你能读取自己的笔记。
          </p>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!saving) setOpen(value);
        }}
      >
        <DialogContent>
          <form onSubmit={(event) => void save(event)} className="space-y-5">
            <DialogHeader>
              <DialogTitle>新建笔记</DialogTitle>
              <DialogDescription>
                保存后可在页面和笔记助手中查看。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor={`${formId}-title`}>标题</Label>
              <Input
                id={`${formId}-title`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={160}
                required
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${formId}-content`}>内容</Label>
              <Textarea
                id={`${formId}-content`}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                maxLength={10000}
                rows={6}
                required
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                disabled={saving}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={saving || !title.trim() || !content.trim()}
              >
                {saving ? '保存中…' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
