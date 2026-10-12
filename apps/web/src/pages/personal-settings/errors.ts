import { chatErrorKey } from '@/components/chat/api';

export function archiveErrorKey(error: unknown) {
  const key = chatErrorKey(error);
  return key === 'chat.errors.failed' ? 'personalSettings.failed' : key;
}
