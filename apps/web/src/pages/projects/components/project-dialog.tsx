import { useState } from 'react';
import { nanoid } from 'nanoid';
import { XIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  projectWorkspaceSchema,
  type ProjectSummary,
  type ProjectWorkspace,
} from '@aime/shared/projects';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { chatErrorKey } from '@/components/chat/api';
import { projectApi } from '../api';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function ProjectDialog({
  project,
  onClose,
  onSaved,
}: {
  project?: ProjectSummary;
  onClose: () => void;
  onSaved: (value: ProjectSummary) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(project?.name ?? '');
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<ProjectWorkspace['mode']>('simple');
  const [simple, setSimple] = useState<{ provider: 'local' | 'agentfs' }>({
    provider: 'local',
  });
  const [mounts, setMounts] = useState<MountDraft[]>(() => [
    {
      id: nanoid(),
      provider: 'local',
      mountPath: 'local',
    },
  ]);
  const [errors, setErrors] = useState<WorkspaceErrors>({});
  const [error, setError] = useState('');
  const issueMessage = (message: string) => {
    switch (message) {
      case 'projects.workspace.invalidMount':
        return t('projects.workspace.invalidMount');
      case 'projects.workspace.mountConflict':
        return t('projects.workspace.mountConflict');
      default:
        return t('projects.workspace.invalidField');
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 pr-14 text-left">
          <DialogTitle>
            {t(project ? 'projects.edit' : 'projects.create')}
          </DialogTitle>
          <DialogDescription>
            {t(project ? 'projects.nameHint' : 'projects.workspace.createHint')}
          </DialogDescription>
        </DialogHeader>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-3 right-3"
          aria-label={t('common.close')}
          disabled={pending}
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            const parsed = projectWorkspaceSchema.safeParse(
              mode === 'simple'
                ? { mode, ...simple }
                : {
                    mode,
                    mounts: mounts.map(({ provider, mountPath }) => ({
                      provider,
                      mountPath,
                    })),
                  },
            );
            if (!project && !parsed.success) {
              setErrors(
                Object.fromEntries(
                  parsed.error.issues.map((issue) => [
                    issue.path.join('.'),
                    issueMessage(issue.message),
                  ]),
                ),
              );
              return;
            }
            setErrors({});
            setError('');
            setPending(true);
            void (
              project
                ? projectApi.update(project.id, name.trim())
                : projectApi.create({
                    name: name.trim(),
                    workspace: parsed.success ? parsed.data : undefined,
                  })
            )
              .then((value) => {
                onSaved(value);
                toast.success(t('projects.saved'));
                onClose();
              })
              .catch((cause) => {
                const message = t(chatErrorKey(cause));
                setError(message);
                toast.error(message);
              })
              .finally(() => setPending(false));
          }}
        >
          <ScrollArea
            className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden"
            viewportProps={{ className: 'min-h-0 [&>div]:!block' }}
          >
            <fieldset
              disabled={pending}
              className="min-w-0 space-y-6 px-6 pt-1 pb-6 disabled:opacity-70"
            >
              <div className="space-y-2">
                <Label htmlFor="project-name">{t('projects.name')}</Label>
                <Input
                  id="project-name"
                  autoFocus
                  maxLength={120}
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {!project && (
                <ProjectWorkspaceFields
                  mode={mode}
                  simple={simple}
                  mounts={mounts}
                  errors={errors}
                  onModeChange={(value) => {
                    setMode(value);
                    setErrors({});
                  }}
                  onSimpleChange={(value) => {
                    setSimple(value);
                    setErrors({});
                  }}
                  onMountsChange={(value) => {
                    setMounts(value);
                    setErrors({});
                  }}
                />
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </fieldset>
          </ScrollArea>
          <DialogFooter className="shrink-0 border-t px-6 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('users.cancel')}
            </Button>
            <Button disabled={pending || !name.trim()}>
              {t(
                pending
                  ? 'users.saving'
                  : project
                    ? 'users.save'
                    : 'projects.create',
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Storage = { provider: 'local' | 'agentfs' };
type MountDraft = Storage & { id: string; mountPath: string };
type WorkspaceErrors = Record<string, string>;

function availableMountName(mounts: MountDraft[], base = 'local') {
  let name = base;
  let suffix = 2;
  while (
    mounts.some((mount) => mount.mountPath.toLowerCase() === name.toLowerCase())
  ) {
    name = `${base}-${suffix++}`;
  }
  return name;
}

function ProjectWorkspaceFields({
  mode,
  onModeChange,
  simple,
  onSimpleChange,
  mounts,
  onMountsChange,
  errors,
}: {
  mode: ProjectWorkspace['mode'];
  onModeChange: (mode: ProjectWorkspace['mode']) => void;
  simple: Pick<Storage, 'provider'>;
  onSimpleChange: (value: Pick<Storage, 'provider'>) => void;
  mounts: MountDraft[];
  onMountsChange: (value: MountDraft[]) => void;
  errors: WorkspaceErrors;
}) {
  const { t } = useTranslation();
  return (
    <section className="min-w-0 space-y-3" aria-labelledby="workspace-heading">
      <h3 id="workspace-heading" className="text-sm font-medium">
        {t('projects.workspace.title')}
      </h3>
      <Tabs
        value={mode}
        onValueChange={(value) =>
          onModeChange(value as ProjectWorkspace['mode'])
        }
        className="gap-4"
      >
        <TabsList className="w-full">
          <TabsTrigger value="simple">
            {t('projects.workspace.simple')}
          </TabsTrigger>
          <TabsTrigger value="composite">
            {t('projects.workspace.composite')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="simple" className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="workspace-simple-provider">
              {t('projects.workspace.provider')}
            </Label>
            <Select
              value={simple.provider}
              onValueChange={(provider: Storage['provider']) =>
                onSimpleChange({ provider })
              }
            >
              <SelectTrigger id="workspace-simple-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">LocalFilesystem</SelectItem>
                <SelectItem value="agentfs">AgentFS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm text-muted-foreground">
            {t(
              simple.provider === 'local'
                ? 'projects.workspace.localHint'
                : 'projects.workspace.agentfsHint',
            )}
          </p>
        </TabsContent>
        <TabsContent value="composite" className="min-w-0 space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('projects.workspace.compositeHint')}
          </p>
          <div className="divide-y rounded-lg border px-4">
            {mounts.map((mount, index) => {
              const id = `workspace-mount-${mount.id}`;
              const error = errors[`mounts.${index}.mountPath`];
              return (
                <div
                  key={mount.id}
                  className="grid min-w-0 items-start gap-4 py-4 sm:grid-cols-[180px_minmax(0,1fr)]"
                >
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-provider`}>
                      {t('projects.workspace.provider')}
                    </Label>
                    <Select
                      value={mount.provider}
                      onValueChange={(provider: Storage['provider']) =>
                        onMountsChange(
                          mounts.map((item) =>
                            item.id === mount.id ? { ...item, provider } : item,
                          ),
                        )
                      }
                    >
                      <SelectTrigger id={`${id}-provider`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">LocalFilesystem</SelectItem>
                        <SelectItem value="agentfs">AgentFS</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end gap-3">
                    <div className="min-w-0 flex-1 space-y-2">
                      <Label htmlFor={`${id}-mount`}>
                        {t('projects.workspace.mountPath')}
                      </Label>
                      <Input
                        id={`${id}-mount`}
                        value={mount.mountPath}
                        placeholder="data"
                        maxLength={64}
                        aria-invalid={!!error}
                        aria-describedby={error ? `${id}-error` : undefined}
                        onChange={(event) =>
                          onMountsChange(
                            mounts.map((item) =>
                              item.id === mount.id
                                ? { ...item, mountPath: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={mounts.length === 1}
                      aria-label={t('projects.workspace.removeMount', {
                        number: index + 1,
                      })}
                      onClick={() =>
                        onMountsChange(
                          mounts.filter((item) => item.id !== mount.id),
                        )
                      }
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                  {error && (
                    <p
                      id={`${id}-error`}
                      className="text-sm text-destructive sm:col-span-2"
                    >
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={mounts.length >= 16}
            onClick={() =>
              onMountsChange([
                ...mounts,
                {
                  id: nanoid(),
                  provider: 'local',
                  mountPath: availableMountName(mounts),
                },
              ])
            }
          >
            <PlusIcon className="size-4" />
            {t('projects.workspace.addMount')}
          </Button>
        </TabsContent>
      </Tabs>
      <p className="text-xs text-muted-foreground">
        {t('projects.workspace.automaticHint')}
      </p>
    </section>
  );
}
