import { z } from 'zod';

export const taskStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

// Older task snapshots and task_write inputs can omit generated IDs.
const taskItemSchema = z.object({
  id: z.string().min(1).optional(),
  content: z.string(),
  status: taskStatusSchema,
  activeForm: z.string().optional(),
});
const taskListSchema = z.array(taskItemSchema);
const taskOutputSchema = z.object({
  content: z.string(),
  tasks: taskListSchema,
  isError: z.boolean(),
});

export type TaskSnapshot = z.infer<typeof taskItemSchema>;
export type TaskStatus = TaskSnapshot['status'];

export function parseTaskList(value: unknown) {
  const parsed = taskListSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseTaskOutput(value: unknown) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = taskOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function summarizeTasks(tasks: TaskSnapshot[]) {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const task of tasks) counts[task.status]++;
  return {
    ...counts,
    total: tasks.length,
    allCompleted: tasks.length > 0 && counts.completed === tasks.length,
  };
}
