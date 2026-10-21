import { z } from 'zod';

export const groupChatCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  projectId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{16}$/)
    .optional(),
});
export const groupChatMessageSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{16,32}$/),
  text: z.string().trim().min(1).max(20_000),
});

export type GroupChat = {
  id: string;
  title: string;
  projectId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export type GroupChatDetail = GroupChat & {
  memberIds: string[];
  canManage: boolean;
};
export type GroupChatList = { rooms: GroupChat[]; hasMore: boolean };
export type GroupChatMessage = {
  id: string;
  roomId: string;
  sequence: string;
  senderId: string;
  text: string;
  createdAt: string;
};
export type GroupChatMessages = {
  messages: GroupChatMessage[];
  hasMore: boolean;
};

/** Public member fields only; never expose email or authentication metadata. */
export type MemberProfile = {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
};
