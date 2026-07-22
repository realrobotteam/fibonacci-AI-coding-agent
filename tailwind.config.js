/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/webview/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Vazirmatn',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Inter',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          '"SF Mono"',
          'Menlo',
          'Consolas',
          '"Cascadia Code"',
          '"Liberation Mono"',
          'monospace',
        ],
      },
      colors: {
        // Surfaces
        panel: 'var(--vscode-sideBar-background, #252526)',
        sidebar: 'var(--sideBar-background, #252526)',
        input: 'var(--vscode-input-background, #3c3c3c)',
        elevated: 'var(--vscode-editorWidget-background, #252526)',
        'elevated-2': 'var(--vscode-list-inactiveSelectionBackground, #2a2d2e)',
        hover: 'var(--vscode-list-hoverBackground, #2a2d2e)',
        // Borders
        'border-subtle': 'var(--vscode-panel-border, #333333)',
        'border-input': 'var(--vscode-input-border, #3c3c3c)',
        'border-focus': 'var(--vscode-focusBorder, #007acc)',
        // Text
        'text-primary': 'var(--vscode-editor-foreground, #cccccc)',
        'text-secondary': 'var(--vscode-editor-foreground, #b0b0b0)',
        'text-tertiary': 'var(--vscode-descriptionForeground, #858585)',
        'text-muted': 'var(--vscode-descriptionForeground, #5a5a5a)',
        // Brand
        brand: {
          DEFAULT: 'var(--vscode-button-background, #007acc)',
          hover: 'var(--vscode-button-hoverBackground, #005a9e)',
          foreground: 'var(--vscode-button-foreground, #ffffff)',
        },
        // Status
        status: {
          success: 'var(--vscode-terminal-ansiGreen, #4ec9b0)',
          warning: 'var(--vscode-editorWarning-foreground, #cca700)',
          error: 'var(--vscode-editorError-foreground, #f48771)',
          info: 'var(--vscode-textLink-foreground, #3794ff)',
        },
      },
      borderRadius: {
        sm: '4px',
        md: '6px',
        lg: '8px',
      },
      fontSize: {
        '2xs': '10px',
        xs: '11px',
        sm: '12px',
        base: '13px',
        lg: '14px',
      },
      spacing: {
        '0.5': '2px',
        '1': '4px',
        '1.5': '6px',
        '2': '8px',
        '2.5': '10px',
        '3': '12px',
        '3.5': '14px',
        '4': '16px',
      },
      transitionDuration: {
        fast: '100ms',
        normal: '150ms',
      },
    },
  },
  plugins: [require('tailwindcss-rtl')],
};
