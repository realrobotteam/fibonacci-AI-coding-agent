/** @type {import('tailwindcss').Config} */
// Design tokens inspired by Cline / Roo Code — flat surfaces, VS Code native
// colors, single brand accent applied sparingly.
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
        // Surfaces — VS Code dark theme
        panel: 'var(--vscode-editor-background, #1e1e1e)',
        input: 'var(--vscode-input-background, #252526)',
        elevated: 'var(--vscode-list-hoverBackground, #2a2d2e)',
        'elevated-2': '#2d2d2d',
        hover: '#2a2d2e',
        // Borders
        'border-subtle': 'var(--vscode-panel-border, #333333)',
        'border-input': 'var(--vscode-input-border, #3c3c3c)',
        'border-focus': 'var(--vscode-focusBorder, #007acc)',
        // Text
        'text-primary': 'var(--vscode-editor-foreground, #d4d4d4)',
        'text-secondary': '#cccccc',
        'text-tertiary': 'var(--vscode-descriptionForeground, #858585)',
        'text-muted': '#6a6a6a',
        'text-link': 'var(--vscode-textLink-foreground, #3794ff)',
        // Brand — Fibonacci magenta (the official logo color #FE03C3)
        brand: {
          DEFAULT: '#FE03C3',
          hover: '#E002B0',
          text: '#ffffff',
        },
        // Status
        status: {
          success: '#4ec9b0',
          warning: '#cca700',
          error: '#f48771',
          info: '#3794ff',
        },
      },
      borderRadius: {
        card: '6px',
        input: '6px',
        button: '4px',
        pill: '12px',
        chip: '10px',
      },
      fontSize: {
        // Persian numerals render better with slight size bump
        xs: '11px',
        sm: '12px',
        base: '13px',
        lg: '14px',
        xl: '16px',
        headline: '22px',
      },
      transitionDuration: {
        fast: '120ms',
      },
    },
  },
  plugins: [require('tailwindcss-rtl')],
};
