import React, { useEffect } from 'react';
import { useStore } from './store/useStore';
import type { HostToWebviewMessage } from '@shared/index';
import { Chat } from './components/Chat';
import { SettingsPanel } from './components/SettingsPanel';
import { postMessage as postToHost } from './vscodeApi';
import { Header } from './components/Header';

export const App: React.FC = () => {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const hydrate = useStore((s) => s.hydrateFromState);
  const append = useStore((s) => s.appendMessage);
  const update = useStore((s) => s.updateMessage);
  const removeMsg = useStore((s) => s.removeMessage);
  const addApproval = useStore((s) => s.addApproval);
  const resolveApproval = useStore((s) => s.resolveApproval);
  const setModels = useStore((s) => s.setModels);
  const setConfig = useStore((s) => s.setConfig);
  const setMcpServers = useStore((s) => s.setMcpServers);
  const setHistory = useStore((s) => s.setHistory);
  const setTodos = useStore((s) => s.setTodos);
  const setModeSwitchRequest = useStore((s) => s.setModeSwitchRequest);
  const setError = useStore((s) => s.setError);

  useEffect(() => {
    const handler = (e: MessageEvent<HostToWebviewMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'STATE':
          hydrate(msg.state);
          break;
        case 'MESSAGE_APPEND':
          append(msg.message);
          break;
        case 'MESSAGE_UPDATE':
          update(msg.message);
          break;
        case 'MESSAGE_REMOVE':
          removeMsg(msg.id);
          break;
        case 'APPROVAL_REQUEST':
          addApproval(msg.request);
          break;
        case 'APPROVAL_RESOLVED':
          resolveApproval(msg.id, msg.approved);
          break;
        case 'TOOL_START':
          append(msg.message);
          break;
        case 'TOOL_END':
          update(msg.message);
          break;
        case 'ERROR':
          setError(msg.message);
          break;
        case 'MODELS':
          setModels(msg.models, msg.current);
          break;
        case 'CONFIG':
          setConfig(msg.config);
          break;
        case 'MCP_SERVERS':
          setMcpServers(msg.servers);
          break;
        case 'HISTORY':
          setHistory(msg.entries);
          break;
        case 'TODOS_UPDATE':
          setTodos(msg.todos);
          break;
        case 'MODE_SWITCH_REQUEST':
          setModeSwitchRequest(msg.request);
          break;
        case 'MCP_TOOLS':
          break;
      }
    };
    window.addEventListener('message', handler);
    postToHost({ type: 'GET_STATE' });
    postToHost({ type: 'GET_HISTORY' });
    return () => window.removeEventListener('message', handler);
  }, [hydrate, append, update, removeMsg, addApproval, resolveApproval, setModels, setConfig, setMcpServers, setHistory, setTodos, setModeSwitchRequest, setError]);

  return (
    <div className="flex flex-col h-screen bg-panel">
      <Header onNavigate={setActiveTab} activeTab={activeTab} />
      <div className="flex-1 flex flex-col min-h-0">
        {activeTab === 'chat' && <Chat />}
        {activeTab === 'settings' && <SettingsPanel />}
      </div>
    </div>
  );
};
