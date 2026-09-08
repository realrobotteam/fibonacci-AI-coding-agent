import React, { useEffect, useState } from 'react';
import { useStore } from './store/useStore';
import type { HostToWebviewMessage } from '@shared/index';
import { Chat } from './components/Chat';
import { SettingsPanel } from './components/SettingsPanel';
import { postMessage as postToHost } from './vscodeApi';
import { Header } from './components/Header';
import { HistoryPanel } from './components/HistoryPanel';
import { fill } from './lib/format';

// Read the CURRENT translator inside the message handler — the effect would
// otherwise keep a stale `t` (and re-subscribe on every locale change).
const getT = () => useStore.getState().t;

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
  const setSkills = useStore((s) => s.setSkills);
  const setModeSwitchRequest = useStore((s) => s.setModeSwitchRequest);
  const setError = useStore((s) => s.setError);
  const setToolList = useStore((s) => s.setToolList);
  const setApprovalDiff = useStore((s) => s.setApprovalDiff);
  const attachCheckpoint = useStore((s) => s.attachCheckpoint);
  const setCondensing = useStore((s) => s.setCondensing);
  const setWorkspaceFiles = useStore((s) => s.setWorkspaceFiles);
  const setNotice = useStore((s) => s.setNotice);
  const notice = useStore((s) => s.notice);
  const [theme, setTheme] = useState<'light' | 'dark' | 'high-contrast'>('dark');
  const [showHistory, setShowHistory] = useState(false);

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
          // FIX (e.filter crash): reject non-array payloads at the boundary.
          setTodos(Array.isArray(msg.todos) ? msg.todos : []);
          break;
        case 'MODE_SWITCH_REQUEST':
          setModeSwitchRequest(msg.request);
          break;
        case 'SKILLS':
          setSkills(msg.skills);
          break;
        case 'THEME_CHANGE':
          setTheme(msg.theme);
          break;
        case 'MCP_TOOLS':
          break;
        case 'TOOL_LIST':
          setToolList(msg.tools);
          break;
        case 'PROVIDER_TEST_RESULT':
          window.dispatchEvent(new CustomEvent('PROVIDER_TEST_RESULT', { detail: msg }));
          break;
        case 'SETTINGS_EXPORT':
          window.dispatchEvent(new CustomEvent('SETTINGS_EXPORT', { detail: msg }));
          break;
        case 'IMPROVED_PROMPT':
          // The Chat component will handle this via a custom event
          window.dispatchEvent(new CustomEvent('IMPROVED_PROMPT', { detail: msg }));
          break;
        case 'SKILL_INSTALL_RESULT':
          // SkillsSection listens for the explicit install outcome instead of
          // inferring it from the skills list length.
          window.dispatchEvent(new CustomEvent('SKILL_INSTALL_RESULT', { detail: msg }));
          break;
        case 'APPROVAL_DIFF_DATA':
          setApprovalDiff(msg.requestId, { path: msg.path, before: msg.before, after: msg.after });
          break;
        case 'CHECKPOINT':
          attachCheckpoint(msg.checkpoint);
          break;
        case 'CHECKPOINT_RESTORED':
          if (msg.restored > 0) {
            setNotice(fill(getT()('checkpoint.restored'), { n: msg.restored }));
          } else {
            // Show the first host-provided error when available.
            setNotice(msg.errors?.[0] ?? getT()('checkpoint.restoreFailed'));
          }
          break;
        case 'CONDENSE_RESULT':
          setCondensing(false);
          setNotice(
            msg.ok && msg.beforeTokens !== undefined && msg.afterTokens !== undefined
              ? fill(getT()('context.condenseDone'), { a: msg.beforeTokens, b: msg.afterTokens })
              : msg.ok
                ? getT()('context.condense')
                : getT()('context.condenseFailed')
          );
          break;
        case 'EXPORT_RESULT':
          setNotice(
            msg.ok
              ? fill(getT()('history.exportDone'), {}) + (msg.path ? ` · ${msg.path}` : '')
              : getT()('history.exportFailed')
          );
          break;
        case 'FORK_CREATED':
          setNotice(getT()('message.forkDone'));
          break;
        case 'WORKSPACE_FILES':
          setWorkspaceFiles(msg.files);
          break;
      }
    };
    window.addEventListener('message', handler);
    postToHost({ type: 'GET_STATE' });
    postToHost({ type: 'GET_HISTORY' });
    postToHost({ type: 'GET_SKILLS' });
    return () => window.removeEventListener('message', handler);
  }, [hydrate, append, update, removeMsg, addApproval, resolveApproval, setModels, setConfig, setMcpServers, setHistory, setTodos, setSkills, setModeSwitchRequest, setError, setToolList, setApprovalDiff, attachCheckpoint, setCondensing, setWorkspaceFiles, setNotice]);

  // Auto-dismiss the toast notice after 3.5s.
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice?.ts, setNotice]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  const config = useStore((s) => s.config);

  useEffect(() => {
    const uiStyle = config?.uiStyle ?? 'default';
    document.documentElement.setAttribute('data-ui-style', uiStyle);
    document.body.setAttribute('data-ui-style', uiStyle);
  }, [config?.uiStyle]);

  // FIX (broken opacity modifiers): sync the RGB-channel CSS variables that
  // back Tailwind's alpha modifiers (bg-brand/10, border-status-error/20…)
  // from the live VS Code theme colors.
  useEffect(() => {
    const syncColorChannels = () => {
      const channels: Record<string, string> = {
        '--fib-brand-rgb': 'var(--vscode-button-background, #007acc)',
        '--fib-status-success-rgb': 'var(--vscode-terminal-ansiGreen, #4ec9b0)',
        '--fib-status-warning-rgb': 'var(--vscode-editorWarning-foreground, #cca700)',
        '--fib-status-error-rgb': 'var(--vscode-editorError-foreground, #f48771)',
        '--fib-status-info-rgb': 'var(--vscode-textLink-foreground, #3794ff)',
        '--fib-elevated-rgb': 'var(--vscode-editorWidget-background, #252526)',
        '--fib-elevated-2-rgb': 'var(--vscode-list-inactiveSelectionBackground, #2a2d2e)',
        '--fib-input-rgb': 'var(--vscode-input-background, #3c3c3c)',
      };
      for (const [channelVar, sourceVar] of Object.entries(channels)) {
        // Resolve the var() reference to an actual color value.
        const probe = document.createElement('span');
        probe.style.color = sourceVar;
        document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color;
        probe.remove();
        const m = rgb.match(/(\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          document.documentElement.style.setProperty(channelVar, `${m[1]} ${m[2]} ${m[3]}`);
        }
      }
    };
    syncColorChannels();
  }, [theme]);

  const handleHistoryClick = () => {
    setShowHistory(true);
  };

  const handleHistoryClose = () => {
    setShowHistory(false);
  };

  const handleLoadChat = (chatId: string) => {
    postToHost({ type: 'LOAD_CHAT', chatId });
    setShowHistory(false);
  };

  const handleDeleteChat = (chatId: string) => {
    postToHost({ type: 'DELETE_CHAT', chatId });
  };

  const handleRenameChat = (chatId: string, newTitle: string) => {
    postToHost({ type: 'RENAME_CHAT', chatId, title: newTitle });
  };

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--vscode-sideBar-background, #252526)' }}>
      <Header
        onNavigate={setActiveTab}
        activeTab={activeTab}
        showHistoryButton={activeTab === 'chat'}
        onHistoryClick={handleHistoryClick}
      />
      <div className="flex-1 flex flex-col min-h-0 relative">
        {activeTab === 'chat' && <Chat onLoadChat={handleLoadChat} />}
        {activeTab === 'settings' && <SettingsPanel />}
        {showHistory && (
          <HistoryPanel
            onClose={handleHistoryClose}
            onLoadChat={handleLoadChat}
            onDeleteChat={handleDeleteChat}
            onRenameChat={handleRenameChat}
          />
        )}
      </div>
      {notice && (
        <div
          role="status"
          className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[100] max-w-[90%] bg-elevated border border-border-subtle rounded-button px-3 py-1.5 text-2xs text-text-secondary shadow-md animate-slide-up"
        >
          {notice.text}
        </div>
      )}
    </div>
  );
};
