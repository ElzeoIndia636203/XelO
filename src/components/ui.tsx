import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (
    ['done', 'approved', 'passed', 'active', 'present', 'completed', 'accepted', 'published', 'ready'].includes(s)
  ) {
    return 'good';
  }
  if (['pending_hod', 'pending_coe', 'needs_attention', 'warning', 'flagged', 'draft', 'in_progress'].includes(s)) {
    return 'warn';
  }
  if (['absent', 'failed', 'declined', 'returned', 'deactivated', 'rejected', 'error'].includes(s)) {
    return 'bad';
  }
  return 'neutral';
}

export function Wordmark({ dark = false, sub }: { dark?: boolean; sub?: string }) {
  return (
    <span className={`wordmark ${dark ? 'wordmark-dark' : ''}`}>
      <span>
        Xe<span className="wordmark-io">IO</span>
      </span>
      {sub ? <span className="wordmark-sub">{sub}</span> : null}
    </span>
  );
}

export function Elzeo({ dark = false }: { dark?: boolean }) {
  return (
    <img
      src={dark ? '/brand/elzeo-dark.png' : '/brand/elzeo-light.png'}
      alt="elzeo"
      style={{ height: 18, width: 'auto', display: 'inline-block', verticalAlign: 'middle' }}
    />
  );
}

export function Card({
  title,
  actions,
  flush = false,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {title || actions ? (
        <header className="card-head">
          {title ? <h2 className="card-title">{title}</h2> : <span />}
          {actions ? <div>{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? 'card-body-flush' : 'card-body'}>{children}</div>
    </section>
  );
}

export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function Banner({
  tone = 'info',
  actions,
  children,
}: {
  tone?: 'ok' | 'err' | 'info';
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'err' ? 'alert' : 'status'}>
      <div>{children}</div>
      {actions ? <div>{actions}</div> : null}
    </div>
  );
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="seg-btn"
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function PageHead({
  kicker,
  title,
  lead,
  actions,
}: {
  kicker?: string;
  title: string;
  lead?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {kicker ? <div className="page-kicker">{kicker}</div> : null}
        <h1 className="page-title">{title}</h1>
        {lead ? <p className="page-lead">{lead}</p> : null}
      </div>
      {actions ? <div>{actions}</div> : null}
    </header>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
      {body ? <p style={{ marginTop: 4 }}>{body}</p> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="error-note" role="alert">
      {message}
    </div>
  );
}

export function Stepper({
  steps,
  current,
  onSelect,
}: {
  steps: readonly { id: string; label: string; locked?: boolean; done?: boolean }[];
  current: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="stepper" aria-label="Progress">
      {steps.map((step, idx) => (
        <button
          key={step.id}
          type="button"
          className="stepper-item"
          disabled={step.locked}
          aria-current={step.id === current ? 'step' : undefined}
          onClick={() => onSelect(step.id)}
        >
          <span className="mono">{idx + 1}.</span>
          <span>{step.label}</span>
          {step.done ? <Chip tone="good">Done</Chip> : null}
        </button>
      ))}
    </nav>
  );
}

export function Modal({
  open,
  title,
  onClose,
  printable = false,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  printable?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open || !printable) return;
    document.body.classList.add('print-modal-active');
    return () => {
      document.body.classList.remove('print-modal-active');
    };
  }, [open, printable]);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = dialogRef.current;
    const focusables = el?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const firstInput = el?.querySelector<HTMLElement>('input, select, textarea');
    (firstInput ?? focusables?.[0])?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && focusables && focusables.length > 0) {
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      prev?.focus();
    };
  }, [open]);

  if (!open) return null;

  const content = (
    <div
      className={printable ? 'modal-backdrop printable-modal-backdrop' : 'modal-backdrop'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={printable ? 'modal printable-modal' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
      >
        <div className="card-head">
          <h2 className="card-title">{title}</h2>
          <button type="button" className="btn btn-ghost" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );

  return printable ? createPortal(content, document.body) : content;
}

export function Bar({
  value,
  target,
  label,
}: {
  value: number;
  target?: number;
  label: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const belowTarget = target !== undefined && clamped < target;

  return (
    <div
      className="bar-wrap"
      role="img"
      aria-label={`${label}: ${clamped}%${target !== undefined ? ` (target ${target}%)` : ''}`}
    >
      <div
        className={`bar-fill ${belowTarget ? 'bar-fill-warn' : ''}`}
        style={{ width: `${clamped}%` }}
      />
      {target !== undefined ? (
        <div className="bar-target" style={{ left: `${Math.max(0, Math.min(100, target))}%` }} />
      ) : null}
    </div>
  );
}

export function Kpis({
  items,
}: {
  items: readonly { label: string; value: string | number }[];
}) {
  return (
    <div className="kpis">
      {items.map((item) => (
        <div key={item.label} className="kpi">
          <div className="kpi-label">{item.label}</div>
          <div className="kpi-value">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

/** Scrollable 12-hour time picker popup returning 24h "HH:MM". */
export function TimePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next24h: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [rawH, rawM] = (value || '10:30').split(':').map((x) => Number(x));
  const h24 = Number.isFinite(rawH) ? Math.max(0, Math.min(23, rawH!)) : 10;
  const minVal = Number.isFinite(rawM) ? Math.max(0, Math.min(59, rawM!)) : 30;
  const period: 'AM' | 'PM' = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  function emit(nextH12: number, nextMin: number, nextPeriod: 'AM' | 'PM') {
    let next24 = nextH12 % 12;
    if (nextPeriod === 'PM') next24 += 12;
    onChange(`${String(next24).padStart(2, '0')}:${String(nextMin).padStart(2, '0')}`);
  }

  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="field mono"
        onClick={() => setOpen((o) => !o)}
        style={{
          minWidth: 118,
          textAlign: 'left',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          cursor: 'pointer',
          background: 'var(--surface)',
        }}
      >
        <span>
          {String(h12).padStart(2, '0')}:{String(minVal).padStart(2, '0')} {period}
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>▼</span>
      </button>
      {open ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 50,
            display: 'flex',
            gap: 4,
            padding: 8,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          }}
        >
          <div style={{ maxHeight: 190, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 44 }}>
            {hours.map((hr) => (
              <button
                key={hr}
                type="button"
                className={hr === h12 ? 'btn btn-primary field-sm mono' : 'btn field-sm mono'}
                style={{ padding: '4px 8px', justifyContent: 'center' }}
                onClick={() => emit(hr, minVal, period)}
              >
                {String(hr).padStart(2, '0')}
              </button>
            ))}
          </div>
          <div style={{ maxHeight: 190, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 44 }}>
            {minutes.map((m) => (
              <button
                key={m}
                type="button"
                className={m === minVal ? 'btn btn-primary field-sm mono' : 'btn field-sm mono'}
                style={{ padding: '4px 8px', justifyContent: 'center' }}
                onClick={() => emit(h12, m, period)}
              >
                {String(m).padStart(2, '0')}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 44 }}>
            {(['AM', 'PM'] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={p === period ? 'btn btn-primary field-sm mono' : 'btn field-sm mono'}
                style={{ padding: '4px 8px', justifyContent: 'center' }}
                onClick={() => emit(h12, minVal, p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
