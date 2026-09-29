import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Folder, MessageSquare, Sprout } from 'lucide-react';
import { Link } from 'react-router';
import { useAuthSession } from '@/lib/session-context';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { isAdmin } from '@/lib/auth-client';

export function WorkspacePage() {
  const { t } = useTranslation();
  const { data } = useAuthSession();
  return (
    <div className="space-y-9">
      <section>
        <p className="mb-3 text-xs font-medium tracking-[0.18em] text-primary">
          {t('workspace.eyebrow')}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t('workspace.heading')}
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-7 text-muted-foreground">
          {t('workspace.welcome')}
        </p>
      </section>
      <section className="relative overflow-hidden rounded-2xl border bg-[#edf2e9] px-6 py-9 sm:px-9 sm:py-12">
        <div className="relative z-10 max-w-lg">
          <Sprout className="mb-6 size-8 text-primary" strokeWidth={1.5} />
          <h2 className="text-xl font-medium tracking-tight">
            {t('workspace.heroTitle')}
          </h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            {t('workspace.heroDescription')}
          </p>
          {isAdmin(data?.user.role) && (
            <Button asChild variant="outline" className="mt-6 bg-white/70">
              <Link to="/admin">
                {t('workspace.openAdmin')}
                <ArrowUpRight />
              </Link>
            </Button>
          )}
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -bottom-32 size-80 rounded-full border border-primary/10"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-14 -bottom-24 size-64 rounded-full border border-primary/10"
        />
      </section>
      <section
        aria-label={t('workspace.futureFeatures')}
        className="grid gap-4 sm:grid-cols-2"
      >
        {[
          {
            title: t('nav.chats'),
            description: t('workspace.chatsDescription'),
            icon: MessageSquare,
          },
          {
            title: t('nav.projects'),
            description: t('workspace.projectsDescription'),
            icon: Folder,
          },
        ].map(({ title, description, icon: Icon }) => (
          <Card key={title} className="shadow-none">
            <CardHeader>
              <div className="mb-4 flex items-center justify-between">
                <Icon
                  className="size-5 text-muted-foreground"
                  strokeWidth={1.5}
                />
                <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                  {t('common.comingSoon')}
                </span>
              </div>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription>{description}</CardDescription>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
