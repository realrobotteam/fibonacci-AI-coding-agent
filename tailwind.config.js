/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/webview/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // FIX: `font-persian` is used in index.html/webview HTML but was never
        // defined — define it explicitly.
        persian: [
          'Vazirmatn',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'sans-serif',
        ],
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
        // FIX (broken opacity modifiers): these colors are used with alpha
        // modifiers (e.g. bg-brand/10). Raw var() values can't express alpha,
        // so they are defined as RGB-channel variables with an
        // <alpha-value> placeholder. The channel variables are kept in sync
        // with the live VS Code theme at runtime (see App.tsx).
        input: 'rgb(var(--fib-input-rgb, 60 60 60) / <alpha-value>)',
        elevated: 'rgb(var(--fib-elevated-rgb, 37 37 38) / <alpha-value>)',
        'elevated-2': 'rgb(var(--fib-elevated-2-rgb, 42 45 46) / <alpha-value>)',
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
          DEFAULT: 'rgb(var(--fib-brand-rgb, 0 122 204) / <alpha-value>)',
          hover: 'var(--vscode-button-hoverBackground, #005a9e)',
          foreground: 'var(--vscode-button-foreground, #ffffff)',
        },
        // Status
        status: {
          success: 'rgb(var(--fib-status-success-rgb, 78 201 176) / <alpha-value>)',
          warning: 'rgb(var(--fib-status-warning-rgb, 204 167 0) / <alpha-value>)',
          error: 'rgb(var(--fib-status-error-rgb, 244 135 113) / <alpha-value>)',
          info: 'rgb(var(--fib-status-info-rgb, 55 148 255) / <alpha-value>)',
        },
      },
      borderRadius: {
        sm: '4px',
        md: '6px',
        lg: '8px',
        // FIX: rounded-card / rounded-button were used throughout the settings
        // UI but never defined — everything rendered square-cornered.
        card: '10px',
        button: '6px',
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
