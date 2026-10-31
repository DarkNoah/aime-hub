import { IssueTool } from './issue.js';
import {
  askUserTool as nativeAskUser,
  taskWriteTool as nativeTaskWrite,
  taskUpdateTool as nativeTaskUpdate,
  taskCompleteTool as nativeTaskComplete,
  taskCheckTool as nativeTaskCheck,
  submitPlanTool as nativeSubmitPlan,
} from '@mastra/core/tools';
import { NativeTool } from './native.js';
import { SleepTool } from './sleep.js';
import { IntelligentUITool } from './intelligent-ui.js';
import { ExecTool } from './exec.js';
import { ExecCommandTool } from './exec_command.js';
import { WriteStdinTool } from './write_stdin.js';
import { ClockTool } from './clock.js';
import { WebSearchTool } from './web_search.js';
import { WebFetchTool } from './web_fetch.js';
import { ImageGenTool } from './image_gen.js';
import { SpeechTool } from './speech.js';
import { TranscriptionsTool } from './transcriptions.js';
import { ReadFileTool } from './read_file.js';
import { ExtractTool } from './extract.js';
import { ListVoicesTool } from './list_voices.js';
import { KnowledgeSearchTool } from './knowledge_search.js';
import { KnowledgeTool } from './knowledge.js';
import { AutomationTool } from './automations.js';

// Export definitions only. Every entry inherits BaseTool and builds native tools.
export const sleep = new SleepTool();
export const intelligentUI = new IntelligentUITool();
export const exec = new ExecTool();
export const execCommand = new ExecCommandTool();
export const writeStdin = new WriteStdinTool();
export const currTime = new ClockTool();
export const webSearch = new WebSearchTool();
export const webFetch = new WebFetchTool();
export const imageGen = new ImageGenTool();
export const speech = new SpeechTool();
export const transcriptions = new TranscriptionsTool();
export const readFile = new ReadFileTool();
export const extract = new ExtractTool();
export const listVoices = new ListVoicesTool();
export const askUserTool = new NativeTool(nativeAskUser);
export const taskWriteTool = new NativeTool(nativeTaskWrite);
export const taskUpdateTool = new NativeTool(nativeTaskUpdate);
export const taskCompleteTool = new NativeTool(nativeTaskComplete);
export const taskCheckTool = new NativeTool(nativeTaskCheck);
export const submitPlanTool = new NativeTool(nativeSubmitPlan);
export const knowledgeSearch = new KnowledgeSearchTool();
export const knowledge_list = new KnowledgeTool('knowledge_list');
export const knowledge_create = new KnowledgeTool('knowledge_create');
export const knowledge_get_document = new KnowledgeTool(
  'knowledge_get_document',
);
export const knowledge_save_document = new KnowledgeTool(
  'knowledge_save_document',
);
export const knowledge_archive_document = new KnowledgeTool(
  'knowledge_archive_document',
);
export const automation_list = new AutomationTool('automation_list');
export const automation_get = new AutomationTool('automation_get');
export const automation_save = new AutomationTool('automation_save');
export const automation_delete = new AutomationTool('automation_delete');
export const automation_run = new AutomationTool('automation_run');
export const automation_history = new AutomationTool('automation_history');

export const issue = new IssueTool();
