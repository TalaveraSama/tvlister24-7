import React, { useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  CalendarClock,
  Check,
  Copy,
  Edit3,
  Film,
  Globe,
  Image as ImageIcon,
  ListVideo,
  Monitor,
  Play,
  Radio,
  RotateCw,
  Square,
  Terminal,
  Trash2,
  Users,
  Volume2
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';
import {
  Chip,
  Drawer,
  IconAction,
  InfoRow,
  ProgressBar,
  StatusPill,
  Tabs,
  formatUptime,
  sourceHost
} from './StreamsSkin.jsx';

const fmtClock = (value) => {
  if (!value) return '--:--';
  const raw = String(value).trim();
  const ms = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw)
    ? Date.parse(`${raw.replace(' ', 'T')}${/z$/i.test(raw) ? '' : 'Z'}`)
    : Date.parse(raw);
  if (!Number.isFinite(ms)) return '--:--';
  return new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
};

/* Ficha del canal: equivalente moderno de `stream_view` de XUI.one */
export default function StreamDrawer({
  stream,
  onClose,
  onPreview,
  onEdit,
  onSwitchSource,
  onToggleArchive,
  onAction,
  onProbe,
  onDelete,
  now = Date.now()
}) {
  const [tab, setTab] = useState('resumen');
  const [clients, setClients] = useState(null);
  const [clientsBusy, setClientsBusy] = useState(false);
  const [ffmpeg, setFfmpeg] = useState(null);
  const [ffmpegBusy, setFfmpegBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [epg, setEpg] = useState(null);
  const [epgBusy, setEpgBusy] = useState(false);

  const open = Boolean(stream);
  const s = stream || {};

  useEffect(() => {
    setTab('resumen');
    setCopied(false);
  }, [s.id]);

  useEffect(() => {
    if (!open || tab !== 'clientes' || clients) return;
    let alive = true;
    setClientsBusy(true);
    apiFetch('/api/connections')
      .then((rows) => {
        if (!alive) return;
        const list = (Array.isArray(rows) ? rows : []).filter(
          (c) => String(c.target_type) === 'live' && Number(c.target_id) === Number(s.id)
        );
        setClients(list);
      })
      .catch(() => alive && setClients([]))
      .finally(() => alive && setClientsBusy(false));
    return () => {
      alive = false;
    };
  }, [open, tab, clients, s.id]);

  useEffect(() => {
    if (!open || tab !== 'ffmpeg' || ffmpeg) return;
    let alive = true;
    setFfmpegBusy(true);
    apiFetch(`/api/streams/${s.id}/ffmpeg`)
      .then((res) => alive && setFfmpeg(res.command || ''))
      .catch(() => alive && setFfmpeg('No se pudo leer el comando FFmpeg de este canal.'))
      .finally(() => alive && setFfmpegBusy(false));
    return () => {
      alive = false;
    };
  }, [open, tab, ffmpeg, s.id]);

  useEffect(() => {
    if (!open || tab !== 'epg' || epg) return;
    let alive = true;
    setEpgBusy(true);
    apiFetch(`/api/epg?channel_id=${encodeURIComponent(s.epg_channel_id || '')}&limit=40`)
      .then((res) => alive && setEpg(Array.isArray(res?.programs) ? res.programs : []))
      .catch(() => alive && setEpg([]))
      .finally(() => alive && setEpgBusy(false));
    return () => {
      alive = false;
    };
  }, [open, tab, epg, s.id, s.epg_channel_id]);

  const hasSource2 = Boolean(String(s.backup_url || '').trim());
  const activeUrl = s.failover_active && hasSource2 ? String(s.backup_url).trim() : s.source_url;
  const audioLevelOn =
    s.audio_leveling_mode === 'on' ||
    (s.audio_leveling_mode !== 'off' &&
      String(s.profile_name || '').toLowerCase().includes('audio nivelado'));
  const uptime = formatUptime(s.uptime_started_at, now);
  const clientsTotal = clients ? clients.length : s.clients || 0;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(ffmpeg || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={560}
      title={s.name || 'Canal'}
      subtitle={`${s.category_name || 'General'} · ID ${s.id || '—'} · ${
        s.server_name || 'Servidor 1'
      }`}
      badge={hasSource2 ? <Chip tone="sky">SOURCE 2</Chip> : null}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <IconAction
              icon={Play}
              tone="indigo"
              label="Previsualizar"
              onClick={() => onPreview?.({ id: s.id, kind: 'live', title: s.name, url: s.source_url })}
            />
            {s.status === 'running' ? (
              <IconAction icon={Square} tone="amber" label="Detener" onClick={() => onAction?.(s.id, 'stop')} />
            ) : (
              <IconAction icon={RotateCw} tone="emerald" label="Iniciar" onClick={() => onAction?.(s.id, 'start')} />
            )}
            <IconAction icon={Monitor} label="Medir resolución" onClick={() => onProbe?.(s)} />
            <IconAction icon={Terminal} label="Comando FFmpeg" onClick={() => setTab('ffmpeg')} />
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onEdit?.(s)}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/70 px-2.5 text-[11px] font-semibold text-slate-200 transition hover:text-white"
            >
              <Edit3 className="h-3 w-3" />
              Editar
            </button>
            <button
              type="button"
              onClick={() => onDelete?.(s.id)}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/12 px-2.5 text-[11px] font-semibold text-rose-300 transition hover:bg-rose-500/25"
            >
              <Trash2 className="h-3 w-3" />
              Eliminar
            </button>
          </div>
        </div>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'resumen', label: 'Resumen', icon: Radio },
          { value: 'fuentes', label: 'Fuentes', icon: Globe },
          { value: 'clientes', label: 'Clientes', icon: Users, count: clientsTotal },
          { value: 'epg', label: 'EPG', icon: CalendarClock },
          { value: 'ffmpeg', label: 'FFmpeg', icon: Terminal }
        ]}
      />

      {tab === 'resumen' && (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-xl border border-slate-800/80 bg-[#0e1526] p-3">
            <div className="flex h-14 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-700/80 bg-slate-800">
              {s.logo_url ? (
                <img src={s.logo_url} alt={s.name} className="h-full w-full object-contain" />
              ) : (
                <Radio className="h-5 w-5 text-indigo-400" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <StatusPill status={s.status} uptimeStartedAt={s.uptime_started_at} now={now} />
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <Chip tone="indigo">{s.stream_mode}</Chip>
                {s.resolution_tier && (
                  <Chip tone={s.resolution_tier === 'fhd' ? 'amber' : s.resolution_tier === 'sd' ? 'emerald' : 'cyan'}>
                    {s.detected_resolution || s.resolution_tier}
                  </Chip>
                )}
                {audioLevelOn && (
                  <Chip tone="amber" icon={Volume2}>
                    Audio igual
                  </Chip>
                )}
                {s.headend_node_id && <Chip tone="cyan">{s.headend_node_name || 'ProLiant'}</Chip>}
              </div>
            </div>
          </div>

          {s.epg_now ? (
            <div className="rounded-xl border border-slate-800/80 bg-[#0e1526] p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500">
                <CalendarClock className="h-3 w-3 text-indigo-400" />
                Ahora en pantalla
              </div>
              <div className="truncate text-[12px] font-semibold text-slate-100">{s.epg_now}</div>
              <ProgressBar value={s.epg_progress} tone="indigo" className="mt-2" />
              <div className="mt-1 flex items-center justify-between text-[9.5px] text-slate-500">
                <span>{s.epg_progress || 0}% del programa</span>
                {s.epg_next ? <span className="truncate">Después: {s.epg_next}</span> : null}
              </div>
            </div>
          ) : null}

          <div className="rounded-xl border border-slate-800/80 bg-[#0e1526] p-3">
            <InfoRow label="Perfil">{s.profile_name || 'Direct Stream'}</InfoRow>
            <InfoRow label="Bitrate" mono>
              {s.bitrate_kbps ? `${s.bitrate_kbps} kbps` : '—'}
            </InfoRow>
            <InfoRow label="Resolución">{s.detected_resolution || 'Sin clasificar'}</InfoRow>
            <InfoRow label="Uptime" mono>
              {uptime ? `up ${uptime}` : '—'}
            </InfoRow>
            <InfoRow label="Catchup DVR">
              {s.archive_enabled ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-ping rounded-full bg-rose-400" />
                  REC {s.tv_archive_days || 3}d · {s.archiveStats?.segmentCount || 0} segs ·{' '}
                  {s.archiveStats?.sizeMb || 0} MB
                </span>
              ) : (
                <span className="text-slate-500">Desactivado</span>
              )}
            </InfoRow>
            <InfoRow label="Respaldo">
              {s.offline_slate_mode && s.offline_slate_mode !== 'disabled' ? (
                <span className="inline-flex items-center gap-1.5 text-violet-300">
                  {s.offline_slate_mode === 'custom_image' ? (
                    <ImageIcon className="h-3 w-3" />
                  ) : (
                    <Film className="h-3 w-3" />
                  )}
                  {s.offline_slate_mode === 'custom_image' ? 'Imagen propia' : 'Video propio'}
                </span>
              ) : (
                <span className="text-slate-500">Sin respaldo</span>
              )}
            </InfoRow>
            <InfoRow label="EPG ID" mono>
              {s.epg_channel_id || '—'}
            </InfoRow>
            <InfoRow label="Notas">
              {s.notes ? <span className="whitespace-pre-wrap text-left">{s.notes}</span> : <span className="text-slate-500">—</span>}
            </InfoRow>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => onToggleArchive?.(s)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition ${
                s.archive_enabled
                  ? 'border-rose-500/40 bg-rose-500/12 text-rose-300 hover:bg-rose-500/25'
                  : 'border-slate-700/80 bg-slate-800/70 text-slate-300 hover:text-white'
              }`}
            >
              <Activity className="h-3 w-3" />
              {s.archive_enabled ? 'Apagar Catchup DVR' : 'Activar Catchup DVR'}
            </button>
            <button
              type="button"
              onClick={() => setTab('fuentes')}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-800/70 px-2.5 text-[11px] font-semibold text-slate-300 transition hover:text-white"
            >
              <Globe className="h-3 w-3" />
              Ver fuentes
            </button>
          </div>
        </div>
      )}

      {tab === 'fuentes' && (
        <div className="space-y-3">
          <div
            className={`rounded-xl border p-3 ${
              !s.failover_active
                ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
                : 'border-slate-800/80 bg-[#0e1526]'
            }`}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500">SOURCE 1</span>
              {!s.failover_active && <Chip tone="emerald">En uso</Chip>}
            </div>
            <div className="break-all font-mono text-[10.5px] text-slate-300">{s.source_url || '—'}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500">
              <Globe className="h-3 w-3" />
              {sourceHost(s.source_url)}
            </div>
          </div>

          {hasSource2 ? (
            <div
              className={`rounded-xl border p-3 ${
                s.failover_active
                  ? 'border-amber-500/40 bg-amber-500/[0.06]'
                  : 'border-slate-800/80 bg-[#0e1526]'
              }`}
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500">SOURCE 2</span>
                {s.failover_active && <Chip tone="amber">En uso</Chip>}
                <Chip tone="slate">manual</Chip>
              </div>
              <div className="break-all font-mono text-[10.5px] text-slate-300">{String(s.backup_url).trim()}</div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500">
                <Globe className="h-3 w-3" />
                {sourceHost(s.backup_url)}
              </div>
              <button
                type="button"
                onClick={() => onSwitchSource?.(s, s.failover_active ? 'primary' : 'backup')}
                className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/12 px-2.5 text-[11px] font-semibold text-sky-300 transition hover:bg-sky-500/25"
              >
                <ArrowLeftRight className="h-3 w-3" />
                {s.failover_active ? 'Volver a emitir desde SOURCE 1' : 'Emitir desde SOURCE 2'}
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-700/70 bg-[#0b1220] p-4 text-center">
              <div className="text-[11.5px] font-semibold text-slate-300">Sin SOURCE 2 guardado</div>
              <div className="mt-1 text-[10.5px] text-slate-500">
                Este canal emite sólo desde su URL principal. Puedes agregar un segundo origen manual desde
                Editar.
              </div>
            </div>
          )}

          <div className="rounded-xl border border-slate-800/80 bg-[#0b1220] p-3 text-[10.5px] leading-relaxed text-slate-500">
            El SOURCE 2 <span className="font-semibold text-slate-300">nunca entra solo</span>: se guarda y sólo
            emite cuando el administrador lo cambia a mano en este canal (no hay failover automático).
          </div>
        </div>
      )}

      {tab === 'clientes' && (
        <div className="space-y-2">
          {clientsBusy ? (
            <div className="py-6 text-center text-[11px] text-slate-500">Leyendo sesiones activas…</div>
          ) : clientsTotal === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700/70 bg-[#0b1220] p-4 text-center">
              <div className="text-[11.5px] font-semibold text-slate-300">Nadie está viendo este canal</div>
              <div className="mt-1 text-[10.5px] text-slate-500">
                Cuando un cliente abra el canal verás aquí su línea, IP, país y protocolo.
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(s.clients_by_protocol || {}).map(([proto, count]) => (
                  <Chip key={proto} tone="indigo">
                    {proto} {count}
                  </Chip>
                ))}
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-800/80">
                <table className="w-full text-left text-[10.5px]">
                  <thead className="bg-[#080d18] text-[9px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5">Línea</th>
                      <th className="px-2 py-1.5">IP / País</th>
                      <th className="px-2 py-1.5">Protocolo</th>
                      <th className="px-2 py-1.5">Desde</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {(clients || []).map((c) => (
                      <tr key={c.id} className="hover:bg-white/[0.03]">
                        <td className="px-2 py-1.5 font-semibold text-slate-200">{c.username}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-400">
                          {c.ip_address} <span className="text-slate-600">· {c.country || '--'}</span>
                        </td>
                        <td className="px-2 py-1.5">
                          <Chip tone="slate">{c.protocol}</Chip>
                        </td>
                        <td className="px-2 py-1.5 font-mono text-slate-400">{fmtClock(c.started_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'epg' && (
        <div className="space-y-2">
          {epgBusy ? (
            <div className="py-6 text-center text-[11px] text-slate-500">Leyendo programación…</div>
          ) : !s.epg_channel_id ? (
            <div className="rounded-xl border border-dashed border-slate-700/70 bg-[#0b1220] p-4 text-center text-[11px] text-slate-400">
              Este canal no tiene <span className="font-mono text-slate-200">epg_channel_id</span> asignado.
              Edita el canal para enlazarlo a tu XMLTV.
            </div>
          ) : !epg || epg.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700/70 bg-[#0b1220] p-4 text-center text-[11px] text-slate-400">
              Sin programas para <span className="font-mono text-slate-200">{s.epg_channel_id}</span> en la
              ventana de tiempo actual. Importa o sincroniza el EPG para verlo aquí.
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/60 overflow-hidden rounded-xl border border-slate-800/80">
              {epg.map((p, index) => {
                const isNow = index === 0 && s.epg_now && p.title === s.epg_now;
                return (
                  <li
                    key={p.id || `${p.start_time}-${index}`}
                    className={`flex items-start gap-2 px-2.5 py-1.5 ${isNow ? 'bg-indigo-500/[0.08]' : ''}`}
                  >
                    <span className="mt-[1px] w-20 shrink-0 font-mono text-[9.5px] text-slate-500">
                      {fmtClock(p.start_time)}–{fmtClock(p.end_time)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-semibold text-slate-200">{p.title}</span>
                      {p.description ? (
                        <span className="mt-0.5 block line-clamp-2 text-[10px] text-slate-500">{p.description}</span>
                      ) : null}
                    </span>
                    {isNow ? <Chip tone="indigo">Ahora</Chip> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {tab === 'ffmpeg' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
              <ListVideo className="h-3 w-3 text-indigo-400" />
              Comando que ejecuta este canal
            </div>
            <button
              type="button"
              onClick={copyCommand}
              className="inline-flex h-[26px] items-center gap-1 rounded-md border border-slate-700/70 bg-slate-800/60 px-2 text-[10px] font-semibold text-slate-300 transition hover:text-white"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          {ffmpegBusy ? (
            <div className="py-6 text-center text-[11px] text-slate-500">Generando comando…</div>
          ) : (
            <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap break-all rounded-xl border border-slate-800/80 bg-[#070b14] p-3 font-mono text-[10px] leading-relaxed text-emerald-200/90">
              {ffmpeg || '—'}
            </pre>
          )}
          <p className="text-[10px] leading-relaxed text-slate-500">
            Este comando es el del motor estable de TVLister: sin failover, sin segmentación XUI y sin
            sondeo de pistas de audio.
          </p>
        </div>
      )}
    </Drawer>
  );
}
