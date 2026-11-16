import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillScan } from '@aime/shared/skills';
import type { TranslationKey } from '@/i18n/config';
import {
  getSkillApi,
  skillErrorKey,
  uploadSkillArchive,
  type SkillScope,
  type SkillImportMode,
} from './api';

type ArchiveState = {
  filename?: string;
  loading: boolean;
  scan?: SkillScan;
  error?: TranslationKey;
};

export function useArchiveScan(scope: SkillScope) {
  const client = getSkillApi(scope);
  const [state, setState] = useState<ArchiveState>({ loading: false });
  const current = useRef<
    { controller: AbortController; scanId?: string } | undefined
  >(undefined);
  const release = useCallback(() => {
    const request = current.current;
    current.current = undefined;
    request?.controller.abort();
    if (request?.scanId)
      void client.discard({ params: { id: request.scanId } }).catch(() => {});
  }, [client]);
  useEffect(() => release, [release]);

  const clearScan = () => {
    release();
    setState({ loading: false });
  };
  async function upload(
    file: File,
    mode: SkillImportMode = 'skills',
  ): Promise<TranslationKey | undefined> {
    release();
    const request = {
      controller: new AbortController(),
      scanId: undefined as string | undefined,
    };
    current.current = request;
    setState({ filename: file.name, loading: true });
    try {
      const scan = await uploadSkillArchive(
        scope,
        file,
        request.controller.signal,
        mode,
      );
      if (request.controller.signal.aborted || current.current !== request) {
        void client.discard({ params: { id: scan.id } }).catch(() => {});
        return;
      }
      request.scanId = scan.id;
      setState({ filename: file.name, loading: false, scan });
    } catch (error) {
      if (request.controller.signal.aborted || current.current !== request)
        return;
      const key = skillErrorKey(error);
      setState({ filename: file.name, loading: false, error: key });
      return key;
    }
  }
  return { ...state, upload, clearScan };
}
