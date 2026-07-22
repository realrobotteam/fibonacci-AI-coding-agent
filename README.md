# Fibonacci AI Agent — VS Code Extension

An autonomous AI coding agent for the **Fibonacci AI platform** that lives in the VS Code sidebar. Built with TypeScript + React + Tailwind CSS, with full **Persian (RTL)** UI support.

**Version:** 2.1.0 | **VS Code:** 1.85+ | **UI:** Persian (RTL)

## What's New in v2.0.0

This is a massive upgrade inspired by the [Hermes Agent](https://github.com/NousResearch/hermes-agent) architecture. Highlights:

### 🧠 Hermes Chat-Template Support
The agent now fully supports the Hermes chat template format:
- Tool calls use `<|tool_call>call:name{args}<tool_call|>` syntax (native to Hermes-trained models)
- Tool results fed back as `<|tool_response>response:name{value:"..."}<tool_response|>`
- Reasoning channel `<|channel>thought\n...\n<channel|>` is extracted and shown in a collapsible "استدلال" block in the UI
- A complete TypeScript port of the Jinja template is in `src/core/hermesTemplate.ts` (renders the exact byte sequence the Jinja template would produce, for debug logging)
- Backwards compatible: a `fibonacci.hermesMode` setting toggles between Hermes and the legacy XML tool-call format

### 🛠️ 30+ Tools (was 13)
New tool families:

| Family | Tools |
|--------|-------|
| **Web** | `web_fetch`, `web_search` |
| **Search** | `grep_search` (regex + context lines), `glob_files` (filename patterns) |
| **Git** | `git_status`, `git_diff`, `git_log` (all read-only) |
| **Editor intelligence** | `diagnostics`, `format_code`, `document_symbols`, `workspace_symbols`, `code_actions`, `open_file` |
| **Code edit** | `insert_at_line`, `delete_lines`, `append_to_file` (in addition to `write_to_file`, `replace_in_file`) |
| **Reasoning** | `think` (a scratchpad for explicit planning) |
| **Skills** | `list_skills`, `view_skill`, `invoke_skill` |

### 📚 Skills System
Reusable multi-step procedures (inspired by Hermes skills). Built-in:
- `debug-error` — systematic debug procedure (reproduce → locate → diagnose → fix → verify)
- `refactor-extract` — extract a function from duplicated code
- `write-tests` — generate a test suite for a function/module
- `explain-code` — explain a codebase in Persian
- `plan-feature` — plan a new feature end-to-end
- `safe-edit` — read → locate → edit → verify pattern

### 🎯 Hermes-Grade System Prompt
A three-tier prompt architecture (stable / context / volatile) mirroring the Hermes Agent design, with explicit guidance for:
- **Tool-use enforcement** — never describe, always act
- **Execution discipline** — `<tool_persistence>`, `<mandatory_tool_use>`, `<act_dont_ask>`, `<prerequisite_checks>`, `<verification>`, `<missing_context>`
- **Task completion** — ship working artifacts, never fabricate
- **Parallel tool calls** — batch independent calls
- **Error recovery** — honest reporting + alternative retry

### ⚙️ New Configuration
| Setting | Default | Description |
| --- | --- | --- |
| `fibonacci.hermesMode` | `true` | Use Hermes tool-call format |
| `fibonacci.showReasoning` | `true` | Show the model's reasoning channel in the UI |
| `fibonacci.parallelToolCalls` | `true` | Allow concurrent execution of independent tool calls |

---

## Features

### 🤖 Autonomous AI Agent
- **Sidebar chat** with streaming responses from Fibonacci LLMs
- **Two models**: `fibonacci-1-pro-max` (economy) and `fibonacci-1-agentic` (professional)
- **Two modes**: Coding mode (write/edit/run) and Plan mode (read-only analysis)
- **Persian RTL UI** with Vazirmatn font
- **Dual tool-call formats**: Hermes (`<|tool_call>call:...{...}<tool_call|>`) and legacy XML (Cline-style)

### 🛠️ 13 Built-in Tools
- **File**: `read_file`, `write_to_file`, `replace_in_file` (SEARCH/REPLACE), `list_files`, `search_files`
- **Terminal**: `execute_command`, `run_in_terminal`, `get_command_output`
- **MCP**: `list_mcp_tools`, `call_mcp_tool`, `get_mcp_resources`, `manage_mcp_servers`
- **Todo**: `update_todos` — AI creates visible task checklists for multi-step work

### 🎨 Cline/Roo Code-Inspired UI
- Flat design, VS Code-native colors, no shadows
- Mascot-led empty state with Fibonacci spiral logo
- Compact activity indicators: `📖 reading index.html  ✓`
- Inline approval dialogs (no modals)
- Chat history with persistence (up to 50 recent chats)
- Todo list panel with progress bar

### 🔒 Approval-First Flow
- Destructive operations (write, edit, execute) require user approval
- **Code is NEVER shown in chat** — only file path + status
- Approval dialog shows only the target (path/command), not full code
- Read-only tools can be auto-approved, with configurable approval mode (none / read-only / all)

### 🌐 Persian Language Support
- Full RTL layout via `tailwindcss-rtl`
- Vazirmatn font from CDN
- All UI text translated (fa + en fallback)
- Persian system prompt instructions
- Persian date/time formatting in chat history

---

## Quick Start

### Prerequisites
- Node.js 18+
- npm or yarn
- VS Code 1.85+

### Build from Source

```bash
# 1. Clone or extract the source
cd fibonacci-agent

# 2. Install dependencies
npm install

# 3. Build the webview (React + Vite)
npm run build:webview

# 4. Compile the extension host (esbuild)
npm run compile

# 5. Package as .vsix
npx @vscode/vsce package --no-git-tag-version --allow-missing-repository --skip-license
```

This produces `fibonacci-agent-0.1.0.vsix`.

### Install the Extension

```bash
# Via CLI
code --install-extension fibonacci-agent-0.1.0.vsix

# Or in VS Code:
# Extensions panel → ⋯ menu → Install from VSIX
```

Then **reload VS Code** (Ctrl+Shift+P → "Developer: Reload Window").

### Configure

1. Click the Fibonacci spiral icon in the activity bar
2. Click the gear icon in the header
3. Enter your Fibonacci API key
4. (Optional) Add MCP servers in the Settings → MCP section
5. Start chatting!

---

## Configuration

Open **Settings → Fibonacci** or edit `settings.json`:

| Setting | Default | Description |
| --- | --- | --- |
| `fibonacci.apiKey` | `""` | Fibonacci API key (required) |
| `fibonacci.baseURL` | `http://my.fibonacci.monster/api/v1` | API base URL |
| `fibonacci.defaultModel` | `fibonacci-1-pro-max` | Default (economy) model |
| `fibonacci.professionalModel` | `fibonacci-1-agentic` | Professional model |
| `fibonacci.language` | `fa` | UI language (`fa` or `en`) |
| `fibonacci.enableMCP` | `true` | Enable MCP integration |
| `fibonacci.autoApproveMode` | `none` | Auto-approve mode (`none`, `read-only`, `all`) |
| `fibonacci.maxIterations` | `25` | Max agent loop iterations |
| `fibonacci.mcpServers` | `[]` | MCP server configurations |

---

## Architecture

```
fibonacci-agent/
├── package.json              # Extension manifest, settings, commands
├── esbuild.js                # Extension host bundler config
├── vite.config.ts            # Webview bundler config
├── tailwind.config.js        # Design tokens (Fibonacci magenta #FE03C3)
├── tsconfig.json             # Host TypeScript config
├── tsconfig.webview.json     # Webview TypeScript config
├── media/
│   └── fibonacci-icon.svg    # Spiral logo (magenta #FE03C3)
└── src/
    ├── extension.ts           # Activation, commands, config
    ├── webviewProvider.ts     # Webview lifecycle, history, message bus
    ├── api/
    │   └── fibonacciClient.ts # OpenAI SDK wrapper (streaming + tool calls)
    ├── core/
    │   ├── agentLoop.ts       # Chat → tool → result → chat cycle
    │   ├── toolParser.ts      # XML tool-call parser (Cline-style)
    │   ├── toolRegistry.ts    # Tool definition + executor registry
    │   └── approvalManager.ts # Auto-approve / interactive approval
    ├── tools/
    │   ├── fileTools.ts       # read/write/replace/list/search
    │   ├── terminalTools.ts   # execute/run_in_terminal/get_output
    │   ├── mcpTools.ts        # JSON-RPC over stdio MCP client
    │   └── todoTools.ts       # Todo list tool
    ├── types/
    │   └── index.ts           # Shared types (host ↔ webview)
    └── webview/               # React + Zustand + Tailwind (RTL)
        ├── App.tsx            # Root component
        ├── vscodeApi.ts       # acquireVsCodeApi singleton
        ├── main.tsx           # React entry
        ├── i18n/
        │   └── translations.ts # Persian + English strings
        ├── store/
        │   └── useStore.ts    # Zustand store
        ├── styles/
        │   └── index.css      # Tailwind + custom CSS
        └── components/
            ├── Header.tsx     # Logo + brand + actions
            ├── Chat.tsx       # Message list + empty state + history
            ├── InputArea.tsx  # Composer + model/mode dropdowns
            ├── MessageBubble.tsx # User/assistant messages + tool blocks
            ├── ApprovalDialog.tsx # Inline approval UI
            ├── TodoList.tsx   # Task checklist panel
            ├── SettingsPanel.tsx # Settings + MCP management
            └── Markdown.tsx   # Lightweight markdown renderer
```

---

## How It Works

### 1. Tool Calling Protocol

The Fibonacci API doesn't reliably populate the OpenAI `tool_calls` field. Instead, the agent uses **XML-based tool calls** (Cline-style):

```
<write_to_file>
<path>index.html</path>
<content>
<!DOCTYPE html>
<html>...
</content>
</write_to_file>
```

The `toolParser.ts` extracts these blocks from the assistant's text response, and the `agentLoop.ts` executes them. The raw XML is **stripped from the chat** — the user only sees clean prose.

### 2. Approval Flow

```
AI emits tool call → ApprovalManager decides:
  • autoApproveMode='all' → auto-run any tool
  • autoApproveMode='read-only' AND tool is read-only → auto-run
  • Otherwise → show approval dialog
User approves → tool runs → result fed back to AI
User rejects → rejection fed back to AI
```

### 3. Streaming with Code Hiding

During streaming, the agent buffers raw content and sends only **cleaned prose** to the webview. Incomplete XML blocks are stripped in real-time, so the user never sees partial tool calls or code.

### 4. Todo Lists

For multi-step tasks, the AI calls `update_todos` with a full task list. The webview renders a progress panel above the chat:
- Progress bar (X/Y completed)
- Each item: pending (○), in_progress (pulsing dot + activeForm), completed (✓)

### 5. Plan Mode vs Coding Mode

- **Coding mode**: Full tool access — read, write, edit, execute
- **Plan mode**: Read-only — only `read_file`, `list_files`, `search_files`. The AI produces a structured plan in Persian without changing any files.

### 6. Chat History

Chats are auto-saved to VS Code's `globalState` (persists across sessions). The empty state shows the 10 most recent chats with title, relative time, and message count. Click to load, hover to delete.

---

## Development

### Watch Mode

```bash
# Watch both extension host + webview
npm run watch

# Or separately:
npm run watch:esbuild   # Extension host
npm run watch:webview   # Webview (vite build --watch)
```

### Debug in VS Code

Press `F5` to launch an Extension Development Host with the extension loaded.

### Typecheck

```bash
npx tsc --noEmit                    # Host
npx tsc --noEmit -p tsconfig.webview.json  # Webview
```

### Lint

```bash
npx eslint src --ext ts
```

---

## Commands

| Command | Description |
| --- | --- |
| `Fibonacci: پیکربندی تنظیمات` | Open Fibonacci settings |
| `Fibonacci: افزودن سرور MCP` | Add an MCP server |
| `Fibonacci: گفت‌وگوی جدید` | Start a new chat |
| `Fibonacci: تعویض مدل` | Switch AI model |

---

## MCP Server Configuration

Add MCP servers in Settings → MCP section, or via `settings.json`:

```json
{
  "fibonacci.mcpServers": [
    {
      "name": "playwright",
      "command": "npx",
      "args": ["@anthropic-ai/mcp-server-playwright"]
    },
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["@anthropic-ai/mcp-server-filesystem", "/path/to/allowed/dir"]
    }
  ]
}
```

Each server is spawned as a child process speaking JSON-RPC over stdio (protocol version `2024-11-05`). Tools are auto-discovered and exposed to the AI via `list_mcp_tools` / `call_mcp_tool`.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript (strict mode) |
| Extension Host | VS Code Extension API |
| Webview UI | React 18 + Vite 5 |
| Styling | Tailwind CSS 3 + tailwindcss-rtl |
| State | Zustand 4 |
| LLM SDK | OpenAI SDK 4 (pointed at Fibonacci) |
| MCP | Custom JSON-RPC client over stdio |
| Bundler (host) | esbuild |
| Bundler (webview) | Vite |
| i18n | Custom (fa + en) |

---

## Troubleshooting

### "Could not register service worker"
The CSP was too strict. Fixed in latest version — `script-src` now allows `${webview.cspSource}`.

### "Cannot find module 'openai'"
Dependencies weren't bundled. Fixed in latest version — esbuild bundles everything except `vscode`.

### "An instance of the VS Code API has already been acquired"
Multiple `acquireVsCodeApi()` calls. Fixed in latest version — singleton in `vscodeApi.ts`.

### AI writes code in chat instead of creating files
The system prompt teaches XML tool-call format. If the AI still misbehaves, the enforcement layer retries with `tool_choice: 'required'`.

### Webview is blank
Check Developer Tools (Help → Toggle Developer Tools) → Console. Look for `[fibonacci-agent]` log lines.

---

## License

MIT

---

## Brand

The Fibonacci spiral logo uses magenta `#FE03C3` — a flat, open nautilus-style spiral representing the golden ratio and Fibonacci sequence.
