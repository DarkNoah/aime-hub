import { useRef, useState, type CSSProperties } from 'react';
import { AudioLines, Download, RotateCcw } from 'lucide-react';
import { MediaPlaybackRateButton } from 'media-chrome/react';
import 'media-chrome/lang/zh-CN.js';
import { useTranslation } from 'react-i18next';
import {
  AudioPlayer,
  AudioPlayerElement,
  AudioPlayerMuteButton,
  AudioPlayerPlayButton,
  AudioPlayerTimeDisplay,
  AudioPlayerTimeRange,
} from '@/components/ai-elements/audio-player';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type AudioClipProps = {
  src?: string;
  filename: string;
  mediaType?: string;
  sampleRate?: number;
  downloadUrl?: string;
  onOpen?: () => void;
  className?: string;
};

export function AudioClip(props: AudioClipProps) {
  // Reset playback errors when the selected attachment changes.
  return <AudioClipContent key={props.src} {...props} />;
}

function AudioClipContent({
  src,
  filename,
  mediaType,
  sampleRate,
  downloadUrl = src,
  onOpen,
  className,
}: AudioClipProps) {
  const { t, i18n } = useTranslation();
  const audio = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);
  const format = mediaType?.split(';', 1)[0].split('/')[1]?.replace(/^x-/, '');
  const metadata = [
    format && format !== '*' ? format.toUpperCase() : undefined,
    sampleRate && Number.isFinite(sampleRate) && sampleRate > 0
      ? `${sampleRate / 1000} kHz`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      aria-label={filename}
      className={cn(
        'min-w-0 rounded-xl border bg-card p-3.5 text-left',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <AudioLines
          className="size-5 shrink-0 text-primary"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              aria-label={t('files.openPreview', { path: filename })}
              title={filename}
              className="block max-w-full truncate rounded text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {filename}
            </button>
          ) : (
            <p className="truncate text-sm font-medium" title={filename}>
              {filename}
            </p>
          )}
          {metadata && (
            <p className="mt-0.5 text-xs text-muted-foreground">{metadata}</p>
          )}
        </div>
        {downloadUrl && (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
          >
            <a
              href={downloadUrl}
              download={filename}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${t('files.download')}: ${filename}`}
              title={t('files.download')}
            >
              <Download className="size-4" aria-hidden="true" />
            </a>
          </Button>
        )}
      </div>
      {src && (
        <AudioPlayer
          key={i18n.resolvedLanguage}
          lang={i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en'}
          aria-label={t('audio.player')}
          ref={(controller) => {
            // Media Chrome initializes its label before React applies `audio`.
            controller?.setAttribute('aria-label', t('audio.player'));
          }}
          className={cn('mt-3 block! w-full min-w-0', failed && 'hidden!')}
          style={
            {
              '--media-font-size': '12px',
              '--media-range-track-height': '4px',
              '--media-range-track-border-radius': '999px',
              '--media-range-track-background': 'var(--color-border)',
              '--media-time-range-buffered-color':
                'color-mix(in srgb, var(--color-primary) 25%, transparent)',
            } as CSSProperties
          }
        >
          <AudioPlayerElement
            ref={audio}
            src={src}
            aria-label={filename}
            preload="metadata"
            onError={() => setFailed(true)}
            onPlay={(event) => {
              // A clip can appear both in the message and in the preview pane.
              for (const other of document.querySelectorAll<HTMLAudioElement>(
                '[data-slot="audio-player-element"]',
              )) {
                if (other !== event.currentTarget) other.pause();
              }
            }}
          />
          <AudioPlayerTimeRange className="flex! h-6 w-full min-w-0 border-0! px-0! shadow-none!" />
          <div className="mt-1 flex items-center gap-2">
            <AudioPlayerPlayButton className="size-9! shrink-0 rounded-full! border-0! bg-primary! text-primary-foreground shadow-none! [--media-icon-color:var(--color-primary-foreground)] [--media-control-hover-background:var(--color-primary)]" />
            <AudioPlayerTimeDisplay
              showDuration
              noToggle
              className="border-0! px-1! text-xs text-muted-foreground shadow-none!"
            />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <MediaPlaybackRateButton
                rates={[0.75, 1, 1.25, 1.5, 2]}
                className="inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1 text-xs text-muted-foreground"
              />
              <AudioPlayerMuteButton className="size-8 justify-center rounded-md border-0! px-0! text-muted-foreground shadow-none!" />
            </div>
          </div>
        </AudioPlayer>
      )}
      {(!src || failed) && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <p role="status" className="text-sm leading-6 text-muted-foreground">
            {t(src ? 'audio.unavailable' : 'chat.readFile.mediaUnavailable')}
          </p>
          {src && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFailed(false);
                audio.current?.load();
              }}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t('files.retry')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
