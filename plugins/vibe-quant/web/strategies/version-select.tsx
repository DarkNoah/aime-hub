import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@app/plugin-ui';
import type { StrategyVersion } from '../../strategy-types';

function VersionLabel({
  version,
  compact = false,
  primary = false,
}: {
  version: StrategyVersion;
  compact?: boolean;
  primary?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
      <span className="flex items-center gap-2 text-sm font-medium">
        v{version.number}
        {primary && <Badge variant="secondary">主要版本</Badge>}
      </span>
      <span
        className={`whitespace-pre-wrap text-xs font-normal leading-5 text-muted-foreground [overflow-wrap:anywhere] ${compact ? 'line-clamp-2' : ''}`}
      >
        {version.note || version.source_hash.slice(0, 8)}
      </span>
    </span>
  );
}

/** Shared by script editing, backtests and parameter optimization. */
export function VersionSelect({
  versions,
  value,
  onValueChange,
  includeDraft = false,
  disabled = false,
  primaryVersionId,
}: {
  versions: StrategyVersion[];
  value: string;
  onValueChange: (value: string) => void;
  includeDraft?: boolean;
  disabled?: boolean;
  primaryVersionId?: string | null;
}) {
  const selected = versions.find((version) => version.id === value);
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        className="w-full min-w-0 data-[size=default]:h-auto min-h-14"
        aria-label={includeDraft ? '选择草稿或版本' : '脚本版本'}
        title={
          selected
            ? `v${selected.number} · ${selected.note || selected.source_hash.slice(0, 8)}`
            : undefined
        }
      >
        <SelectValue
          className="min-w-0 flex-1 text-left"
          placeholder="选择版本"
        >
          {selected ? (
            <VersionLabel
              version={selected}
              primary={selected.id === primaryVersionId}
              compact
            />
          ) : value === 'draft' ? (
            '工作草稿'
          ) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        className="w-(--radix-select-trigger-width) max-w-[calc(100vw-2rem)]"
      >
        {includeDraft && <SelectItem value="draft">工作草稿</SelectItem>}
        {versions.map((version) => (
          <SelectItem
            key={version.id}
            value={version.id}
            textValue={`v${version.number} ${version.note}`}
            className="py-2 [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1"
          >
            <VersionLabel
              version={version}
              primary={version.id === primaryVersionId}
            />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
