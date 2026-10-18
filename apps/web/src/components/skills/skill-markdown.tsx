import { MessageResponse } from '@/components/ai-elements/message';

export function SkillMarkdown({ content }: { content: string }) {
  const frontmatter = content.match(
    /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
  );

  return (
    <div className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
      {frontmatter && (
        <pre className="rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-6 break-words whitespace-pre-wrap text-muted-foreground">
          {frontmatter[1]}
        </pre>
      )}
      <MessageResponse mode="static" renderEnhancedLinks={false}>
        {frontmatter ? content.slice(frontmatter[0].length) : content}
      </MessageResponse>
    </div>
  );
}
