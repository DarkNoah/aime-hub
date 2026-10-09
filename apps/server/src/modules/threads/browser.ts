import { MastraBrowser } from '@mastra/core/browser'
import { OpenAICompatibleConfig } from '@mastra/core/llm'
import { StagehandBrowser } from '@mastra/stagehand'
import { AgentBrowser } from '@mastra/agent-browser'


export const getBrowser = (model: OpenAICompatibleConfig): MastraBrowser => {
    const stagehandBrowser = new StagehandBrowser({
        env: 'LOCAL',
        headless: true,
        model: {
            modelName: model.modelId,
            apiKey: model.apiKey,
            baseURL: model.url,
        },
        scope: 'thread',
        selfHeal: true,
        // excludeTools: ['stagehand_screenshot'],
    });
    const agentBrowser = new AgentBrowser({
        headless: true,
        model: {
            modelName: model.modelId,
            apiKey: model.apiKey,
            baseURL: model.url,
        },
        scope: 'thread',
        selfHeal: true,
        onLaunch: async (args) => {
            //await stagehandBrowser.launch(browser);
        },
        onClose: async (args) => {

        }
        // excludeTools: ['stagehand_screenshot'],
    });
    return agentBrowser
}
