import React, { useEffect, useState } from 'react';
import {
  Cpu,
  Zap,
  Save,
  RotateCw,
  AlertTriangle,
  CheckCircle2,
  Terminal,
  Gauge,
  Layers,
  Activity,
  RefreshCw,
  Info,
  Binary,
  Lock,
  Unlock,
  Undo2,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

/**
 * Motor FFmpeg — versión simplificada.
 *
 * Diseño: las opciones son ESTÁTICAS (sólo lectura) hasta que el administrador
 * pulsa «Permitir cambios». Cada opción es un recuadro que muestra:
 *   · el valor actual,
 *   · su valor predeterminado,
 *   · y, si se modificó, la etiqueta MODIFICADO con el valor original y el nuevo.
 * Así se ve de un vistazo qué se tocó y qué quedó en el motor.
 */

// Formato legible de cada valor
const fmtBytes = (v) => `${(Number(v) / 1000000).toFixed(1).replace('.0', '')} MB`;
const fmtUs = (v) => `${(Number(v) / 1000000).toFixed(1).replace('.0', '')} s`;

const FIELDS = [
  // ---------- básicos ----------
  {
    key: 'hlsTime',
    group: 'basic',
    label: 'Segmento HLS',
    unit: 's',
    type: 'number',
    min: 1,
    max: 10,
    step: 1,
    fmt: (v) => `${v} s`,
    hint: 'Duración de cada segmento. 2 s es el equilibrio probado entre latencia y estabilidad.'
  },
  {
    key: 'hlsListSize',
    group: 'basic',
    label: 'Segmentos en el manifiesto',
    unit: 'seg',
    type: 'number',
    min: 3,
    max: 12,
    step: 1,
    fmt: (v) => `${v}`,
    hint: 'Ventana = duración × segmentos. Más segmentos = más RAM en /dev/shm.'
  },
  {
    key: 'h264Threads',
    group: 'basic',
    label: 'Hilos por encoder H.264',
    unit: 'hilos',
    type: 'number',
    min: 1,
    max: 16,
    step: 1,
    fmt: (v) => `${v}`,
    hint: 'Tope de libx264. Evita que un canal abra 1,5 × núcleos.'
  },
  {
    key: 'ramReserveMb',
    group: 'basic',
    label: 'Reserva de RAMDisk',
    unit: 'MB',
    type: 'number',
    min: 64,
    max: 4096,
    step: 32,
    fmt: (v) => `${v} MB`,
    hint: 'Si /dev/shm baja de esta reserva, los canales nuevos pasan a disco.'
  },
  {
    key: 'logLevel',
    group: 'basic',
    label: 'Registro de FFmpeg',
    type: 'select',
    options: [
      { value: 'warning', label: 'warning — avisos útiles' },
      { value: 'error', label: 'error — mínimo ruido (200+ canales)' }
    ],
    fmt: (v) => String(v),
    hint: 'Con muchos canales, error reduce escritura de logs y CPU.'
  },
  {
    key: 'tsPipeMode',
    group: 'basic',
    label: 'Salida MPEG-TS continua (.ts)',
    type: 'select',
    options: [
      { value: 'auto', label: 'auto — sólo troncales Flussonic' },
      { value: 'always', label: 'always — todos los canales' },
      { value: 'never', label: 'never — 100 % HLS en RAMDisk' }
    ],
    fmt: (v) => String(v),
    hint: 'auto es lo recomendado: los demás canales van por HLS en RAMDisk.'
  },

  // ---------- avanzados ----------
  {
    key: 'probeHttp',
    group: 'adv',
    label: 'Sonda HTTP/HLS · bytes',
    type: 'number',
    min: 1000000,
    max: 20000000,
    step: 100000,
    fmt: fmtBytes,
    hint: 'Bytes que analiza FFmpeg en fuentes remotas antes de arrancar.'
  },
  {
    key: 'analyzeHttp',
    group: 'adv',
    label: 'Sonda HTTP/HLS · tiempo',
    type: 'number',
    min: 1000000,
    max: 20000000,
    step: 500000,
    fmt: fmtUs,
    hint: 'Tiempo de análisis de la fuente remota (4 s por defecto).'
  },
  {
    key: 'probeLocal',
    group: 'adv',
    label: 'Sonda UDP/RTMP · bytes',
    type: 'number',
    min: 200000,
    max: 8000000,
    step: 100000,
    fmt: fmtBytes,
    hint: 'Fuentes locales arrancan más rápido con valores bajos.'
  },
  {
    key: 'analyzeLocal',
    group: 'adv',
    label: 'Sonda UDP/RTMP · tiempo',
    type: 'number',
    min: 200000,
    max: 8000000,
    step: 100000,
    fmt: fmtUs,
    hint: 'Para Astra / WK2500 en red local (1,5 s por defecto).'
  },
  {
    key: 'tailerIntervalMs',
    group: 'adv',
    label: 'Intervalo del tailer',
    type: 'number',
    min: 80,
    max: 500,
    step: 20,
    fmt: (v) => `${v} ms`,
    hint: 'Cada cuánto revisa el manifiesto para convertir HLS → MPEG-TS.'
  },
  {
    key: 'tailerBurst',
    group: 'adv',
    label: 'Segmentos al conectar',
    type: 'number',
    min: 1,
    max: 4,
    step: 1,
    fmt: (v) => `${v}`,
    hint: 'Cuántos segmentos se envían de golpe al entrar un cliente .ts.'
  },
  {
    key: 'prebufferSegments',
    group: 'adv',
    label: 'Prebuffer de entrega',
    type: 'number',
    min: 0,
    max: 6,
    step: 1,
    fmt: (v) => (Number(v) === 0 ? 'apagado (0)' : `${v} segmentos`),
    hint: '0 = comportamiento validado. Con 2–3 el reproductor arranca con imagen.'
  },
  {
    key: 'prebufferWaitMs',
    group: 'adv',
    label: 'Espera máxima del prebuffer',
    type: 'number',
    min: 500,
    max: 15000,
    step: 500,
    fmt: (v) => `${v} ms`,
    hint: 'Tope de espera; pasado ese tiempo se sirve lo que haya.'
  },
  {
    key: 'tsJoinOnSegment',
    group: 'adv',
    label: 'Entrada en frontera de segmento',
    type: 'bool',
    fmt: (v) => (v ? 'activado' : 'desactivado'),
    hint: 'El cliente .ts empieza con PAT/PMT y keyframe.'
  }
];

export default function FfmpegEnginePage() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showCommand, setShowCommand] = useState(false);

  const load = async (silent = false) => {
    try {
      const res = await apiFetch('/api/system/ffmpeg-engine');
      setData(res);
      // Nunca pisar lo que el administrador está editando
      if (!dirty) setForm(res.config);
    } catch (err) {
      setErrMsg(err.message || 'No se pudo leer la configuración del motor');
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(() => load(true), 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const flash = (msg = '') => {
    setNotice(msg);
    if (msg) setTimeout(() => setNotice(''), 6000);
  };

  const applyPreset = (preset) => {
    setForm((prev) => ({ ...prev, ...preset.values }));
    setDirty(true);
    flash(`Perfil «${preset.label}» cargado en el formulario. Pulsa Guardar para aplicarlo.`);
  };

  const save = async () => {
    setBusy(true);
    setErrMsg('');
    try {
      const res = await apiFetch('/api/system/ffmpeg-engine', {
        method: 'PUT',
        body: JSON.stringify(form)
      });
      setForm(res.config);
      setDirty(false);
      flash(`Configuración aplicada. Canales reiniciados de forma escalonada: ${res.restartedStreams || 0}.`);
      load(true);
    } catch (err) {
      setErrMsg(err.message || 'No se pudo aplicar la configuración');
    } finally {
      setBusy(false);
    }
  };

  const restoreDefaults = () => {
    if (!data?.defaults) return;
    setForm({ ...data.defaults });
    setDirty(true);
    flash('Valores predeterminados cargados. Pulsa Guardar para aplicarlos.');
  };

  const restartAll = async () => {
    const question = dirty
      ? 'Hay cambios sin guardar: se reiniciará con la configuración GUARDADA y esos cambios se perderán. ¿Continuar?'
      : '¿Reiniciar de forma escalonada todos los canales en transcodificación con la configuración guardada?';
    if (!window.confirm(question)) {
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch('/api/system/ffmpeg-engine', {
        method: 'PUT',
        body: JSON.stringify(data?.config || {})
      });
      flash(`Motor reiniciado en ${res.restartedStreams || 0} canal(es), uno por uno.`);
      load(true);
    } catch (err) {
      setErrMsg(err.message);
    } finally {
      setBusy(false);
    }
  };

  const rescanBinaries = async () => {
    setBusy(true);
    setErrMsg('');
    try {
      const res = await apiFetch('/api/system/ffmpeg-binaries/scan', { method: 'POST' });
      setData((prev) => ({
        ...(prev || {}),
        binaries: res.binaries || [],
        binInfo: res,
        ffmpegBin: res.bin,
        ffmpegAvailable: res.available
      }));
      flash(
        res.available
          ? `Binario en uso: ${res.bin} (${res.version || 'versión sin identificar'})`
          : 'No se pudo ejecutar ningún FFmpeg: el panel queda en Modo Direct Stream.'
      );
    } catch (err) {
      setErrMsg(err.message || 'No se pudo re-detectar los binarios');
    } finally {
      setBusy(false);
    }
  };

  const defaults = data?.defaults || {};
  const saved = data?.config || {};
  const ramOk = data ? data.hlsFreeMb >= data.hlsNeededMb : true;
  const windowSeconds = form ? form.hlsTime * form.hlsListSize : 0;
  const segMisses = data?.segmentMisses?.total ?? 0;

  // Cambios respecto al predeterminado y respecto a lo guardado en el servidor
  const changedKeys = form ? Object.keys(defaults).filter((k) => form[k] !== defaults[k] && k !== 'binPreference') : [];
  const pendingKeys = form ? Object.keys(defaults).filter((k) => form[k] !== saved[k]) : [];

  const binaries = [
    {
      id: 'auto',
      label: 'Automático (orden del motor)',
      hint: '.runtime → XUI 4.4 → 4.3 → 4.0 → bin/ffmpeg → empaquetado → PATH',
      path: data?.ffmpegBin || 'sin resolver',
      version: data?.binInfo?.version,
      ok: Boolean(data?.ffmpegAvailable),
      group: 'auto'
    },
    ...(data?.binaries || [])
  ];
  const selectedBin = binaries.find((b) => b.id === (form?.binPreference || 'auto')) || binaries[0];

  const renderValue = (field, value) => {
    if (field.fmt) return field.fmt(value);
    return String(value);
  };

  const OptionCard = ({ field }) => {
    const value = form?.[field.key];
    const def = defaults?.[field.key];
    const isChanged = value !== def;
    const isPending = value !== saved?.[field.key];

    return (
      <div
        className={`rounded-xl border p-3 transition ${
          isChanged ? 'border-amber-500/50 bg-amber-500/5' : 'border-slate-800 bg-[#090e1a]'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-slate-300">{field.label}</div>
            <div className={`mt-0.5 font-mono text-[15px] font-bold ${isChanged ? 'text-amber-300' : 'text-white'}`}>
              {form ? renderValue(field, value) : '—'}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {isChanged ? (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-200">
                Modificado
              </span>
            ) : (
              <span className="rounded bg-slate-700/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">
                Por defecto
              </span>
            )}
            {isPending ? (
              <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-200">
                Sin guardar
              </span>
            ) : null}
          </div>
        </div>

        {/* Recuadro informativo de la opción: lo que se modificó queda plasmado aquí */}
        <div className="mt-2 rounded-lg border border-slate-800 bg-[#0e1526] px-2 py-1.5 text-[10px] leading-snug">
          {isChanged ? (
            <div className="text-amber-200">
              Cambiado de <span className="font-mono">{renderValue(field, def)}</span> a{' '}
              <span className="font-mono font-bold">{renderValue(field, value)}</span>.
            </div>
          ) : (
            <div className="text-slate-500">
              Valor de fábrica: <span className="font-mono text-slate-400">{renderValue(field, def)}</span>
            </div>
          )}
          <div className="mt-0.5 text-slate-500">{field.hint}</div>
        </div>

        {editMode ? (
          <div className="mt-2 flex items-center gap-1.5">
            {field.type === 'select' ? (
              <select
                value={value ?? ''}
                onChange={(e) => setField(field.key, e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-[#0e1526] px-2 py-1.5 text-[11px] text-white"
              >
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : field.type === 'bool' ? (
              <button
                type="button"
                onClick={() => setField(field.key, !value)}
                className={`w-full rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${
                  value
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                    : 'border-slate-700 bg-[#0e1526] text-slate-400'
                }`}
              >
                {value ? 'Activado' : 'Desactivado'}
              </button>
            ) : (
              <input
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={value ?? ''}
                onChange={(e) => setField(field.key, Number(e.target.value))}
                className="w-full rounded-lg border border-slate-700 bg-[#0e1526] px-2 py-1.5 font-mono text-[11px] text-white"
              />
            )}
            {isChanged ? (
              <button
                type="button"
                title="Volver al valor de fábrica"
                onClick={() => setField(field.key, def)}
                className="shrink-0 rounded-lg border border-slate-700 px-2 py-1.5 text-slate-300 hover:bg-slate-800"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const basicFields = FIELDS.filter((f) => f.group === 'basic');
  const advFields = FIELDS.filter((f) => f.group === 'adv');

  return (
    <div className="space-y-4">
      {/* ================= Encabezado + estado ================= */}
      <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-br from-[#131c31] to-[#0e1526] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/15 p-2.5">
              <Cpu className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Motor FFmpeg</h2>
              <p className="mt-0.5 max-w-2xl text-xs text-slate-400">
                Ajustes del motor de streaming. Las opciones están <b className="text-slate-200">fijas por defecto</b>: sólo
                cambian si pulsas «Permitir cambios». Cada recuadro muestra su valor, su valor de fábrica y, si lo tocaste,
                exactamente qué cambió.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => load(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Actualizar
            </button>
            <button
              onClick={() => setEditMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold ${
                editMode
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                  : 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'
              }`}
            >
              {editMode ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              {editMode ? 'Bloquear opciones' : 'Permitir cambios'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5 text-xs md:grid-cols-4">
          {[
            {
              label: 'Canales activos',
              value: data ? `${data.activeWorkers}` : '—',
              good: (data?.activeWorkers || 0) > 0
            },
            {
              label: 'Congelados',
              value: data ? `${data.stalledWorkers}` : '—',
              good: data ? data.stalledWorkers === 0 : true
            },
            { label: 'Ventana HLS', value: `${windowSeconds} s`, good: windowSeconds <= 16 },
            {
              label: 'RAMDisk libre',
              value: data ? `${data.hlsFreeMb} MB` : '—',
              good: ramOk
            }
          ].map((box) => (
            <div key={box.label} className="rounded-xl border border-slate-800 bg-[#090e1a] p-3">
              <div className="text-slate-400">{box.label}</div>
              <div className={`mt-0.5 font-mono font-semibold ${box.good ? 'text-emerald-300' : 'text-amber-300'}`}>
                {String(box.value)}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span className="rounded-lg border border-slate-800 bg-[#090e1a] px-2 py-1">
            Binario: <span className="font-mono text-slate-200">{data?.binInfo?.version || 'sin detectar'}</span>
          </span>
          <span className="rounded-lg border border-slate-800 bg-[#090e1a] px-2 py-1">
            HLS en: <span className="font-mono text-slate-200">{data?.hlsIsRamDisk ? 'RAMDisk' : 'disco'}</span>
          </span>
          <span className={`rounded-lg border px-2 py-1 ${
            changedKeys.length
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}>
            {changedKeys.length
              ? `${changedKeys.length} opción(es) fuera del valor de fábrica`
              : 'Todo en valores de fábrica'}
          </span>
          {segMisses > 0 ? (
            <span className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-200">
              Segmentos faltantes (5 min): {segMisses}
            </span>
          ) : null}
        </div>
      </div>

      {data && !data.ffmpegAvailable ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          No se pudo ejecutar ningún binario FFmpeg: el panel queda en Modo Direct Stream.
        </div>
      ) : null}

      {notice && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-4 py-2.5 text-xs text-emerald-200">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> {notice}
        </div>
      )}
      {errMsg && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-2.5 text-xs text-rose-200">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {errMsg}
        </div>
      )}

      {/* ================= Perfiles rápidos ================= */}
      <div className="rounded-2xl border border-slate-800/80 bg-[#0e1526] p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold text-white">
            <Zap className="h-4 w-4 text-amber-400" /> Perfiles rápidos
          </h3>
          <span className="text-[10px] text-slate-500">Un clic llena los valores; luego Guardar</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {(data?.presets || []).map((preset) => (
            <button
              key={preset.key}
              onClick={() => applyPreset(preset)}
              className="rounded-xl border border-slate-800 bg-[#090e1a] p-3 text-left transition hover:border-amber-500/40 hover:bg-amber-500/10"
            >
              <div className="text-xs font-bold text-amber-200">{preset.label}</div>
              <div className="mt-1 font-mono text-[10px] leading-relaxed text-slate-400">
                segmento {preset.values.hlsTime ?? '—'} s · lista {preset.values.hlsListSize ?? '—'} · TS{' '}
                {preset.values.tsPipeMode ?? '—'} · {preset.values.h264Threads ?? '—'} hilos
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ================= Opciones (recuadros estáticos) ================= */}
      <div className="rounded-2xl border border-slate-800/80 bg-[#0e1526] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-bold text-white">
            <SlidersHorizontal className="h-4 w-4 text-emerald-400" /> Opciones del motor
          </h3>
          <span
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-semibold ${
              editMode
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : 'border-slate-700 bg-[#090e1a] text-slate-400'
            }`}
          >
            {editMode ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            {editMode ? 'Editable' : 'Sólo lectura'}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {basicFields.map((field) => (
            <OptionCard key={field.key} field={field} />
          ))}
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-[#090e1a] px-3 py-1.5 text-[11px] font-semibold text-slate-300 hover:bg-slate-800"
        >
          {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {showAdvanced ? 'Ocultar opciones avanzadas' : 'Mostrar opciones avanzadas (sonda, tailer, prebuffer)'}
        </button>

        {showAdvanced ? (
          <>
            <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {advFields.map((field) => (
                <OptionCard key={field.key} field={field} />
              ))}
            </div>
            <div className="mt-2.5 rounded-xl border border-slate-800 bg-[#090e1a] p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
                <Activity className="h-3.5 w-3.5 text-sky-400" /> Prebuffer en los últimos 5 minutos
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
                {[
                  { label: 'Esperas', value: data?.prebuffer?.waits ?? 0, tone: 'text-slate-200' },
                  { label: 'Satisfechas', value: data?.prebuffer?.satisfied ?? 0, tone: 'text-emerald-300' },
                  { label: 'Tiempo agotado', value: data?.prebuffer?.timedOut ?? 0, tone: 'text-amber-300' },
                  { label: 'Espera media', value: `${data?.prebuffer?.avgMs ?? 0} ms`, tone: 'text-sky-300' }
                ].map((row) => (
                  <div key={row.label} className="rounded-lg border border-slate-800 bg-[#0e1526] px-2 py-1.5">
                    <div className="text-slate-500">{row.label}</div>
                    <div className={`font-mono font-semibold ${row.tone}`}>{row.value}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* ================= Binario (compacto) ================= */}
      <div className="rounded-2xl border border-slate-800/80 bg-[#0e1526] p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-white">
              <Binary className="h-4 w-4 text-indigo-400" /> Binario FFmpeg
            </h3>
            <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-slate-400">
              Se reutilizan los binarios ya instalados (incluidas las tres compilaciones de XUI.one). Cambiar de binario
              no altera los argumentos del motor.
            </p>
          </div>
          <button
            onClick={rescanBinaries}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Detectar
          </button>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11px] text-slate-300">Binario en uso</label>
            <select
              value={form?.binPreference || 'auto'}
              onChange={(e) => setField('binPreference', e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-[#090e1a] px-3 py-2 text-xs text-white"
            >
              {binaries.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} {b.ok ? `· ${b.version || 'ok'}` : '· no disponible'}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-xl border border-slate-800 bg-[#090e1a] p-3 text-[11px]">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${selectedBin?.ok ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className="font-semibold text-slate-200">{selectedBin?.label}</span>
              <span className="ml-auto font-mono text-[10px] text-emerald-300">
                {selectedBin?.ok ? selectedBin.version || 'ok' : 'no disponible'}
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-slate-500">{selectedBin?.path || '—'}</div>
            <div className="mt-0.5 text-[10px] text-slate-500">{selectedBin?.hint || ''}</div>
          </div>
        </div>
      </div>

      {/* ================= Comando real (colapsado) ================= */}
      <div className="rounded-2xl border border-slate-800/80 bg-[#0e1526] p-4">
        <button
          type="button"
          onClick={() => setShowCommand((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          {showCommand ? <ChevronDown className="h-4 w-4 text-cyan-400" /> : <ChevronRight className="h-4 w-4 text-cyan-400" />}
          <Terminal className="h-4 w-4 text-cyan-400" />
          <span className="text-sm font-bold text-white">Comando real que ejecuta FFmpeg</span>
        </button>
        {showCommand ? (
          <>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-slate-800 bg-[#070b13] p-3 font-mono text-[11px] text-emerald-200/90">
              {data?.sampleCommand || 'Sin canales ni perfiles para generar el ejemplo.'}
            </pre>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
              <span className="rounded-lg border border-slate-800 bg-[#090e1a] px-2 py-1">
                Binario: <span className="font-mono text-slate-200">{data?.ffmpegBin || 'no detectado'}</span>
              </span>
              <span className="rounded-lg border border-slate-800 bg-[#090e1a] px-2 py-1">
                HLS en: <span className="font-mono text-slate-200">{data?.hlsRoot || '—'}</span>
              </span>
            </div>
          </>
        ) : null}
      </div>

      {/* ================= Acciones ================= */}
      <div className="rounded-2xl border border-slate-800/80 bg-[#0e1526] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busy || !dirty}
            className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
          >
            <Save className="h-4 w-4" /> {busy ? 'Aplicando…' : 'Guardar y reiniciar escalonado'}
          </button>
          <button
            onClick={restartAll}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            <RotateCw className="h-4 w-4" /> Reiniciar con lo guardado
          </button>
          <button
            onClick={restoreDefaults}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            <Layers className="h-4 w-4" /> Restaurar de fábrica
          </button>
          {dirty && (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-300">
              <Info className="h-3.5 w-3.5" /> {pendingKeys.length} cambio(s) sin guardar
            </span>
          )}
        </div>
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-slate-500">
          <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Guardar aplica los cambios reiniciando los canales en transcodificación uno por uno (80 ms de separación);
          los clientes reconectan solos en el siguiente segmento.
        </div>
      </div>
    </div>
  );
}
