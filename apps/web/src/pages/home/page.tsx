import {
  ArrowDown,
  ArrowRight,
  Check,
  Code2,
  Menu,
  Server,
  Workflow,
} from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brand } from '@/components/brand';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import './home.css';

const repository = 'https://github.com/DarkNoah/aime-hub';
const views = [
  {
    id: 'chat',
    label: 'home.previewChat',
    image: 'chat-light.jpg',
    alt: 'home.chatAlt',
  },
  {
    id: 'workspace',
    label: 'home.previewWorkspace',
    image: 'workspace-light.jpg',
    alt: 'home.workspaceAlt',
  },
  {
    id: 'projects',
    label: 'home.previewProjects',
    image: 'projects-light.jpg',
    alt: 'home.projectsAlt',
  },
  {
    id: 'dark',
    label: 'home.previewDark',
    image: 'chat-dark.jpg',
    alt: 'home.darkAlt',
  },
] as const;
const features = [
  {
    title: 'home.modelsTitle',
    description: 'home.modelsDescription',
    detail: 'home.modelsDetail',
  },
  {
    title: 'home.agentsTitle',
    description: 'home.agentsDescription',
    detail: 'home.agentsDetail',
  },
  {
    title: 'home.toolsTitle',
    description: 'home.toolsDescription',
    detail: 'home.toolsDetail',
  },
  {
    title: 'home.automationsTitle',
    description: 'home.automationsDescription',
    detail: 'home.automationsDetail',
  },
] as const;

export function HomePage() {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="home-page">
      <a
        href="#home-main"
        className="sr-only rounded-md bg-card p-3 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        {t('nav.skip')}
      </a>
      <header className="home-nav home-container">
        <Link
          to="/home"
          aria-label={t('home.title')}
          className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Brand />
        </Link>
        <nav
          aria-label={t('nav.main')}
          className="hidden items-center gap-7 text-sm text-muted-foreground md:flex"
        >
          <a href="#preview" className="home-text-link">
            {t('home.preview')}
          </a>
          <a href="#features" className="home-text-link">
            {t('home.features')}
          </a>
          <a href="#deploy" className="home-text-link">
            {t('home.deploy')}
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button asChild size="sm" className="hidden sm:inline-flex">
            <Link to="/login">
              {t('home.enter')}
              <ArrowRight />
            </Link>
          </Button>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label={t('nav.open')}
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent className="w-72 p-6" closeLabel={t('nav.close')}>
              <SheetTitle>{t('home.title')}</SheetTitle>
              <SheetDescription>{t('home.subtitle')}</SheetDescription>
              <nav
                className="mt-6 flex flex-col gap-5"
                aria-label={t('nav.main')}
              >
                <a
                  href="#preview"
                  className="home-text-link"
                  onClick={() => setMenuOpen(false)}
                >
                  {t('home.preview')}
                </a>
                <a
                  href="#features"
                  className="home-text-link"
                  onClick={() => setMenuOpen(false)}
                >
                  {t('home.features')}
                </a>
                <a
                  href="#deploy"
                  className="home-text-link"
                  onClick={() => setMenuOpen(false)}
                >
                  {t('home.deploy')}
                </a>
                <Button asChild>
                  <Link to="/login" onClick={() => setMenuOpen(false)}>
                    {t('home.enter')}
                    <ArrowRight />
                  </Link>
                </Button>
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </header>
      <main id="home-main" tabIndex={-1} className="outline-none">
        <section className="home-hero" aria-labelledby="home-heading">
          <div className="home-container">
            <div className="home-hero-copy">
              <div>
                <p className="mb-6 flex items-center gap-2 text-sm text-white/80">
                  <span
                    className="size-2 rounded-full bg-[#b5d9bd]"
                    aria-hidden
                  />
                  {t('home.subtitle')}
                </p>
                <h1 id="home-heading">
                  {t('home.headlineFirst')}
                  <br />
                  <span className="text-[#b5d9bd]">
                    {t('home.headlineSecond')}
                  </span>
                </h1>
              </div>
              <div className="home-hero-aside">
                <p className="max-w-sm text-base leading-8 text-white/85">
                  {t('home.description')}
                </p>
                <div className="mt-7 flex flex-wrap gap-3">
                  <Button
                    asChild
                    size="lg"
                    className="bg-white text-[#244b38] hover:bg-white/90"
                  >
                    <Link to="/login">
                      {t('home.start')}
                      <ArrowRight />
                    </Link>
                  </Button>
                  <Button
                    asChild
                    size="lg"
                    variant="ghost"
                    className="text-white hover:bg-white/10 hover:text-white"
                  >
                    <a href={repository} target="_blank" rel="noreferrer">
                      <Code2 />
                      GitHub
                    </a>
                  </Button>
                </div>
              </div>
            </div>
            <section
              id="preview"
              className="home-product"
              aria-label={t('home.preview')}
            >
              <Tabs defaultValue="chat" className="gap-0">
                <div className="home-product-toolbar">
                  <span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
                    <span
                      className="size-2 rounded-full bg-primary"
                      aria-hidden
                    />
                    Aime Hub / {t('home.preview')}
                  </span>
                  <TabsList
                    aria-label={t('home.preview')}
                    className="max-w-full bg-transparent"
                  >
                    {views.map((view) => (
                      <TabsTrigger
                        key={view.id}
                        value={view.id}
                        className="px-2 text-xs sm:px-3"
                      >
                        {t(view.label)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                {views.map((view) => (
                  <TabsContent key={view.id} value={view.id} className="m-0">
                    <a
                      href={`/product/${view.image}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t('home.enlarge', { name: t(view.label) })}
                      className="block outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <img
                        src={`/product/${view.image}`}
                        alt={t(view.alt)}
                        width={1280}
                        height={720}
                        loading={view.id === 'chat' ? 'eager' : 'lazy'}
                        fetchPriority={view.id === 'chat' ? 'high' : 'auto'}
                        className="home-product-image"
                      />
                    </a>
                  </TabsContent>
                ))}
              </Tabs>
            </section>
            <div className="home-preview-caption">
              <p>{t('home.previewNote')}</p>
              <a
                href="#features"
                className="flex items-center gap-2 rounded-sm outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white"
              >
                {t('home.discover')}
                <ArrowDown className="size-3.5" aria-hidden />
              </a>
            </div>
          </div>
        </section>
        <section
          id="features"
          className="home-container home-section"
          aria-labelledby="home-features-heading"
        >
          <div className="home-section-heading">
            <h2 id="home-features-heading">{t('home.featuresHeading')}</h2>
            <p>{t('home.featuresIntro')}</p>
          </div>
          <div className="home-features">
            {features.map(({ title, description, detail }) => (
              <article key={title} className="home-feature">
                <h3>{t(title)}</h3>
                <p>{t(description)}</p>
                <span className="mt-5 flex items-start gap-2 text-xs leading-6 text-primary">
                  <Check className="mt-1 size-3.5 shrink-0" aria-hidden />
                  {t(detail)}
                </span>
              </article>
            ))}
          </div>
        </section>
        <section
          className="home-collaboration"
          aria-labelledby="home-projects-heading"
        >
          <div className="home-container grid items-center gap-10 lg:grid-cols-[1.3fr_1fr] lg:gap-16">
            <div className="overflow-hidden rounded-xl border bg-card">
              <img
                src="/product/projects-light.jpg"
                width={1280}
                height={720}
                loading="lazy"
                alt={t('home.projectsAlt')}
                className="block h-auto w-full"
              />
            </div>
            <div>
              <Workflow className="mb-5 size-7 text-primary" aria-hidden />
              <h2 id="home-projects-heading">{t('home.projectsHeading')}</h2>
              <p className="mt-5 text-sm leading-7 text-muted-foreground">
                {t('home.projectsDescription')}
              </p>
              <ul className="mt-6 space-y-4 text-sm">
                {(
                  [
                    'home.projectFiles',
                    'home.projectMembers',
                    'home.projectContext',
                  ] as const
                ).map((key) => (
                  <li key={key} className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-primary"
                      aria-hidden
                    />
                    {t(key)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
        <section
          id="deploy"
          className="home-container home-section"
          aria-labelledby="home-deploy-heading"
        >
          <div className="home-deploy">
            <div>
              <Server className="mb-5 size-7 text-primary" aria-hidden />
              <h2 id="home-deploy-heading">{t('home.deployHeading')}</h2>
              <p className="mt-4 max-w-lg text-sm leading-7 text-muted-foreground">
                {t('home.deployDescription')}
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild>
                  <a
                    href={`${repository}/blob/main/docs/deployment.md`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('home.deployDocs')}
                    <ArrowRight />
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <a
                    href={`${repository}#readme`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('home.sourceDocs')}
                  </a>
                </Button>
              </div>
            </div>
            <dl className="home-stack">
              <div>
                <dt>{t('home.stackWeb')}</dt>
                <dd>React · Tailwind CSS · shadcn/ui</dd>
              </div>
              <div>
                <dt>{t('home.stackAgent')}</dt>
                <dd>Mastra · Hono · oRPC</dd>
              </div>
              <div>
                <dt>{t('home.stackData')}</dt>
                <dd>PostgreSQL · Docker Compose</dd>
              </div>
            </dl>
          </div>
        </section>
      </main>
      <footer className="home-container home-footer">
        <Brand />
        <p>{t('home.footer')}</p>
        <a
          href={repository}
          className="home-text-link inline-flex items-center gap-2 text-sm"
          target="_blank"
          rel="noreferrer"
        >
          <Code2 className="size-4" />
          GitHub
          <ArrowRight className="size-3.5" />
        </a>
      </footer>
    </div>
  );
}
