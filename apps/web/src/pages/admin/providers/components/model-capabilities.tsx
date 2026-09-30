import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AudioLines,
  BrainCircuit,
  FileText,
  Image,
  Minus,
  Type,
  Video,
  Wrench,
} from 'lucide-react';
import type { ProviderModel } from '@aime/shared/providers';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const modalityIcons = {
  text: Type,
  image: Image,
  audio: AudioLines,
  video: Video,
  pdf: FileText,
} as const;

function CapabilityHint({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          tabIndex={0}
          className={cn(
            'inline-flex h-8 w-fit items-center gap-1.5 rounded-md bg-muted px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={5}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function ModelCapabilities({ model }: { model: ProviderModel }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-1.5">
      {(['modalitiesInput', 'modalitiesOutput'] as const).map((key) => {
        const label = `${t(`models.${key}`)}: ${model[key].map((value) => t(`models.modality.${value}`)).join(', ') || t('models.noCapabilities')}`;
        return (
          <CapabilityHint key={key} label={label}>
            <span className="mr-1 whitespace-nowrap text-xs text-muted-foreground">
              {t(key === 'modalitiesInput' ? 'models.input' : 'models.output')}
            </span>
            {model[key].map((value) => {
              const Icon = modalityIcons[value];
              return <Icon key={value} className="size-4" aria-hidden="true" />;
            })}
            {model[key].length === 0 && (
              <Minus className="size-4" aria-hidden="true" />
            )}
          </CapabilityHint>
        );
      })}
      {(model.reasoning || model.toolCall) && (
        <div className="flex gap-1.5">
          {(['reasoning', 'toolCall'] as const).map((key) => {
            if (!model[key]) return null;
            const Icon = key === 'reasoning' ? BrainCircuit : Wrench;
            return (
              <CapabilityHint
                key={key}
                label={t(`models.${key}`)}
                className="bg-primary/8 text-primary"
              >
                <Icon className="size-4" aria-hidden="true" />
              </CapabilityHint>
            );
          })}
        </div>
      )}
    </div>
  );
}
