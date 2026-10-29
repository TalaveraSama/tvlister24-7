import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Globe,
  Loader2,
  Radio,
  RefreshCw,
  Server,
  X,
  XCircle
} from 'lucide-react';

/**
 * Reporte del endpoint POST /api/streams/:id/diagnose.
 * Muestra el recorrido origen → motor → entrega con el veredicto y las
 * acciones recomendadas. Pensado para responder “¿por qué no se ve?”.
 */

const VERDICT_STYLES = {
  OK: {
    icon: CheckCircle2,
    box: 'border-emerald-500/40 bg-emerald-500/10',
    text: 'text-emerald-200',
    dot: 'text-emerald-300'
  },
  ORIGEN_CAIDO: {
    icon: XCircle,
    box: 'border-rose-500/40 bg-rose-500/10',
    text: 'text-rose-200',
    dot: 'text-rose-300'
  },
  MOTOR_CAIDO: {
    icon: AlertTriangle,
    box: 'border-amber-500/40 bg-amber-500/10',
    text: 'text-amber-200',
    dot: 'text-amber-300'
  },
  ENTREGA_FALLA: {
    icon: AlertTriangle,
    box: 'border-amber-500/40 bg-amber-500/10',
    text: 'text-amber-200',
    dot: 'text-amber-300'
  },
  SOURCE2_DISPONIBLE: {
    icon: AlertTriangle,
    box: 'border-sky-500/40 bg-sky-500/10',
    text: 'text-sky-200',
    dot: 'text-sky-300'
  }
};

const STEP_ICONS = {
  origin: Globe,
  engine: Server,
  delivery: Radio
};

function StepCard({ step }) {
  const Icon = STEP_ICONS[step.id] || Globe;
  const tone = step.skipped ? 'slate' : step.ok ? 'emerald' : 'rose';
  const iconTone = { emerald: 'text-emerald-300', rose: 'text-rose-300', slate: 'text-slate-500' }[tone];
  const badgeTone = {
    emerald: 'border-emerald-500/40 bg-emerald-500/12 text-emerald-300',
    rose: 'border-rose-500/40 bg-rose-500/12 text-rose-300',
    slate: 'border-slate-600/50 bg-slate-600/15 text-slate-400'
  }[tone];
  return (
    <div className="rounded-xl border border-slate-800 bg-[#090e1a] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={`h-4 w-4 shrink-0 ${iconTone}`} />
          <span className="truncate text-[12px] font-semibold text-slate-100">{step.label}</span>
        </div>
        <span className={`shrink-0 rounded border px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wide ${badgeTone}`}>
          {step.skipped ? 'Omitido' : step.ok ? 'OK' : 'FALLA'}
        </span>
      </div>

      <div className="mt-1.5 text-[11px] leading-snug text-slate-300">{step.detail}</div>

      {step.url ? (
        <div className="mt-1 break-all font-mono text-[10px] text-slate-500">{step.url}</div>
      ) : null}

      {step.id === 'origin' && Array.isArray(step.tries) && (step.tries.length > 1 || step.tries[0]?.error) ? (
        <div className="mt-1.5 space-y-1">
          {step.tries.map((t, i) => (
            <div key={i} className="font-mono text-[9.5px] text-slate-500">
              <div className="flex items-start gap-1.5">
                <span className="shrink-0 uppercase text-slate-500">{t.label || `Source ${i + 1}`}</span>
                <span className={t.status && t.status < 400 && !t.error ? 'text-emerald-400' : 'text-rose-400'}>
                  {t.status || '—'}
                </span>
                {t.ms ? <span>{t.ms} ms</span> : null}
              </div>
              <div className="break-all pl-1 text-slate-600">{t.url}</div>
              {t.error ? <div className="pl-1 text-amber-300/80">{t.error}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {step.id === 'origin' && Array.isArray(step.inactive) && step.inactive.length ? (
        <div className="mt-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-1.5 font-mono text-[9.5px] text-slate-500">
          {step.inactive.map((t, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <span className="shrink-0 uppercase text-slate-500">{t.label}</span>
              <span className={t.status && t.status < 400 && !t.error ? 'text-emerald-400' : 'text-rose-400'}>
                {t.status || '—'}
              </span>
              {t.error ? <span className="text-amber-300/80">{t.error}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {step.id === 'engine' && step.pid ? (
        <div className="mt-1 font-mono text-[10px] text-slate-500">
          PID {step.pid} · {step.segments} segmentos · manifiesto {step.manifestFresh ? 'fresco' : 'sin actualizar'}
          {step.hlsAgeSec !== null ? ` · ${step.hlsAgeSec} s` : ''}
        </div>
      ) : null}

      {step.id === 'delivery' && step.segment ? (
        <div className="mt-1 font-mono text-[10px] text-slate-500">
          segmento HTTP {step.segment.status || '—'} · {step.segment.bytes ?? 0} bytes · {step.segment.ms ?? '—'} ms
        </div>
      ) : null}
    </div>
  );
}

export default function SourceDiagnosticModal({ stream, report, busy, onRun, onClose }) {
  const verdict = report?.verdict;
  const style = VERDICT_STYLES[verdict?.code] || VERDICT_STYLES.MOTOR_CAIDO;
  const VerdictIcon = style.icon;

  const copyReport = () => {
    if (!report) return;
    const lines = [
      `Diagnóstico · ${report.stream?.name} (#${report.stream?.id})`,
      `Fecha: ${report.checkedAt} · duración ${report.elapsedMs} ms`,
      `Veredicto: ${verdict?.code} — ${verdict?.title}`,
      '',
      `Origen: ${report.stream?.source_url}`,
      report.stream?.backup_url ? `Source 2: ${report.stream.backup_url}` : 'Sin Source 2',
      '',
      ...(report.steps || []).map(
        (s) =>
          `[${s.skipped ? 'OMITIDO' : s.ok ? 'OK' : 'FALLA'}] ${s.label}: ${s.detail}${s.url ? `\n    ${s.url}` : ''}`
      ),
      ...(report.steps || [])
        .filter((s) => s.id === 'origin' && Array.isArray(s.inactive) && s.inactive.length)
        .flatMap((s) => s.inactive.map((t) => `    ${t.label}: HTTP ${t.status || '—'} ${t.error || 'responde'}`)),
      '',
      ...(verdict?.hints || []).map((h) => `→ ${h}`)
    ];
    navigator.clipboard?.writeText(lines.join('\n')).catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/80 p-4 sm:items-center">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-800 bg-[#0e1526] shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-[#131c31] px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              Diagnóstico de reproducción
            </div>
            <div className="truncate text-sm font-bold text-white">{stream?.name || 'Canal'}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onRun}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> Repetir
            </button>
            <button
              type="button"
              onClick={copyReport}
              disabled={!report}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            >
              <Copy className="h-3.5 w-3.5" /> Copiar
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Cerrar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-3 p-4">
          {busy && !report ? (
            <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Probando origen, motor y entrega…
            </div>
          ) : null}

          {!busy && !report ? (
            <div className="py-8 text-center text-sm text-slate-400">
              Ejecuta el diagnóstico para ver dónde se corta la señal.
            </div>
          ) : null}

          {report?.error ? (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-[12px] text-rose-200">
              {report.error}
            </div>
          ) : null}

          {verdict ? (
            <div className={`rounded-xl border p-3 ${style.box}`}>
              <div className={`flex items-center gap-2 text-[13px] font-bold ${style.text}`}>
                <VerdictIcon className={`h-4 w-4 ${style.dot}`} />
                {verdict.title}
              </div>
              <p className="mt-1 text-[11.5px] leading-snug text-slate-300">{verdict.text}</p>
              {verdict.hints?.length ? (
                <ul className="mt-2 space-y-1">
                  {verdict.hints.map((h, i) => (
                    <li key={i} className="flex gap-1.5 text-[11px] text-slate-300">
                      <span className="text-slate-500">→</span>
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {report?.steps?.map((step) => <StepCard key={step.id} step={step} />)}

          {report ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-2 text-[10px] text-slate-500">
              <span>
                {report.stream?.stream_mode} · {report.stream?.status}
                {report.stream?.auto_failover ? ' · conmutación automática' : ''}
                {report.stream?.failover_active ? ' · emitiendo SOURCE 2' : ''}
              </span>
              <span>
                {report.elapsedMs} ms · {new Date(report.checkedAt).toLocaleTimeString()}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
