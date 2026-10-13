import { FileText, Layers2, Search, TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';

const capabilities = [
  {
    icon: Search,
    title: 'chat.welcomeResearch',
    hint: 'chat.welcomeResearchHint',
  },
  { icon: FileText, title: 'chat.welcomeWrite', hint: 'chat.welcomeWriteHint' },
  {
    icon: TerminalSquare,
    title: 'chat.welcomeBuild',
    hint: 'chat.welcomeBuildHint',
  },
] as const;

export function ChatWelcome() {
  const { t } = useTranslation();
  return (
    <ConversationEmptyState className="m-auto w-full max-w-2xl gap-0 px-5 py-8 @lg/chat:px-8">
      <span className="mb-6 flex size-12 items-center justify-center rounded-2xl bg-secondary text-primary">
        <Layers2 className="size-6" aria-hidden />
      </span>
      <h2 className="text-2xl leading-snug font-semibold @lg/chat:text-3xl">
        {t('chat.welcome')}
      </h2>
      <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground">
        {t('chat.welcomeHint')}
      </p>
      <ul className="mt-8 grid w-full gap-4 text-left @lg/chat:grid-cols-3">
        {capabilities.map(({ icon: Icon, title, hint }) => (
          <li
            key={title}
            className="flex gap-3 @lg/chat:block @lg/chat:border-t @lg/chat:pt-4"
          >
            <Icon
              className="mt-0.5 size-4 shrink-0 text-primary @lg/chat:mb-3"
              aria-hidden
            />
            <div>
              <h3 className="text-sm font-medium">{t(title)}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t(hint)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </ConversationEmptyState>
  );
}
