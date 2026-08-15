// 适配层：复刻 biosphere-terminal-app 的 useAgentStore 接口（providers/endpoints/models
// + 增删改查 + 测试连接），但底层走 snap-craft 纯前端直连 store（useAiStore: config +
// setConfig + localStorage），不依赖任何后端 Tauri 命令。这样 ModelConfigPage 可以「原样
// 拷贝」biosphere 的组件代码，仅改 import 来源，数据层无缝接入 snap-craft 既有配置。
import { useAiStore } from './aiStore';
import { chatOnce } from './aiClient';
import { resolveConfig } from './providerConfig';
import type { AiAgent } from './aiAgents';
import type { AiProviderConfig, AiEndpointConfig, AiModelConfig } from './aiTypes';
import { t } from '../../i18n';
import { useLicenseStore } from '../licensing/licenseStore';
import { useUpgradeDialogStore } from '../licensing/upgradeDialogStore';

// 本地 id 生成，避免对 streamHelpers.genId 签名产生依赖
export function genId(prefix = 'id'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

type WithId = { id: string };

function upsert<T extends WithId>(list: T[] | undefined, item: T): T[] {
  const arr = list ? [...list] : [];
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item;
  else arr.push(item);
  return arr;
}

export interface AgentStoreSnapshot {
  providers: AiProviderConfig[];
  endpoints: AiEndpointConfig[];
  models: AiModelConfig[];
  agents: AiAgent[];
  saveProvider: (p: AiProviderConfig) => void;
  deleteProvider: (id: string) => Promise<void>;
  saveEndpoint: (e: AiEndpointConfig) => void;
  deleteEndpoint: (id: string) => Promise<void>;
  saveModel: (m: AiModelConfig) => void;
  deleteModel: (id: string) => Promise<void>;
  testEndpointConnection: (endpointId: string) => Promise<string>;
  testModelChat: (modelId: string) => Promise<string>;
}

export function useAgentStore(): AgentStoreSnapshot {
  const config = useAiStore((s) => s.config);
  const setConfig = useAiStore((s) => s.setConfig);
  const agents = useAiStore((s) => s.agents);

  const providers = config.providers ?? [];
  const endpoints = config.endpoints ?? [];
  const models = config.models ?? [];

  const saveProvider = (p: AiProviderConfig) => setConfig({ providers: upsert(providers, p) });

  const deleteProvider = async (id: string) => {
    const delModelIds = new Set(
      endpoints
        .filter((e) => e.providerId === id)
        .flatMap((e) => models.filter((m) => m.endpointId === e.id).map((m) => m.id)),
    );
    setConfig({
      providers: providers.filter((p) => p.id !== id),
      endpoints: endpoints.filter((e) => e.providerId !== id),
      models: models.filter((m) => !delModelIds.has(m.id)),
    });
  };

  const saveEndpoint = (e: AiEndpointConfig) => setConfig({ endpoints: upsert(endpoints, e) });

  const deleteEndpoint = async (id: string) => {
    setConfig({
      endpoints: endpoints.filter((e) => e.id !== id),
      models: models.filter((m) => m.endpointId !== id),
    });
  };

  const saveModel = (m: AiModelConfig) => setConfig({ models: upsert(models, m) });

  const deleteModel = async (id: string) => {
    setConfig({ models: models.filter((m) => m.id !== id) });
  };

  // 付费门禁：连接测试属 AI 功能，须受订阅控制（fail-closed，与 chat/runAgent 一致）
  const guardAi = (): boolean => {
    if (!useLicenseStore.getState().canUse('ai')) {
      useUpgradeDialogStore.getState().openDialog('ai');
      return false;
    }
    return true;
  };

  const testEndpointConnection = async (endpointId: string): Promise<string> => {
    if (!guardAi()) throw new Error(t('ai.errorNoKey'));
    const ep = endpoints.find((e) => e.id === endpointId);
    if (!ep) throw new Error(t('ai.endpointNotFound'));
    const mdl =
      models.find((m) => m.endpointId === endpointId && m.enabled !== false) ??
      models.find((m) => m.endpointId === endpointId);
    if (!mdl) throw new Error(t('ai.endpointNoModel'));
    await chatOnce({
      config: resolveConfig(config, mdl.id),
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'ping' },
      ],
    });
    return t('ai.testOk');
  };

  const testModelChat = async (modelId: string): Promise<string> => {
    if (!guardAi()) throw new Error(t('ai.errorNoKey'));
    await chatOnce({
      config: resolveConfig(config, modelId),
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'ping' },
      ],
    });
    return t('ai.testOk');
  };

  return {
    providers,
    endpoints,
    models,
    agents,
    saveProvider,
    deleteProvider,
    saveEndpoint,
    deleteEndpoint,
    saveModel,
    deleteModel,
    testEndpointConnection,
    testModelChat,
  };
}
