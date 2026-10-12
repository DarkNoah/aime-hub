import { useEffect, useState } from 'react';
import { systemSettingsSchema } from '@aime/shared/system-settings';

export function useRegistrationStatus() {
  const [registrationEnabled, setRegistrationEnabled] = useState<boolean>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth/registration-status', {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Registration status unavailable');
        const status = systemSettingsSchema.parse(await response.json());
        if (!controller.signal.aborted)
          setRegistrationEnabled(status.registrationEnabled);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [revision]);

  function retry() {
    setRegistrationEnabled(undefined);
    setError(false);
    setRevision((value) => value + 1);
  }

  return { registrationEnabled, error, retry };
}
