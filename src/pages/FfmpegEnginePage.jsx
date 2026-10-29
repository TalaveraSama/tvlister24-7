import React, { useEffect, useState } from 'react';
import {
  Cpu,
  Zap,
  Save,
  RotateCw,
  AlertTriangle,
  CheckCircle2,
  Terminal,
  HardDrive,
  Gauge,
  Layers,
  Radio,
  Activity,
  RefreshCw,
  Info
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

const FIELDS_NUM = [
  {
    key: 'probeHttp',
    label: 'Probe Size · HTTP/HLS',
    min: 1000000,
    max: 20000000,
    step: 100000,
    group: 'probe',
    hint: 'Bytes que FFmpeg analiza antes de arrancar. 5 000 000 evita perder SPS/PPS en HD de 8–12 Mbps.'
  },
  {
    key: 'analyzeHttp',
    label: 'Analysis Duration · HTTP/HLS (µs)',
    min: 1000000,
    max: 20000000,
    step: 500000,
    group: 'probe',
    hint: 'Tiempo de análisis de la fuente remota. 4 000 000 = 4 s.'
  },
  {
    key: 'probeLocal',
    label: 'Probe Size · UDP/RTMP/archivo',
    min: 200000,
    max: 8000000,
    step: 100000,
    group: 'probe',
    hint: 'Fuentes locales arrancan más rápido con valores bajos (1,5 MB).'
  },
  {
    key: 'analyzeLocal',
    label: 'Analysis Duration · UDP/RTMP (µs)',
    min: 200000,
    max: 8000000,
    step: 100000,
    group: 'probe',
    hint: 'Para Astra/WK2500 en red local. 1 500 000 = 1,5 s.'
  },
  {
    key: 'hlsTime',
    label: 'Duración de segmento HLS (s)',
    min: 1,
    max: 10,
    step: 1,
    group: 'hls',
    hint: '2 s = equilibrio entre latencia y estabilidad. 1 s = baja latencia, más archivos.'
  },
  {
    key: 'hlsListSize',
    label: 'Segmentos en el manifiesto',
    min: 3,
    max: 12,
    step: 1,
    group: 'hls',
    hint: 'Ventana = duración × este valor. Más segmentos = más RAM en /dev/shm.'
  },
  {
    key: 'ramReserveMb',
    label: 'Reserva de RAMDisk (MB)',
    min: 64,
    max: 4096,
    step: 32,
    group: 'hls',
    hint: 'Si /dev/shm baja de esta reserva, los canales nuevos pasan a disco (evita ENOSPC).'
  },
  {
    key: 'h264Threads',
    label: 'Hilos por encoder H.264',
    min: 1,
    max: 16,
    step: 1,
    group: 'hls',
    hint: 'Tope de libx264. Sin tope FFmpeg abre 1,5 × núcleos por canal.'
  },
  {
    key: 'tailerIntervalMs',
    label: 'Intervalo del tailer (ms)',
    min: 80,
    max: 500,
    step: 20,
    group: 'tailer',
    hint: 'Cada cuánto revisa el manifiesto para convertir HLS → MPEG-TS. 160 ms es el valor probado.'
  },
  {
    key: 'tailerBurst',
    label: 'Segmentos iniciales al conectar',
    min: 1,
    max: 4,
    step: 1,
    group: 'tailer',
    hint: 'Cuántos segmentos se envían de golpe al entrar un cliente .ts (arranque rápido sin congelar).'
  }
];

export default function FfmpegEnginePage() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = async (silent = false) => {
    try {
      const res = await apiFetch('/api/system/ffmpeg-engine');
      setData(res);
      if (!dirty || silent) {
        setForm(res.config);
      }
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

  const applyPreset = (preset) => {
    setForm((prev) => ({ ...prev, ...preset.values }));
    setDirty(true);
    setNotice(`Preset "${preset.label}" cargado. Pulsa Guardar para aplicarlo.`);
    setTimeout(() => setNotice(''), 5000);
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
      setNotice(
        `Configuración aplicada. Canales reiniciados de forma escalonada: ${res.restartedStreams || 0}.`
      );
      setTimeout(() => setNotice(''), 7000);
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
    setNotice('Valores por defecto cargados. Pulsa Guardar para aplicarlos.');
    setTimeout(() => setNotice(''), 5000);
  };

  const restartAll = async () => {
    if (!window.confirm('¿Reiniciar de forma escalonada todos los canales en transcodificación con la configuración actual?')) {
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch('/api/system/ffmpeg-engine', {
        method: 'PUT',
        body: JSON.stringify(data?.config || {})
      });
      setNotice(`Motor reiniciado en ${res.restartedStreams || 0} canal(es), uno por uno.`);
      setTimeout(() => setNotice(''), 6000);
      load(true);
    } catch (err) {
      setErrMsg(err.message);
    } finally {
      setBusy(false);
    }
  };

  const ramOk = data ? data.hlsFreeMb >= data.hlsNeededMb : true;
  const windowSeconds = form ? form.hlsTime * form.hlsListSize : 0;
  const segMisses = data?.segmentMisses?.total ?? 0;

  const groups = [
    {
      id: 'probe',
      title: 'Sonda de entrada (arranque del canal)',
      icon: Radio,
      color: 'text-cyan-400'
    },
    {
      id: 'hls',
      title: 'Ventana HLS y consumo de memoria',
      icon: HardDrive,
      color: 'text-emerald-400'
    },
    {
      id: 'tailer',
      title: 'Entrega a reproductores MPEG-TS (.ts)',
      icon: Activity,
      color: 'text-fuchsia-400'
    }
  ];

  return (
    <div className="space-y-4">
      {/* Encabezado */}
      <div className="rounded-2xl bg-gradient-to-br from-[#131c31] to-[#0e1526] border border-slate-800/80 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/30">
              <Cpu className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Motor FFmpeg · Ajustes de TVLister</h2>
              <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
                Parámetros reales del motor de streaming: cómo se sonda la fuente, cómo se escribe la ventana HLS en
                RAMDisk y cómo se entrega el MPEG-TS a los reproductores. Todo cambio se aplica reiniciando los canales
                uno por uno (sin cortar a todos los usuarios a la vez).
              </p>
            </div>
          </div>
          <button
            onClick={() => load(true)}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold inline-flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Actualizar estado
          </button>
        </div>

        {/* Estado en vivo */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5 text-xs mt-4">
          {[
            {
              label: 'Canales activos',
              value: data ? `${data.activeWorkers}` : '—',
              good: (data?.activeWorkers || 0) > 0
            },
            {
              label: 'Canales congelados',
              value: data ? `${data.stalledWorkers}` : '—',
              good: data ? data.stalledWorkers === 0 : true
            },
            { label: 'Ventana HLS', value: `${windowSeconds} s`, good: windowSeconds <= 16 },
            {
              label: 'Almacenamiento',
              value: data ? (data.hlsIsRamDisk ? 'RAMDisk' : 'Disco') : '—',
              good: Boolean(data?.hlsIsRamDisk)
            },
            {
              label: 'RAMDisk libre / necesario',
              value: data ? `${data.hlsFreeMb} / ${data.hlsNeededMb} MB` : '—',
              good: ramOk
            },
            {
              label: 'Segmentos faltantes (5 min)',
              value: data ? `${segMisses}` : '—',
              good: segMisses === 0
            }
          ].map((box) => (
            <div key={box.label} className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
              <div className="text-slate-400">{box.label}</div>
              <div className={`font-mono font-semibold mt-0.5 ${box.good ? 'text-emerald-300' : 'text-amber-300'}`}>
                {String(box.value)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {notice && (
        <div className="px-4 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-200 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {notice}
        </div>
      )}
      {errMsg && (
        <div className="px-4 py-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {errMsg}
        </div>
      )}

      {/* Presets */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-400" /> Perfiles rápidos del motor
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
          {(data?.presets || []).map((preset) => (
            <button
              key={preset.key}
              onClick={() => applyPreset(preset)}
              className="p-3 rounded-xl bg-[#090e1a] hover:bg-amber-500/10 border border-slate-800 hover:border-amber-500/40 text-left transition"
            >
              <div className="text-xs font-bold text-amber-200">{preset.label}</div>
              <div className="text-[10px] text-slate-400 mt-1 font-mono leading-relaxed">
                segmento {preset.values.hlsTime ?? '—'} s · lista {preset.values.hlsListSize ?? '—'} · TS{' '}
                {preset.values.tsPipeMode ?? '—'} · {preset.values.h264Threads ?? '—'} hilos
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Ajustes agrupados */}
      {form &&
        groups.map((group) => (
          <div key={group.id} className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <group.icon className={`w-4 h-4 ${group.color}`} /> {group.title}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 text-xs">
              {FIELDS_NUM.filter((f) => f.group === group.id).map((field) => (
                <div key={field.key}>
                  <label className="block text-slate-300 mb-1">{field.label}</label>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={form[field.key]}
                    onChange={(e) => setField(field.key, Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                  <div className="text-[10px] text-slate-500 mt-1 leading-snug">{field.hint}</div>
                </div>
              ))}

              {group.id === 'hls' && (
                <div className="sm:col-span-2 xl:col-span-4">
                  <label className="block text-slate-300 mb-1">Nivel de registro de FFmpeg</label>
                  <select
                    value={form.logLevel}
                    onChange={(e) => setField('logLevel', e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="warning">warning — avisos útiles (recomendado para depurar)</option>
                    <option value="error">error — mínimo ruido (mejor con 200+ canales)</option>
                  </select>
                  <div className="text-[10px] text-slate-500 mt-1">
                    Con 145–200 canales, <b>error</b> reduce la escritura de logs y el uso de CPU del propio FFmpeg.
                  </div>
                </div>
              )}
            </div>

            {group.id === 'tailer' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => setField('tsJoinOnSegment', !form.tsJoinOnSegment)}
                  className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border transition ${
                    form.tsJoinOnSegment
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                      : 'bg-[#090e1a] border-slate-800 text-slate-400'
                  }`}
                >
                  <span className="text-left">
                    Entrar en frontera de segmento
                    <span className="block text-[10px] opacity-80">
                      El cliente .ts empieza con PAT/PMT y keyframe (recomendado)
                    </span>
                  </span>
                  <span
                    className={`w-9 h-5 rounded-full relative shrink-0 ${
                      form.tsJoinOnSegment ? 'bg-emerald-500' : 'bg-slate-700'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                        form.tsJoinOnSegment ? 'left-4.5' : 'left-0.5'
                      }`}
                    />
                  </span>
                </button>

                <div>
                  <label className="block text-slate-300 mb-1">Salida MPEG-TS continua (pipe)</label>
                  <select
                    value={form.tsPipeMode}
                    onChange={(e) => setField('tsPipeMode', e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="auto">auto — sólo troncales Flussonic (recomendado)</option>
                    <option value="always">always — todos los canales (.ts máximo, más CPU)</option>
                    <option value="never">never — 100 % HLS en RAMDisk (mínimo CPU)</option>
                  </select>
                  <div className="text-[10px] text-slate-500 mt-1">
                    Con <b>never</b> FFmpeg cierra stdout y Node no copia ni un byte de vídeo.
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

      {/* Comando real */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Terminal className="w-4 h-4 text-cyan-400" /> Comando real que ejecuta FFmpeg
        </h3>
        <p className="text-[11px] text-slate-400">
          Reconstruido ahora mismo con la configuración guardada. Se refresca cada vez que entras o pulsas
          «Actualizar estado».
        </p>
        <pre className="p-3.5 rounded-xl bg-[#070b13] border border-slate-800 text-[11px] font-mono text-emerald-200/90 overflow-x-auto whitespace-pre-wrap break-all">
          {data?.sampleCommand || 'Sin canales ni perfiles para generar el ejemplo.'}
        </pre>
        <div className="flex flex-wrap gap-2 text-[11px] text-slate-400">
          <span className="px-2 py-1 rounded-lg bg-[#090e1a] border border-slate-800">
            Binario: <span className="font-mono text-slate-200">{data?.ffmpegBin || 'no detectado'}</span>
          </span>
          <span className="px-2 py-1 rounded-lg bg-[#090e1a] border border-slate-800">
            HLS en: <span className="font-mono text-slate-200">{data?.hlsRoot || '—'}</span>
          </span>
          <span className="px-2 py-1 rounded-lg bg-[#090e1a] border border-slate-800">
            Ventana: <span className="font-mono text-slate-200">{windowSeconds} s</span>
          </span>
        </div>
      </div>

      {/* Acciones */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busy || !dirty}
            className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5"
          >
            <Save className="w-4 h-4" /> {busy ? 'Aplicando…' : 'Guardar y reiniciar escalonado'}
          </button>
          <button
            onClick={restartAll}
            disabled={busy}
            className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <RotateCw className="w-4 h-4" /> Reiniciar motor con lo guardado
          </button>
          <button
            onClick={restoreDefaults}
            disabled={busy}
            className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Layers className="w-4 h-4" /> Restaurar valores por defecto
          </button>
          {dirty && (
            <span className="text-[11px] text-amber-300 inline-flex items-center gap-1">
              <Info className="w-3.5 h-3.5" /> Hay cambios sin guardar
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-500 flex items-start gap-1.5">
          <Gauge className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          Los cambios afectan a los canales en transcodificación mientras se ejecutan. Se reinician con 80 ms de
          separación para no saturar el servidor; los clientes reconectan solos en el siguiente segmento.
        </div>
      </div>
    </div>
  );
}
