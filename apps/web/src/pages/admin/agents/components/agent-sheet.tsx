import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, LoaderCircle, Search, X } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  agentInputSchema,
  type AgentCatalog,
  type ManagedAgent,
} from '@aime/shared/agents';
import type { InstalledSkill } from '@aime/shared/skills';
import { api } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';
import { ModelSelector } from '@/components/model-selector';
import { InstalledSkillsList } from '@/components/skills/installed-skills-list';
import { toggleSkills } from '@/components/skills/selection';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { agentErrorKey } from '../api';

type Field =
  | 'name'
  | 'description'
  | 'instructions'
  | 'model'
  | 'tools'
  | 'disabledTools'
  | 'skillsMode'
  | 'skillPaths'
  | 'form';

export function AgentSheet({
  agent,
  onClose,
  onSaved,
  restoreFocus,
}: {
  agent?: ManagedAgent;
  onClose: () => void;
  onSaved: (agent: ManagedAgent) => void;
  restoreFocus: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [instructions, setInstructions] = useState(agent?.instructions ?? '');
  const [model, setModel] = useState<string | null>(agent?.model ?? null);
  const [skillPaths, setSkillPaths] = useState(agent?.skillPaths ?? []);
  const [skillsMode, setSkillsMode] = useState<'auto' | 'custom'>(
    agent?.skillsMode ?? 'auto',
  );
  const [disabledTools, setDisabledTools] = useState(
    agent?.disabledTools ?? [],
  );
  const [catalog, setCatalog] = useState<AgentCatalog>();
  const [catalogError, setCatalogError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  const [errors, setErrors] = useState<Partial<Record<Field, TranslationKey>>>(
    {},
  );
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState('general');
  const [search, setSearch] = useState('');
  const submitting = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void api.agents.catalog(undefined, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) {
          setCatalog(value);
          setCatalogError(undefined);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setCatalogError(agentErrorKey(error));
      },
    );
    return () => controller.abort();
  }, [revision]);

  function selectSkills(skills: InstalledSkill[], checked: boolean) {
    setSkillPaths((current) => [
      ...toggleSkills(new Set(current), skills, checked),
    ]);
  }

  function hint(field: Field) {
    return errors[field] ? (
      <p
        id={`agent-${field}-error`}
        role="alert"
        className="text-xs text-destructive"
      >
        {t(errors[field])}
      </p>
    ) : null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !catalog) return;
    const parsed = agentInputSchema.safeParse({
      name,
      description,
      instructions,
      model,
      tools: agent?.tools ?? [],
      disabledTools,
      skillsMode,
      skillPaths: skillsMode === 'custom' ? skillPaths : [],
    });
    setErrors({});
    if (!parsed.success) {
      const next: typeof errors = {};
      const keys: Record<string, TranslationKey> = {
        name: 'agents.nameInvalid',
        description: 'agents.descriptionInvalid',
        instructions: 'agents.instructionsInvalid',
        model: 'agents.modelUnavailable',
        tools: 'agents.invalid',
        disabledTools: 'agents.invalid',
        skillsMode: 'agents.invalid',
        skillPaths: 'agents.skillUnavailable',
      };
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]) as Field;
        next[field] = keys[field] ?? 'agents.invalid';
      }
      setErrors(next);
      setTab(
        next.name || next.description || next.model
          ? 'general'
          : next.instructions
            ? 'prompt'
            : 'resources',
      );
      return;
    }
    submitting.current = true;
    setPending(true);
    try {
      const saved = agent
        ? await api.agents.update({
            params: { id: agent.id },
            body: { ...parsed.data, versionId: agent.versionId },
          })
        : await api.agents.create({ body: parsed.data });
      onSaved(saved);
      toast.success(t(agent ? 'agents.updated' : 'agents.created'));
      onClose();
    } catch (error) {
      const key = agentErrorKey(error);
      const field =
        key === 'agents.modelUnavailable'
          ? 'model'
          : key === 'agents.skillUnavailable'
            ? 'skillPaths'
            : 'form';
      setErrors({ [field]: key });
      if (field === 'model') setTab('general');
      if (field === 'skillPaths') setTab('resources');
      toast.error(t(key));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  const missing = skillPaths.filter(
    (path) => !catalog?.skills.some((skill) => skill.path === path),
  );
  const visibleSkills =
    catalog?.skills.filter((skill) =>
      `${skill.name} ${skill.path} ${skill.description}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
    ) ?? [];

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <SheetContent
        className="w-full gap-0 sm:max-w-2xl"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (submitting.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <header className="space-y-2 border-b p-6 pr-16">
          <SheetTitle>{t(agent ? 'agents.edit' : 'agents.create')}</SheetTitle>
          <SheetDescription>{t('agents.scopeHint')}</SheetDescription>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-4 top-5"
            disabled={pending}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X />
          </Button>
        </header>
        <form
          onSubmit={submit}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
        >
          <Tabs
            value={tab}
            onValueChange={setTab}
            className="min-h-0 flex-1 gap-0"
          >
            <div className="px-6 pt-5 pb-3">
              <TabsList className="w-full">
                <TabsTrigger value="general">{t('agents.general')}</TabsTrigger>
                <TabsTrigger value="prompt">
                  {t('agents.instructions')}
                </TabsTrigger>
                <TabsTrigger value="resources">
                  {t('agents.resources')}
                </TabsTrigger>
              </TabsList>
            </div>
            <ScrollArea
              className="min-h-0 flex-1"
              viewportProps={{ className: '[&>div]:block!' }}
            >
              <fieldset disabled={pending} className="min-w-0 px-6 pt-3 pb-6">
                <TabsContent value="general" className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="agent-name">{t('agents.name')}</Label>
                    <Input
                      id="agent-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={100}
                      aria-invalid={!!errors.name}
                      aria-describedby={
                        errors.name ? 'agent-name-error' : undefined
                      }
                      placeholder={t('agents.namePlaceholder')}
                    />
                    {hint('name')}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="agent-description">
                      {t('agents.description')}
                    </Label>
                    <Textarea
                      id="agent-description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      maxLength={1000}
                      className="min-h-24"
                      aria-invalid={!!errors.description}
                      aria-describedby={
                        errors.description
                          ? 'agent-description-error'
                          : undefined
                      }
                    />
                    {hint('description')}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="agent-model">{t('agents.model')}</Label>
                    <ModelSelector
                      id="agent-model"
                      label={t('agents.model')}
                      textOnly
                      allowNone
                      noneLabel={t('agents.followModel')}
                      value={model}
                      onValueChange={setModel}
                      disabled={pending}
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t('agents.modelHint')}
                    </p>
                    {hint('model')}
                  </div>
                </TabsContent>
                <TabsContent value="prompt" className="space-y-3">
                  <Label htmlFor="agent-instructions">
                    {t('agents.instructions')}
                  </Label>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t('agents.instructionsHint')}
                  </p>
                  <Textarea
                    id="agent-instructions"
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    maxLength={24000}
                    className="min-h-80 font-mono text-sm leading-6"
                    spellCheck={false}
                    placeholder={t('agents.instructionsPlaceholder')}
                    aria-invalid={!!errors.instructions}
                    aria-describedby={
                      errors.instructions
                        ? 'agent-instructions-error'
                        : undefined
                    }
                  />
                  <p className="text-right text-xs tabular-nums text-muted-foreground">
                    {instructions.length.toLocaleString()} / 24,000
                  </p>
                  {hint('instructions')}
                </TabsContent>
                <TabsContent value="resources" className="space-y-7">
                  {catalogError ? (
                    <div
                      role="alert"
                      className="space-y-2 text-sm text-destructive"
                    >
                      <p>{t(catalogError)}</p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setRevision((value) => value + 1)}
                      >
                        {t('agents.retry')}
                      </Button>
                    </div>
                  ) : !catalog ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      {t('agents.loading')}
                    </p>
                  ) : null}
                  <section className="space-y-3">
                    <h3 className="text-sm font-semibold">
                      {t('agents.tools')}
                    </h3>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t('agents.toolsHint')}
                    </p>
                    <Button asChild variant="outline" size="sm">
                      <Link
                        to="/admin/tools"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('nav.tools')}
                        <ExternalLink />
                      </Link>
                    </Button>
                    <div className="divide-y rounded-lg border">
                      {catalog?.tools.map((tool) => {
                        const titleKey =
                          `agents.tool.${tool.id}` as TranslationKey;
                        const title = i18n.exists(titleKey)
                          ? String(t(titleKey))
                          : tool.id;
                        const enabled =
                          tool.enabled && !disabledTools.includes(tool.id);
                        return (
                          <div
                            key={tool.id}
                            className="flex items-center gap-3 px-3 py-3"
                          >
                            <Label
                              htmlFor={`agent-tool-${tool.id}`}
                              className="flex min-w-0 flex-1 flex-col items-start gap-1"
                            >
                              <span className="break-words leading-5">
                                {title}
                              </span>
                              <span className="break-all font-mono text-xs font-normal text-muted-foreground">
                                {tool.id}
                              </span>
                            </Label>
                            <Badge variant={enabled ? 'secondary' : 'outline'}>
                              {t(
                                !tool.enabled
                                  ? 'agents.toolGloballyDisabled'
                                  : enabled
                                    ? 'tools.enabled'
                                    : 'tools.disabled',
                              )}
                            </Badge>
                            <Switch
                              id={`agent-tool-${tool.id}`}
                              checked={enabled}
                              disabled={pending || !tool.enabled}
                              onCheckedChange={(checked) =>
                                setDisabledTools((current) =>
                                  checked
                                    ? current.filter((id) => id !== tool.id)
                                    : [...current, tool.id],
                                )
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                    {hint('disabledTools')}
                  </section>
                  <section className="space-y-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">
                        {t('agents.skills')}
                      </h3>
                      <Badge variant="secondary">
                        {skillsMode === 'auto'
                          ? t('agents.skillsAuto')
                          : skillPaths.length}
                      </Badge>
                      <Button
                        asChild
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                      >
                        <Link
                          to="/admin/skills"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('agents.manageSkills')}
                          <ExternalLink className="size-3.5" />
                        </Link>
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="agent-skills-mode">
                        {t('agents.skillsMode')}
                      </Label>
                      <Select
                        value={skillsMode}
                        disabled={pending}
                        onValueChange={(value) => {
                          if (value !== 'auto' && value !== 'custom') return;
                          setSkillsMode(value);
                          setErrors((current) => ({
                            ...current,
                            skillPaths: undefined,
                          }));
                        }}
                      >
                        <SelectTrigger id="agent-skills-mode" className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            {t('agents.skillsAuto')}
                          </SelectItem>
                          <SelectItem value="custom">
                            {t('agents.skillsCustom')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t(
                        skillsMode === 'auto'
                          ? 'agents.skillsAutoHint'
                          : 'agents.skillsHint',
                      )}
                    </p>
                    {skillsMode === 'custom' && (
                      <>
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
                          <Input
                            className="pl-9"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('agents.searchSkills')}
                            aria-label={t('agents.searchSkills')}
                          />
                        </div>
                        {missing.map((path) => (
                          <label
                            key={path}
                            className="flex items-start gap-3 rounded-lg border border-destructive/30 p-3"
                          >
                            <Checkbox
                              className="mt-1"
                              checked
                              disabled={pending}
                              onCheckedChange={() =>
                                setSkillPaths((current) =>
                                  current.filter((value) => value !== path),
                                )
                              }
                            />
                            <span className="min-w-0 break-all text-xs">
                              <span className="block font-medium text-destructive">
                                {t('agents.unavailable')}
                              </span>
                              {path}
                            </span>
                          </label>
                        ))}
                        {visibleSkills.length ? (
                          <div className="overflow-hidden rounded-lg border">
                            <InstalledSkillsList
                              mode="select"
                              skills={catalog?.skills ?? []}
                              search={search}
                              selected={new Set(skillPaths)}
                              disabled={pending}
                              onSelect={(skill, checked) =>
                                selectSkills([skill], checked)
                              }
                              onSelectGroup={selectSkills}
                            />
                          </div>
                        ) : catalog ? (
                          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                            {t(search ? 'agents.noMatches' : 'agents.noSkills')}
                          </p>
                        ) : null}
                        {hint('skillPaths')}
                      </>
                    )}
                    {hint('skillsMode')}
                  </section>
                </TabsContent>
              </fieldset>
            </ScrollArea>
          </Tabs>
          <footer className="space-y-3 border-t bg-background p-5">
            {hint('form')}
            {catalogError && tab !== 'resources' ? (
              <p role="alert" className="text-xs text-destructive">
                {t(catalogError)}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {agent
                  ? t('agents.nextVersion', {
                      version: agent.versionNumber + 1,
                    })
                  : t('agents.draftHint')}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={onClose}
                >
                  {t('agents.cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={pending || !catalog || !!catalogError}
                >
                  {pending ? <LoaderCircle className="animate-spin" /> : null}
                  {t(pending ? 'agents.saving' : 'agents.save')}
                </Button>
              </div>
            </div>
          </footer>
        </form>
      </SheetContent>
    </Sheet>
  );
}
