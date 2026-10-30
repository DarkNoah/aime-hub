/** Internal thread binding. Never accepted from a public thread creation request. */
export type GroupChatThreadBinding = {
  roomId: string;
  memberId: string;
  role: 'bot' | 'worker';
};

export function groupChatThreadBinding(
  metadata?: Record<string, unknown>,
): GroupChatThreadBinding | undefined {
  const binding = metadata?.groupChat as
    Partial<GroupChatThreadBinding> | undefined;
  if (
    !binding ||
    typeof binding.roomId !== 'string' ||
    typeof binding.memberId !== 'string' ||
    (binding.role !== 'bot' && binding.role !== 'worker')
  )
    return undefined;
  return binding as GroupChatThreadBinding;
}
