import React, { useState, useEffect } from 'react';
import type { AgentConfig, ProviderConfig } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { Section, SettingRow, Toggle, MaskedInput, TextInput, Button, IconButton, StatusDot, EmptyState, SectionHeader } from './ui';

/* ── Stroke icons for provider row actions (16×16, matches sidebar icon set) ── */
const PlugIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
    <path d="M5.5 1.8v3M10.5 1.8v3" />
    <path d="M3.5 4.8h9v2.4a3.6 3.6 0 0 1-3.6 3.6H7.1a3.6 3.6 0 0 1-3.6-3.6V4.8z" />
    <path d="M8 10.8v3.4" />
  </svg>
);
const PencilIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
    <path d="M11.1 2.4a1.6 1.6 0 0 1 2.3 2.3l-8 8-3.1.8.8-3.1 8-8z" />
  </svg>
);
const PowerIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
    <path d="M8 1.8v5.4" />
    <path d="M11.6 3.5a5.5 5.5 0 1 1-7.2 0" />
  </svg>
);
const PlusIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
    <path d="M8 2.5v11M2.5 8h11" />
  </svg>
);
import {
  OpenAIIcon,
  AnthropicIcon,
  GeminiIcon,
  XaiIcon,
  VercelIcon,
  MistralIcon,
  GroqIcon,
  CohereIcon,
  DeepSeekIcon,
  MoonshotIcon,
  TogetherIcon,
  FireworksIcon,
  AlibabaCloudIcon,
  DeepInfraIcon,
  CerebrasIcon,
  HuggingFaceIcon,
  BasetenIcon,
  NvidiaIcon,
} from './providerIcons';

interface PredefinedProvider {
  id: string;
  name: string;
  baseURL: string;
  icon: React.ReactNode;
  models: { id: string; label: string; description: string; outputCost: number }[];
}

const PREDEFINED_PROVIDERS: PredefinedProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    icon: <OpenAIIcon />,
    models: [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Most intelligent model', outputCost: 25 },
      { id: 'gpt-5.6', label: 'GPT-5.6', description: 'Frontier model', outputCost: 15 },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Luna variant', outputCost: 15 },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Sol variant', outputCost: 15 },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Terra variant', outputCost: 15 },
      { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Previous generation', outputCost: 12 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Fast and efficient', outputCost: 5 },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano', description: 'Ultra lightweight', outputCost: 1 },
      { id: 'gpt-5.2-pro', label: 'GPT-5.2 Pro', description: 'Pro reasoning', outputCost: 20 },
      { id: 'gpt-5.2', label: 'GPT-5.2', description: 'Balanced model', outputCost: 10 },
      { id: 'gpt-5.1', label: 'GPT-5.1', description: 'Fast model', outputCost: 5 },
      { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Code generation', outputCost: 8 },
      { id: 'gpt-5', label: 'GPT-5', description: 'Base model', outputCost: 8 },
      { id: 'gpt-5-mini', label: 'GPT-5 Mini', description: 'Compact model', outputCost: 3 },
      { id: 'gpt-4.1', label: 'GPT-4.1', description: 'Previous gen', outputCost: 10 },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', description: 'Fast previous gen', outputCost: 3 },
      { id: 'gpt-4o', label: 'GPT-4o', description: 'Multimodal', outputCost: 10 },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', description: 'Fast multimodal', outputCost: 1.5 },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    icon: <AnthropicIcon />,
    models: [
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', description: 'Latest release', outputCost: 15 },
      { id: 'claude-opus-5', label: 'Claude Opus 5', description: 'Most capable', outputCost: 75 },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Latest Sonnet', outputCost: 15 },
      { id: 'claude-fable-5', label: 'Claude Fable 5', description: 'Creative model', outputCost: 15 },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Most capable', outputCost: 75 },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', description: 'Previous Opus', outputCost: 75 },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', description: 'Advanced reasoning', outputCost: 75 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Balanced model', outputCost: 15 },
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', description: 'Previous gen', outputCost: 75 },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'Fast and capable', outputCost: 15 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fast and affordable', outputCost: 1.25 },
      { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', description: 'Legacy Opus', outputCost: 75 },
      { id: 'claude-sonnet-4-0', label: 'Claude Sonnet 4.0', description: 'Legacy Sonnet', outputCost: 15 },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    icon: <GeminiIcon />,
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: 'Latest stable', outputCost: 2 },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', description: 'Latest Pro preview', outputCost: 15 },
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', description: 'Previous preview', outputCost: 12 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Most capable stable', outputCost: 10 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast and efficient', outputCost: 1.5 },
    ],
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    baseURL: 'https://api.x.ai/v1',
    icon: <XaiIcon />,
    models: [
      { id: 'grok-4.6', label: 'Grok 4.6', description: 'Latest Grok', outputCost: 15 },
      { id: 'grok-build-0.1', label: 'Grok Build 0.1', description: 'Agentic coding', outputCost: 12 },
      { id: 'grok-4.5', label: 'Grok 4.5', description: 'Previous gen', outputCost: 15 },
      { id: 'grok-4-fast-reasoning', label: 'Grok 4 Fast Reasoning', description: 'Fast reasoning', outputCost: 12 },
      { id: 'grok-4', label: 'Grok 4', description: 'Previous gen', outputCost: 10 },
      { id: 'grok-3', label: 'Grok 3', description: 'Balanced model', outputCost: 8 },
      { id: 'grok-3-mini', label: 'Grok 3 Mini', description: 'Fast and affordable', outputCost: 3 },
    ],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    baseURL: 'https://api.vercel.ai/v1',
    icon: <VercelIcon />,
    models: [
      { id: 'v0-1.0-md', label: 'v0 1.0 MD', description: 'Vercel AI model', outputCost: 10 },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    icon: <MistralIcon />,
    models: [
      { id: 'mistral-medium-3-5', label: 'Mistral Medium 3.5', description: 'Latest release', outputCost: 4 },
      { id: 'pixtral-large-latest', label: 'Pixtral Large', description: 'Multimodal model', outputCost: 8 },
      { id: 'mistral-large-latest', label: 'Mistral Large', description: 'Most capable Mistral', outputCost: 6 },
      { id: 'magistral-medium-2506', label: 'Magistral Medium', description: 'Balanced model', outputCost: 4 },
      { id: 'magistral-small-2506', label: 'Magistral Small', description: 'Fast and efficient', outputCost: 1 },
      { id: 'mistral-small-latest', label: 'Mistral Small', description: 'Previous gen', outputCost: 1 },
      { id: 'ministral-8b-latest', label: 'Ministral 8B', description: 'Lightweight model', outputCost: 0.5 },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    icon: <GroqIcon />,
    models: [
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B', description: 'Latest Llama', outputCost: 0.59 },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', description: 'Fast inference', outputCost: 0.59 },
      { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill', description: 'Reasoning model', outputCost: 0.88 },
      { id: 'qwen-qwq-32b', label: 'Qwen QwQ 32B', description: 'Alibaba model', outputCost: 0.5 },
      { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B', description: 'Open source GPT', outputCost: 1 },
    ],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    baseURL: 'https://api.cohere.com/v1',
    icon: <CohereIcon />,
    models: [
      { id: 'command-a-03-2025', label: 'Command A', description: 'Latest Command', outputCost: 5 },
      { id: 'command-a-reasoning-08-2025', label: 'Command A Reasoning', description: 'Reasoning model', outputCost: 6 },
      { id: 'command-r-plus', label: 'Command R+', description: 'Advanced model', outputCost: 4 },
      { id: 'command-r', label: 'Command R', description: 'Balanced model', outputCost: 2 },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    icon: <DeepSeekIcon />,
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Latest flagship', outputCost: 2.2 },
      { id: 'deepseek-chat', label: 'DeepSeek V3', description: 'General purpose', outputCost: 1.1 },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1', description: 'Advanced reasoning', outputCost: 5.5 },
    ],
  },
  {
    id: 'moonshotai',
    name: 'Moonshot AI',
    baseURL: 'https://api.moonshot.ai/v1',
    icon: <MoonshotIcon />,
    models: [
      { id: 'kimi-k2.5', label: 'Kimi K2.5', description: 'Latest Kimi', outputCost: 8 },
      { id: 'kimi-k3', label: 'Kimi K3', description: 'Next gen Kimi', outputCost: 10 },
      { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', description: 'Reasoning model', outputCost: 6 },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    icon: <TogetherIcon />,
    models: [
      { id: 'meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo', description: 'Fast and capable', outputCost: 0.88 },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', label: 'Qwen2.5 72B Turbo', description: 'Alibaba model', outputCost: 1.2 },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3', description: 'General purpose', outputCost: 1.5 },
      { id: 'mistralai/Mixtral-8x22B-Instruct-v0.1', label: 'Mixtral 8x22B', description: 'Mixture of experts', outputCost: 1.2 },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    icon: <FireworksIcon />,
    models: [
      { id: 'accounts/fireworks/models/deepseek-r1', label: 'DeepSeek R1', description: 'Reasoning model', outputCost: 3 },
      { id: 'accounts/fireworks/models/deepseek-v3', label: 'DeepSeek V3', description: 'General purpose', outputCost: 1.5 },
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B', description: 'Meta model', outputCost: 0.9 },
      { id: 'accounts/fireworks/models/qwen2-vl-72b-instruct', label: 'Qwen2 VL 72B', description: 'Multimodal', outputCost: 1.2 },
    ],
  },
  {
    id: 'alibaba',
    name: 'Alibaba',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    icon: <AlibabaCloudIcon />,
    models: [
      { id: 'qwen3.8-max', label: 'Qwen3.8 Max', description: 'Most capable', outputCost: 8 },
      { id: 'qwen3-max', label: 'Qwen3 Max', description: 'Previous gen', outputCost: 8 },
      { id: 'qwen-plus', label: 'Qwen Plus', description: 'Balanced model', outputCost: 4 },
    ],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    icon: <DeepInfraIcon />,
    models: [
      { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', label: 'Llama 4 Maverick 17B', description: 'Latest Llama', outputCost: 0.8 },
      { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', label: 'Llama 4 Scout 17B', description: 'Fast Llama', outputCost: 0.6 },
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', description: 'Previous gen', outputCost: 0.9 },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3', description: 'General purpose', outputCost: 1.5 },
      { id: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1', description: 'Reasoning model', outputCost: 5 },
      { id: 'Qwen/QwQ-32B', label: 'Qwen QwQ 32B', description: 'Alibaba model', outputCost: 0.5 },
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseURL: 'https://api.cerebras.ai/v1',
    icon: <CerebrasIcon />,
    models: [
      { id: 'llama3.3-70b', label: 'Llama 3.3 70B', description: 'Fast inference', outputCost: 0.6 },
      { id: 'gpt-oss-120b', label: 'GPT OSS 120B', description: 'Open source GPT', outputCost: 1.2 },
      { id: 'qwen-3-32b', label: 'Qwen 3 32B', description: 'Alibaba model', outputCost: 0.5 },
    ],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    baseURL: 'https://api-inference.huggingface.co/v1',
    icon: <HuggingFaceIcon />,
    models: [
      { id: 'meta-llama/Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B', description: 'Lightweight Llama', outputCost: 0.3 },
      { id: 'moonshotai/Kimi-K2-Instruct', label: 'Kimi K2 Instruct', description: 'Moonshot model', outputCost: 0.8 },
    ],
  },
  {
    id: 'baseten',
    name: 'Baseten',
    baseURL: 'https://api.baseten.co/v1',
    icon: <BasetenIcon />,
    models: [
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', label: 'Qwen3 235B', description: 'Large MoE model', outputCost: 2 },
      { id: 'deepseek-ai/DeepSeek-V3.1', label: 'DeepSeek V3.1', description: 'Latest DeepSeek', outputCost: 1.5 },
      { id: 'moonshotai/Kimi-K2-Instruct-0905', label: 'Kimi K2 Instruct', description: 'Moonshot model', outputCost: 1 },
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    icon: <NvidiaIcon />,
    models: [
      { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', description: 'Meta Llama 3.3 70B Instruct', outputCost: 0.88 },
      { id: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B', description: 'Meta Llama 3.1 405B Instruct', outputCost: 6 },
      { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1', description: 'DeepSeek R1 reasoning model', outputCost: 8 },
      { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B', description: 'Alibaba Qwen3 MoE model', outputCost: 1.5 },
    ],
  },
  {
    id: 'fibonacci',
    name: 'Fibonacci',
    baseURL: 'https://my.fibonacci.monster/api/v1',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="#FE03C3" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <path d="M 6.35 6.63 L 6.58 6.61 L 6.82 6.69 L 7.05 6.87 L 7.20 7.16 L 7.22 7.53 L 7.09 7.93 L 6.78 8.29 L 6.30 8.52 L 5.70 8.56 L 5.06 8.34 L 4.49 7.82 L 4.12 7.04 L 4.07 6.05 L 4.46 5.01 L 5.31 4.10 L 6.60 3.52 L 8.20 3.48 L 9.88 4.13 L 11.34 5.54 L 12.25 7.66 L 12.27 10.25 L 11.16 12.97" />
      </svg>
    ),
    models: [
      { id: 'fibonacci-1-pro-max', label: 'Fibonacci 1 Pro Max', description: 'Economy model', outputCost: 1 },
      { id: 'fibonacci-2-coder', label: 'Fibonacci 2 Coder', description: 'Code generation', outputCost: 2 },
      { id: 'fibonacci-1-agentic', label: 'Fibonacci 1 Agentic', description: 'Professional agentic model', outputCost: 7 },
    ],
  },
];

/** Generic code-brackets mark for custom (non-predefined) providers. */
const CustomProviderIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5 text-text-muted' }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />
  </svg>
);

export const ProvidersSection: React.FC<{
  config: AgentConfig;
  providers: ProviderConfig[];
  onProvidersChange: (v: ProviderConfig[]) => void;
  t: (k: string) => string;
}> = ({ config, providers, onProvidersChange, t }) => {
  const [connectModal, setConnectModal] = useState<PredefinedProvider | null>(null);
  const [customModal, setCustomModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newProvider, setNewProvider] = useState<ProviderConfig>({
    id: '', name: '', baseURL: '', apiKey: '', models: [], enabled: true,
  });
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { providerId, ok, error } = e.detail;
      setTestResults((prev) => ({ ...prev, [providerId]: { ok, error } }));
      setTestingIds((prev) => {
        if (!prev.has(providerId)) return prev;
        const next = new Set(prev);
        next.delete(providerId);
        return next;
      });
    };
    window.addEventListener('PROVIDER_TEST_RESULT', handler as EventListener);
    return () => window.removeEventListener('PROVIDER_TEST_RESULT', handler as EventListener);
  }, []);

  /** Drop any cached test result for a provider — its config changed, so the
   *  old verdict is stale and must not stick to the (re)created row. */
  const clearTestState = (id: string) => {
    setTestResults((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const isConnected = (providerId: string) => providers.some((p) => p.id === providerId && p.enabled);

  const connectProvider = (provider: PredefinedProvider, apiKey: string) => {
    clearTestState(provider.id);
    const existing = providers.find((p) => p.id === provider.id);
    if (existing) {
      onProvidersChange(providers.map((p) => p.id === provider.id ? { ...p, apiKey, enabled: true } : p));
    } else {
      onProvidersChange([...providers, {
        id: provider.id,
        name: provider.name,
        baseURL: provider.baseURL,
        apiKey,
        models: provider.models,
        enabled: true,
      }]);
    }
    setConnectModal(null);
  };

  const disconnectProvider = (id: string) => {
    onProvidersChange(providers.map((p) => p.id === id ? { ...p, enabled: false } : p));
  };

  const reconnectProvider = (id: string) => {
    onProvidersChange(providers.map((p) => p.id === id ? { ...p, enabled: true } : p));
  };

  const removeProvider = (id: string) => {
    onProvidersChange(providers.filter((p) => p.id !== id));
  };

  const addCustomProvider = () => {
    if (!newProvider.name || !newProvider.baseURL) return;
    const id = newProvider.name.toLowerCase().replace(/\s+/g, '-');
    onProvidersChange([...providers, { ...newProvider, id }]);
    setNewProvider({ id: '', name: '', baseURL: '', apiKey: '', models: [], enabled: true });
    setCustomModal(false);
  };

  const startEdit = (p: ProviderConfig) => {
    setEditingId(p.id);
    setNewProvider({ ...p });
  };

  const saveEdit = () => {
    if (!newProvider.name || !newProvider.baseURL) return;
    clearTestState(editingId ?? '');
    onProvidersChange(providers.map((p) => p.id === editingId ? { ...newProvider } : p));
    setEditingId(null);
    setNewProvider({ id: '', name: '', baseURL: '', apiKey: '', models: [], enabled: true });
  };

  /** Test the CURRENT DRAFT entry — not the saved config — so the result
   *  reflects unsaved edits (new key typed in the edit modal, etc.). */
  const testConnection = (p: ProviderConfig) => {
    setTestingIds((prev) => new Set(prev).add(p.id));
    postToHost({ type: 'TEST_PROVIDER_CONNECTION', providerId: p.id, provider: p });
  };

  return (
    <div className="space-y-6">
      {/* Connected providers */}
      {providers.filter((p) => p.enabled).length > 0 && (
        <Section title={t('providers.connected') || 'Connected'}>
          <div className="space-y-2">
            {providers.filter((p) => p.enabled).map((p) => {
              const test = testResults[p.id];
              const testing = testingIds.has(p.id);
              const predefined = PREDEFINED_PROVIDERS.find((pp) => pp.id === p.id);
              return (
                <div key={p.id} className={`border rounded-card bg-input overflow-hidden ${
                  test ? (test.ok ? 'border-status-success/30' : 'border-status-error/40')
                       : 'border-status-success/30'
                }`}>
                  <div className="flex items-center justify-between px-3 py-2.5 bg-status-success/5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-9 h-9 rounded-lg bg-elevated-2 border border-border-subtle flex items-center justify-center shrink-0">
                        {predefined?.icon || <CustomProviderIcon />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-sm text-text-primary">{p.name}</span>
                          {testing ? (
                            <span className="text-2xs text-text-muted animate-pulse">{t('providers.testing') || 'Testing…'}</span>
                          ) : test ? (
                            <StatusDot ok={test.ok} />
                          ) : (
                            <StatusDot ok={true} />
                          )}
                        </div>
                        <div className="text-2xs text-text-muted truncate" dir="ltr">{p.baseURL}</div>
                      </div>
                    </div>
                    <div className="flex gap-1.5 shrink-0 items-center">
                      <IconButton icon={<PlugIcon />} label={t('providers.test')} onClick={() => testConnection(p)} disabled={testing} />
                      <IconButton icon={<PencilIcon />} label={t('common.edit') || 'Edit'} onClick={() => startEdit(p)} />
                      <IconButton icon={<PowerIcon />} label={t('providers.disconnect') || 'Disconnect'} variant="danger" onClick={() => disconnectProvider(p.id)} />
                    </div>
                  </div>
                  {test && !test.ok && test.error && (
                    <div className="px-3 py-1.5 text-2xs text-status-error border-t border-border-subtle">
                      {test.error}
                    </div>
                  )}
                  {p.models.length > 0 && (
                    <div className="px-3 py-2 text-2xs text-text-muted border-t border-border-subtle">
                      {p.models.map((m) => m.label).join(' · ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Available providers */}
      <Section title={t('providers.available') || 'Available Providers'}>
        <div className="grid grid-cols-1 gap-2">
          {PREDEFINED_PROVIDERS.map((provider) => {
            const connected = isConnected(provider.id);
            const connectedEntry = providers.find((p) => p.id === provider.id);
            const test = connectedEntry ? testResults[connectedEntry.id] : undefined;
            const testing = connectedEntry ? testingIds.has(connectedEntry.id) : false;
            return (
              <div key={provider.id} className={`border rounded-card bg-input overflow-hidden transition-colors duration-fast ${
                connected ? 'border-status-success/30' : 'border-border-subtle hover:border-border-input'
              }`}>
                <div className="flex items-center justify-between px-3 py-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-elevated-2 border border-border-subtle flex items-center justify-center shrink-0">
                      {provider.icon}
                    </div>
                    <div className="min-w-0">
                      <span className="font-medium text-sm text-text-primary">{provider.name}</span>
                      <div className="text-2xs text-text-muted">{provider.models.length} {t('providers.models') || 'models'}</div>
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0 items-center">
                    {connected ? (
                      <>
                        {testing ? (
                          <span className="text-2xs text-text-muted animate-pulse">{t('providers.testing') || 'Testing…'}</span>
                        ) : test ? (
                          <StatusDot ok={test.ok} />
                        ) : (
                          <StatusDot ok={true} />
                        )}
                        <span className="text-2xs text-status-success">{t('providers.connected') || 'Connected'}</span>
                      </>
                    ) : (
                      <IconButton
                        icon={<PlusIcon />}
                        label={`+ ${t('providers.connect') || 'Connect'}`}
                        variant="primary"
                        onClick={() => setConnectModal(provider)}
                      />
                    )}
                  </div>
                </div>
                {test && !test.ok && test.error && connected && (
                  <div className="px-3 py-1.5 text-2xs text-status-error border-t border-border-subtle">
                    {test.error}
                  </div>
                )}
                {connected && (
                  <div className="px-3 py-1.5 text-2xs text-text-muted border-t border-border-subtle bg-elevated-2/30">
                    {provider.models.map((m) => m.label).join(' · ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {/* Custom provider */}
      <Section title={t('providers.custom') || 'Custom Provider'}>
        <Button variant="secondary" onClick={() => setCustomModal(true)} className="w-full">
          + {t('providers.addCustom') || 'Add Custom Provider'}
        </Button>
      </Section>

      {/* Connect Modal */}
      {connectModal && (
        <ConnectModal
          provider={connectModal}
          onConnect={(apiKey) => connectProvider(connectModal, apiKey)}
          onClose={() => setConnectModal(null)}
          t={t}
        />
      )}

      {/* Custom Provider Modal */}
      {customModal && (
        <CustomProviderModal
          provider={newProvider}
          onChange={setNewProvider}
          onConnect={addCustomProvider}
          onClose={() => setCustomModal(false)}
          t={t}
        />
      )}

      {/* Edit Modal */}
      {editingId && (
        <CustomProviderModal
          provider={newProvider}
          onChange={setNewProvider}
          onConnect={saveEdit}
          onClose={() => { setEditingId(null); setNewProvider({ id: '', name: '', baseURL: '', apiKey: '', models: [], enabled: true }); }}
          t={t}
          isEdit
        />
      )}
    </div>
  );
};

/* ── Connect Modal ── */
const ConnectModal: React.FC<{
  provider: PredefinedProvider;
  onConnect: (apiKey: string) => void;
  onClose: () => void;
  t: (k: string) => string;
}> = ({ provider, onConnect, onClose, t }) => {
  const [apiKey, setApiKey] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="bg-panel border border-border-subtle rounded-card shadow-lg w-96 max-w-[90vw] animate-scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-elevated-2 border border-border-subtle flex items-center justify-center shrink-0">
              {provider.icon}
            </div>
            <div>
              <h3 className="font-medium text-sm text-text-primary">{provider.name}</h3>
              <p className="text-2xs text-text-muted">{t('providers.connectTo') || 'Connect to'} {provider.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary p-1">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="text-xs text-text-secondary block mb-1.5">{t('settings.apiKey') || 'API Key'}</label>
            <MaskedInput
              value={apiKey}
              onChange={setApiKey}
              placeholder={`Enter your ${provider.name} API key`}
            />
          </div>
          <div className="text-2xs text-text-muted">
            <div className="font-medium text-text-secondary mb-1">{t('providers.includedModels') || 'Included models'}:</div>
            <div className="flex flex-wrap gap-1">
              {provider.models.map((m) => (
                <span key={m.id} className="px-1.5 py-0.5 bg-elevated-2 rounded text-text-tertiary">
                  {m.label}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-2 px-4 py-3 border-t border-border-subtle">
          <Button onClick={onClose} className="flex-1">{t('common.cancel') || 'Cancel'}</Button>
          <Button variant="primary" onClick={() => onConnect(apiKey)} disabled={!apiKey.trim()} className="flex-1">
            {t('providers.connect') || 'Connect'}
          </Button>
        </div>
      </div>
    </div>
  );
};

/* ── Custom Provider Modal ── */
const CustomProviderModal: React.FC<{
  provider: ProviderConfig;
  onChange: (p: ProviderConfig) => void;
  onConnect: () => void;
  onClose: () => void;
  t: (k: string) => string;
  isEdit?: boolean;
}> = ({ provider, onChange, onConnect, onClose, t, isEdit }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="bg-panel border border-border-subtle rounded-card shadow-lg w-96 max-w-[90vw] animate-scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <h3 className="font-medium text-sm text-text-primary">
            {isEdit ? (t('common.edit') || 'Edit') : (t('providers.addCustom') || 'Add Custom Provider')}
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary p-1">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-text-secondary block mb-1">{t('providers.name') || 'Name'}</label>
            <TextInput
              value={provider.name}
              onChange={(v) => onChange({ ...provider, name: v })}
              placeholder="My Provider"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">Base URL</label>
            <TextInput
              value={provider.baseURL}
              onChange={(v) => onChange({ ...provider, baseURL: v })}
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">{t('settings.apiKey') || 'API Key'}</label>
            <MaskedInput
              value={provider.apiKey}
              onChange={(v) => onChange({ ...provider, apiKey: v })}
              placeholder="sk-..."
            />
          </div>
        </div>
        <div className="flex gap-2 px-4 py-3 border-t border-border-subtle">
          <Button onClick={onClose} className="flex-1">{t('common.cancel') || 'Cancel'}</Button>
          <Button variant="primary" onClick={onConnect} disabled={!provider.name || !provider.baseURL} className="flex-1">
            {isEdit ? (t('common.save') || 'Save') : (t('providers.connect') || 'Connect')}
          </Button>
        </div>
      </div>
    </div>
  );
};
