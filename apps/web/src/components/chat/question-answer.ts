import { createContext } from 'react';
import type { UserQuestion } from '@aime/shared/threads';

export type QuestionDraft = {
  text: string;
  selected: string[];
  skipped?: boolean;
};

/** A first question can acquire siblings after its single-question form has mounted. */
export const ChatQuestionDrafts = createContext<Map<
  string,
  QuestionDraft
> | null>(null);

export const emptyQuestionDraft: QuestionDraft = { text: '', selected: [] };

export function questionAnswer(
  question: UserQuestion | undefined,
  draft: QuestionDraft,
) {
  const text = draft.text.trim();
  if (question?.selectionMode === 'multi_select')
    return text ? [...draft.selected, text] : draft.selected;
  return text || draft.selected[0] || '';
}

export function formatQuestionAnswer(answer: unknown): string {
  if (typeof answer === 'string') return answer;
  if (Array.isArray(answer)) return answer.join(', ');
  if (
    answer &&
    typeof answer === 'object' &&
    'content' in answer &&
    typeof answer.content === 'string'
  )
    return answer.content;
  return answer === undefined ? '' : JSON.stringify(answer);
}
