import React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';

/* ============================================================================
 * XUI.one style skin layer for the channel list.
 * Presentational primitives only: no data fetching, no business logic.
 * Modeled after XUI admin (page-title-box + card + collapsible filters +
 * dense table with row action dropdown + entries/pagination footer).
 * ========================================================================== */

/* ------------------------------- helpers -------------------------------- */

export function sourceHost(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '—';
  try {
    const parsed = new URL(value);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    const match = value.match(/^[a-z0-9+.-]+:\/\/(?:[^@/]+@)?([^/?#]+)/i);
    return match ? match[1] : value;
  }
}

export function formatUptime(startedAt, now = Date.now()) {
  if (!startedAt) return null;
  const raw = String(startedAt).trim();
  let ms;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw)) {
    ms = Date.parse(`${raw.replace(' ', 'T')}${/z$/i.test(raw) ? '' : 'Z'}`);
  } else {
    ms = Date.parse(raw);
  }
  if (!Number.isFinite(ms)) return null;
  const secs = Math.max(0, Math.floor((now - ms) / 1000));
  if (secs < 60) return '<1m';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, '0')}h`;
}

/* -------------------------------- popover ------------------------------- */

export function Popover({ open, onClose, anchorRef, width = 264, maxHeight = 420, children }) {
  const menuRef = React.useRef(null);
  const [pos, setPos] = React.useState(null);

  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.max(8, Math.min(rect.right - width, vw - width - 8));
      const below = vh - rect.bottom - 12;
      const above = rect.top - 12;
      const flip = below < Math.min(maxHeight, 200) && above > below;
      const cap = Math.min(maxHeight, flip ? above : below);
      setPos({ left, top: flip ? Math.max(8, rect.top - cap - 6) : rect.bottom + 6, width, maxHeight: cap });
    };
    place();
    window.addEventListener('resize', place);
    const closeOnScroll = () => onClose();
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [open, width, maxHeight, anchorRef, onClose]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      if (anchorRef.current?.contains(event.target)) return;
      onClose();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !pos || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
      className="z-[80] overflow-y-auto rounded-xl border border-slate-700/80 bg-[#121a2c] p-1.5 shadow-2xl shadow-black/70"
    >
      {children}
    </div>,
    document.body
  );
}

export function MenuHeading({ children }) {
  return (
    <div className="px-2 pt-1.5 pb-1 text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500">{children}</div>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-slate-700/60" />;
}

export function MenuItem({ icon: Icon, label, hint, onClick, danger = false, disabled = false, active = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[11.5px] font-medium transition ${
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : danger
            ? 'text-rose-300 hover:bg-rose-500/15'
            : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'
      } ${active ? 'bg-slate-700/40' : ''}`}
    >
      {Icon ? <Icon className={`w-3.5 h-3.5 shrink-0 ${danger ? 'text-rose-400' : 'text-slate-400'}`} /> : null}
      <span className="flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 font-mono text-[9px] uppercase text-slate-500">{hint}</span> : null}
    </button>
  );
}

export function Dropdown({ label, icon: Icon, tone = 'neutral', items, align = 'end', width = 268, title }) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef(null);
  const close = React.useCallback(() => setOpen(false), []);

  const tones = {
    neutral:
      'bg-slate-800/80 hover:bg-slate-700 text-slate-200 border-slate-700 hover:border-slate-600',
    primary: 'bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-500/60',
    ghost: 'bg-transparent hover:bg-slate-800 text-slate-300 border-transparent hover:border-slate-700'
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-semibold transition ${tones[tone]}`}
      >
        {Icon ? <Icon className="w-3.5 h-3.5" /> : null}
        {label ? <span className="whitespace-nowrap">{label}</span> : null}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <Popover open={open} onClose={close} anchorRef={btnRef} width={width} maxHeight={440}>
        {items.map((item, index) => {
          if (item.heading) return <MenuHeading key={`h-${index}`}>{item.heading}</MenuHeading>;
          if (item.separator) return <MenuSeparator key={`s-${index}`} />;
          return <MenuItem key={`i-${index}`} {...item} onClick={() => { setOpen(false); item.onClick?.(); }} />;
        })}
      </Popover>
    </>
  );
}

export function RowMenu({ items, label = 'Más acciones' }) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef(null);
  const close = React.useCallback(() => setOpen(false), []);
  const visible = items.filter(Boolean);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border transition ${
          open
            ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
            : 'border-slate-700/70 bg-slate-800/60 text-slate-400 hover:border-slate-600 hover:text-white'
        }`}
      >
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      <Popover open={open} onClose={close} anchorRef={btnRef} width={236} maxHeight={320}>
        {visible.map((item, index) =>
          item.separator ? (
            <MenuSeparator key={`s-${index}`} />
          ) : (
            <MenuItem key={`i-${index}`} {...item} onClick={() => { setOpen(false); item.onClick?.(); }} />
          )
        )}
      </Popover>
    </>
  );
}

/* -------------------------------- atoms --------------------------------- */

const CHIP_TONES = {
  sky: 'bg-sky-500/12 text-sky-300 border-sky-500/35',
  indigo: 'bg-indigo-500/12 text-indigo-300 border-indigo-500/35',
  emerald: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/35',
  amber: 'bg-amber-500/12 text-amber-300 border-amber-500/35',
  violet: 'bg-violet-500/12 text-violet-300 border-violet-500/35',
  cyan: 'bg-cyan-500/12 text-cyan-300 border-cyan-500/35',
  slate: 'bg-slate-700/40 text-slate-300 border-slate-600/60',
  rose: 'bg-rose-500/12 text-rose-300 border-rose-500/35'
};

export function Chip({ tone = 'slate', icon: Icon, children, title, mono = true }) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wide ${
        CHIP_TONES[tone] || CHIP_TONES.slate
      } ${mono ? 'font-mono' : ''}`}
    >
      {Icon ? <Icon className="w-2.5 h-2.5" /> : null}
      {children}
    </span>
  );
}

const STATUS_MAP = {
  running: { label: 'Online', dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'border-emerald-500/35 bg-emerald-500/12', pulse: true },
  ondemand_idle: { label: 'On-demand', dot: 'bg-amber-400', text: 'text-amber-300', ring: 'border-amber-500/35 bg-amber-500/12', pulse: false },
  stopped: { label: 'Detenido', dot: 'bg-rose-400', text: 'text-rose-300', ring: 'border-rose-500/35 bg-rose-500/12', pulse: false }
};

export function StatusPill({ status, uptimeStartedAt, now }) {
  const key = status === 'running' ? 'running' : status === 'ondemand_idle' ? 'ondemand_idle' : 'stopped';
  const conf = STATUS_MAP[key];
  const uptime = key === 'running' ? formatUptime(uptimeStartedAt, now) : null;
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-[2px] text-[10px] font-bold uppercase tracking-wide ${conf.ring} ${conf.text}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${conf.dot} ${conf.pulse ? 'animate-pulse' : ''}`} />
        {conf.label}
      </span>
      {uptime ? <span className="pl-0.5 font-mono text-[9px] text-slate-500">up {uptime}</span> : null}
    </div>
  );
}

const ACTION_TONES = {
  indigo: 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500 hover:text-white',
  emerald: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500 hover:text-slate-950',
  amber: 'border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500 hover:text-slate-950',
  rose: 'border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500 hover:text-white',
  neutral: 'border-slate-700/70 bg-slate-800/60 text-slate-300 hover:border-slate-600 hover:text-white'
};

export function IconAction({ icon: Icon, label, onClick, tone = 'neutral', disabled = false, spinning = false }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border transition disabled:opacity-40 ${
        ACTION_TONES[tone] || ACTION_TONES.neutral
      }`}
    >
      <Icon className={`w-3.5 h-3.5 ${spinning ? 'animate-spin' : ''}`} />
    </button>
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-slate-700/80 bg-[#090e1a] p-0.5">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-[5px] text-[10.5px] font-semibold transition ${
              active ? 'bg-slate-700/80 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {opt.dot ? <span className={`h-1.5 w-1.5 rounded-full ${opt.dot}`} /> : null}
            {opt.label}
            {typeof opt.count === 'number' ? (
              <span className={`font-mono text-[9px] ${active ? 'text-slate-300' : 'text-slate-500'}`}>{opt.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage, onPageSize, showPageSize = true }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 bg-[#0b1220]/60 px-4 py-2 text-[11px] text-slate-400">
      <div className="flex items-center gap-2">
        {showPageSize ? (
          <>
            <span className="text-slate-500">Mostrar</span>
            <select
              value={pageSize}
              onChange={(event) => onPageSize(Number(event.target.value))}
              className="rounded-md border border-slate-700/80 bg-[#090e1a] px-1.5 py-[3px] font-mono text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {[25, 50, 100, 250].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-slate-500">canales</span>
          </>
        ) : null}
        <span className="hidden sm:inline text-slate-500">
          · {from}–{to} de {total}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-slate-700/70 bg-slate-800/60 text-slate-300 transition hover:text-white disabled:opacity-35"
          title="Página anterior"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="px-1.5 font-mono text-[10.5px] text-slate-400">
          Página {page} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-slate-700/70 bg-slate-800/60 text-slate-300 transition hover:text-white disabled:opacity-35"
          title="Página siguiente"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ colSpan, title, hint }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-14 text-center">
        <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700/70 bg-slate-800/60">
          <Check className="w-4 h-4 text-slate-500" />
        </div>
        <div className="text-xs font-semibold text-slate-300">{title}</div>
        {hint ? <div className="mt-1 text-[11px] text-slate-500">{hint}</div> : null}
      </td>
    </tr>
  );
}
