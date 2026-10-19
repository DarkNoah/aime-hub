import type { ComponentType } from 'react';
import {
  ChatToolInteraction,
  type ToolInteractionProps,
} from '../chat-tool-interaction';
import { getToolName, isSpecialTool, type SpecialToolName } from './registry';
import { SubmitPlan } from './submit-plan';
import { IntelligentUI } from './intelligent-ui';

const renderers: Record<
  SpecialToolName,
  ComponentType<ToolInteractionProps>
> = {
  ask_user: ChatToolInteraction,
  submit_plan: SubmitPlan,
  IntelligentUI,
};

export function ChatToolRenderer(props: ToolInteractionProps) {
  const name = props.interaction?.toolName ?? getToolName(props.tool);
  // Pre-execution approval must still use approve/decline, even for a special tool.
  const Renderer =
    props.interaction?.kind !== 'approval' && isSpecialTool(name)
      ? renderers[name]
      : ChatToolInteraction;
  return (
    <Renderer
      key={props.interaction?.id ?? props.tool?.toolCallId}
      {...props}
    />
  );
}
