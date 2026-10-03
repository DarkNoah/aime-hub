import { useEffect, useState } from 'react';
import type { SkillScan } from '@aime/shared/skills';
import type { TranslationKey } from '@/i18n/config';
import { isSkillSourceInput, skillErrorKey, skillRequest } from './api';

export function useRepositoryScan() {
  const [input, setInput] = useState('');
  const [revision, setRevision] = useState(0);
  const url = input.trim();
  const valid = isSkillSourceInput(url);
  const key = JSON.stringify([url, revision]);
  const [result, setResult] = useState<{
    key: string;
    data?: SkillScan;
    error?: TranslationKey;
  }>();
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    let scanId: string | undefined;
    const discard = (id: string) => {
      void skillRequest(`/scans/${id}`, { method: 'DELETE' }).catch(() => {});
    };
    const timer = window.setTimeout(() => {
      void skillRequest<SkillScan>('/scans', {
        method: 'POST',
        body: JSON.stringify({ url }),
        signal: controller.signal,
      }).then(
        (data) => {
          if (controller.signal.aborted) {
            discard(data.id);
            return;
          }
          scanId = data.id;
          setResult({ key, data });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setResult({ key, error: skillErrorKey(error) });
        },
      );
    }, 700);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (scanId) discard(scanId);
    };
  }, [url, valid, key]);

  return {
    input,
    setInput,
    loading: valid && result?.key !== key,
    scan: result?.key === key ? result.data : undefined,
    error:
      url && !valid
        ? ('skills.invalidUrl' as const)
        : result?.key === key
          ? result.error
          : undefined,
    rescan: () => setRevision((value) => value + 1),
    markInstalled: (paths: string[]) => {
      const installed = new Set(paths);
      setResult((current) =>
        current?.key === key && current.data
          ? {
              ...current,
              data: {
                ...current.data,
                skills: current.data.skills.map((skill) =>
                  installed.has(skill.destination)
                    ? { ...skill, installed: true }
                    : skill,
                ),
              },
            }
          : current,
      );
    },
  };
}
