import React, { useState, useRef, useEffect } from 'react';

/* ── Section wrapper ── */
export const Section: React.FC<{ title: string; children: React.ReactNode; className?: string }> = ({ title, children, className = '' }) => (
  <section className={`space-y-3 ${className}`}>
    <h3 className="section-label">{title}</h3>
    <div className="space-y-2">{children}</div>
  </section>
);

/* ── Setting row: label + control ──
   Stacks vertically on very narrow panels so long selects/inputs never
   overflow the card; switches to the label|control row from `sm` up. */
export const SettingRow: React.FC<{
  label: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}> = ({ label, description, children, className = '' }) => (
  <div className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs px-2.5 py-2.5 bg-input rounded-card border border-border-subtle hover:border-border-input transition-colors duration-fast ${className}`}>
    <div className="min-w-0 flex-1 sm:pe-3">
      <span className="text-text-secondary block">{label}</span>
      {description && <span className="text-text-muted text-2xs block mt-0.5">{description}</span>}
    </div>
    <div className="shrink-0 max-w-full min-w-0 sm:text-end">{children}</div>
  </div>
);

/* ── Toggle switch ── */
export const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; 'aria-label'?: string }> = ({ checked, onChange, disabled, 'aria-label': ariaLabel }) => (
  <label className={`relative inline-flex items-center cursor-pointer ${disabled ? 'opacity-50' : ''}`}>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      aria-label={ariaLabel}
      className="sr-only peer"
    />
    <div className="w-9 h-5 bg-elevated-2 rounded-full peer peer-checked:bg-brand border border-border-input peer-checked:border-brand transition-colors duration-fast"></div>
    <span className={`absolute left-0.5 top-0.5 bg-white rounded-full h-4 w-4 transition-transform duration-fast shadow-sm ${checked ? 'translate-x-4' : 'translate-x-0'}`}></span>
  </label>
);

/* ── Select dropdown ── */
export const Select: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}> = ({ value, onChange, options, className = '' }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className={`bg-panel text-text-primary rounded px-2 py-1 text-xs border border-border-input focus:border-border-focus outline-none max-w-full ${className}`}
  >
    {options.map((o) => (
      <option key={o.value} value={o.value}>{o.label}</option>
    ))}
  </select>
);

/* ── Text input ── */
export const TextInput: React.FC<{
  value: string;
  /** Optional so read-only displays (export boxes etc.) can omit it. */
  onChange?: (v: string) => void;
  placeholder?: string;
  dir?: 'ltr' | 'rtl';
  readOnly?: boolean;
  type?: string;
  maxLength?: number;
  className?: string;
}> = ({ value, onChange, placeholder, dir = 'ltr', readOnly, type = 'text', maxLength, className = '' }) => (
  <input
    type={type}
    value={value}
    onChange={onChange ? (e) => onChange(e.target.value) : undefined}
    placeholder={placeholder}
    dir={dir}
    readOnly={readOnly}
    maxLength={maxLength}
    className={`w-full bg-input text-text-primary rounded-card px-2.5 py-1.5 text-xs outline-none border border-border-input focus:border-border-focus transition-colors duration-fast ${readOnly ? 'text-text-tertiary' : ''} ${className}`}
  />
);

/* ── Number input ── */
export const NumberInput: React.FC<{
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  className?: string;
}> = ({ value, onChange, min, max, className = '' }) => (
  <input
    type="number"
    value={value}
    onChange={(e) => onChange(parseInt(e.target.value) || 0)}
    min={min}
    max={max}
    className={`w-16 max-w-full bg-panel text-text-primary rounded px-2 py-1 text-xs border border-border-input focus:border-border-focus outline-none ${className}`}
  />
);

/* ── Masked input with reveal toggle (for API keys) ── */
export const MaskedInput: React.FC<{
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}> = ({ value, onChange, placeholder, readOnly }) => {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="relative flex-1">
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        placeholder={placeholder}
        dir="ltr"
        readOnly={readOnly}
        className="w-full bg-input text-text-primary rounded-card px-2.5 py-1.5 pe-8 text-xs outline-none border border-border-input focus:border-border-focus transition-colors duration-fast"
      />
      <button
        type="button"
        onClick={() => setRevealed(!revealed)}
        aria-label={revealed ? 'Hide value' : 'Show value'}
        className="absolute end-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
      >
        {revealed ? (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        )}
      </button>
    </div>
  );
};

/* ── Status indicator dot ── */
export const StatusDot: React.FC<{ ok: boolean; className?: string }> = ({ ok, className = '' }) => (
  <span className={`w-2 h-2 rounded-full shrink-0 ${ok ? 'bg-status-success' : 'bg-status-error'} ${className}`} />
);

/* ── Button ── */
export const Button: React.FC<{
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  className?: string;
}> = ({ children, onClick, variant = 'secondary', disabled, className = '' }) => {
  const base = 'text-xs px-2.5 py-1.5 rounded-card border transition-colors duration-fast disabled:opacity-40 disabled:cursor-not-allowed';
  const variants = {
    primary: 'bg-brand hover:bg-brand-hover text-white border-transparent',
    secondary: 'bg-elevated-2 hover:bg-hover text-text-secondary hover:text-text-primary border-border-input',
    danger: 'bg-elevated-2 hover:bg-status-error/30 text-text-secondary hover:text-status-error border-border-input hover:border-status-error/40',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
};

/* ── Compact icon-only button (with tooltip label) ── */
export const IconButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  className?: string;
}> = ({ icon, label, onClick, variant = 'secondary', disabled, className = '' }) => {
  const base = 'w-7 h-7 inline-flex items-center justify-center rounded-card border transition-colors duration-fast disabled:opacity-40 disabled:cursor-not-allowed';
  const variants = {
    primary: 'bg-brand hover:bg-brand-hover text-white border-transparent',
    secondary: 'bg-elevated-2 hover:bg-hover text-text-secondary hover:text-text-primary border-border-input',
    danger: 'bg-elevated-2 hover:bg-status-error/30 text-text-secondary hover:text-status-error border-border-input hover:border-status-error/40',
  };
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label} className={`${base} ${variants[variant]} ${className}`}>
      {icon}
    </button>
  );
};

/* ── Empty state placeholder ── */
export const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <div className="text-xs text-text-tertiary bg-input rounded-card p-3 border border-border-subtle">
    {message}
  </div>
);

/* ── Section header with optional action ── */
export const SectionHeader: React.FC<{
  title: string;
  action?: React.ReactNode;
}> = ({ title, action }) => (
  <div className="flex items-center justify-between">
    <h3 className="section-label">{title}</h3>
    {action}
  </div>
);

/* ── Collapsible section ── */
export const CollapsibleSection: React.FC<{
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, expanded, onToggle, children }) => (
  <section className="space-y-2">
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between section-label hover:text-text-secondary transition-colors duration-fast"
    >
      <span>{title}</span>
      <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 16 16" fill="currentColor">
        <path d="M5 3l6 5-6 5V3z" />
      </svg>
    </button>
    {expanded && children}
  </section>
);
