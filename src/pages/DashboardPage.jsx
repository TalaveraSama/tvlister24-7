import React, { useEffect, useState } from 'react';
import {
  Activity,
  Radio,
  Tv2,
  Film,
  Users,
  Cpu,
  HardDrive,
  Server,
  Play,
  Trash2,
  RefreshCw,
  AlertCircle,
  Clock,
  Database,
  ShieldCheck,
  ShieldAlert
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

function formatUptime(sec = 0) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${h}h ${m}m`;
}

export default function DashboardPage({ user, onPreview, setActiveTab }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stability, setStability] = useState(null);

  const loadDashboard = async () => {
    try {
      const res = await apiFetch('/api/dashboard');
      setData(res);
    } catch {
      // ignore transient error
    } finally {
      setLoading(false);
    }
  };

  const loadStability = async () => {
    try {
      const res = await apiFetch('/api/system/stability');
      setStability(res);
    } catch {
      // el bloque simplemente no se muestra si no hay permiso
    }
  };

  useEffect(() => {
    loadDashboard();
    loadStability();
    const timer = setInterval(loadDashboard, 6000);
    const stabTimer = setInterval(loadStability, 60000);
    return () => {
      clearInterval(timer);
      clearInterval(stabTimer);
    };
  }, []);

  const handleKick = async (id) => {
    await apiFetch(`/api/connections/${id}`, { method: 'DELETE' });
    loadDashboard();
  };

  if (loading && !data) {
    return <div className="p-8 text-center text-slate-400">Cargando telemetría del servidor OTT...</div>;
  }

  const { kpis = {}, telemetry = {}, servers = [], connections = [], channels247Live = [], openClaims = [] } = data || {};

  const kpiCards = [
    {
      label: 'Conexiones Activas',
      value: kpis.onlineConnections ?? 0,
      sub: 'Zapping < 0.1s • Tiempo Real',
      icon: Activity,
      color: 'from-emerald-500/20 to-teal-500/10 border-emerald-500/30 text-emerald-300'
    },
    {
      label: 'Canales en Vivo',
      value: `${kpis.runningStreams ?? 0} / ${kpis.totalStreams ?? 0}`,
      sub: 'Direct Stream & Transcode',
      icon: Radio,
      color: 'from-indigo-500/20 to-blue-500/10 border-indigo-500/30 text-indigo-300'
    },
    {
      label: 'Canales 24/7 Activos',
      value: `${kpis.runningCh247 ?? 0} / ${kpis.totalCh247 ?? 0}`,
      sub: 'Playout Dinámico + EPG',
      icon: Tv2,
      color: 'from-violet-500/20 to-purple-500/10 border-violet-500/30 text-violet-300'
    },
    {
      label: 'Líneas & Dispositivos',
      value: `${kpis.activeLines ?? 0} / ${kpis.totalLines ?? 0}`,
      sub: `${kpis.totalVod ?? 0} títulos en catálogo VOD`,
      icon: Users,
      color: 'from-cyan-500/20 to-sky-500/10 border-cyan-500/30 text-cyan-300'
    }
  ];

  const isCleanEmptyPanel =
    user?.role === 'admin' &&
    (kpis.totalStreams ?? 0) === 0 &&
    (kpis.totalLines ?? 0) === 0 &&
    (kpis.totalVod ?? 0) === 0;

  return (
    <div className="space-y-6">
      {isCleanEmptyPanel && (
        <div className="rounded-2xl bg-gradient-to-r from-indigo-600/20 via-[#0e1526] to-emerald-500/15 border border-indigo-500/35 p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4 shadow-lg">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Panel 100% Limpio • Listo para Producción
            </div>
            <h2 className="text-base sm:text-lg font-bold text-white mt-0.5">
              Sin canales ni usuarios demo precargados
            </h2>
            <p className="text-xs text-slate-300 mt-1">
              Puedes importar todos tus streams, bouquets y líneas directamente desde tu base de datos de XUI.one en 1 clic, o comenzar a crear tus propios canales.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('xui-import')}
              className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-emerald-600/25 transition"
            >
              <Database className="w-4 h-4" />
              Importar desde XUI.one
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('streams')}
              className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition"
            >
              Agregar Canal
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('lines')}
              className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition"
            >
              Crear Línea
            </button>
          </div>
        </div>
      )}

      {/* Estabilidad 24/7 — lo mismo que `tvlister-admin health` */}
      {stability?.checks?.length > 0 && (
        <div
          className={`rounded-2xl border p-4 ${
            stability.verdict === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/30'
              : stability.verdict === 'warn'
              ? 'bg-amber-500/10 border-amber-500/30'
              : 'bg-rose-500/10 border-rose-500/30'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              {stability.verdict === 'ok' ? (
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
              ) : (
                <ShieldAlert className={`w-4 h-4 ${stability.verdict === 'warn' ? 'text-amber-400' : 'text-rose-400'}`} />
              )}
              <span className="text-xs font-bold uppercase tracking-wider text-white">
                Estabilidad 24/7
              </span>
            </div>
            <span className="text-[11px] text-slate-300">
              {stability.verdict === 'ok'
                ? 'Todo en orden'
                : `${stability.fails} falla(s) · ${stability.warns} aviso(s)`}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-1">
            {stability.checks
              .filter((c) => c.level !== 'ok')
              .slice(0, 6)
              .map((c) => (
                <div key={c.id} className="text-[11px] text-slate-200 flex items-start gap-1.5">
                  <span className={c.level === 'fail' ? 'text-rose-400' : 'text-amber-400'}>
                    {c.level === 'fail' ? '●' : '●'}
                  </span>
                  <span>
                    <strong className="text-white">{c.label}:</strong> {c.detail}
                  </span>
                </div>
              ))}
            {stability.checks.every((c) => c.level === 'ok') && (
              <div className="text-[11px] text-slate-200">
                Panel, base de datos, disco, RAMDisk, canales y moduladores sin incidencias.
              </div>
            )}
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpiCards.map((c, idx) => {
          const Icon = c.icon;
          return (
            <div
              key={idx}
              className={`rounded-2xl p-5 bg-gradient-to-br ${c.color} border shadow-lg`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">{c.label}</span>
                <Icon className="w-5 h-5 opacity-85" />
              </div>
              <div className="text-3xl font-bold text-white">{c.value}</div>
              <div className="text-xs text-slate-300/80 mt-1.5">{c.sub}</div>
            </div>
          );
        })}
      </div>

      {/* Host Telemetry + 24/7 Channels Live Airing */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Server Telemetry */}
        <div className="lg:col-span-5 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-400" />
              Estado del Nodo Maestro & Balanceadores
            </h2>
            <button
              onClick={loadDashboard}
              className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300"
              title="Actualizar métricas"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
              <div className="flex items-center justify-between text-slate-400 mb-1.5">
                <span className="flex items-center gap-1"><Cpu className="w-3.5 h-3.5 text-indigo-400" /> CPU Host</span>
                <span className="font-mono font-bold text-white">{telemetry.cpuPercent}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all"
                  style={{ width: `${Math.min(100, telemetry.cpuPercent || 10)}%` }}
                />
              </div>
              <div className="mt-1.5 text-[11px] text-slate-500 truncate">
                {telemetry.cpuCores} vCPU • Uptime {formatUptime(telemetry.uptimeSeconds)}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800">
              <div className="flex items-center justify-between text-slate-400 mb-1.5">
                <span className="flex items-center gap-1"><HardDrive className="w-3.5 h-3.5 text-cyan-400" /> RAM</span>
                <span className="font-mono font-bold text-white">{telemetry.ramPercent}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-cyan-500 rounded-full transition-all"
                  style={{ width: `${Math.min(100, telemetry.ramPercent || 25)}%` }}
                />
              </div>
              <div className="mt-1.5 text-[11px] text-slate-500 flex items-center justify-between gap-1">
                <span>
                  {telemetry.ramUsedGb} GB / {telemetry.ramTotalGb} GB
                </span>
                {telemetry.hlsRamdisk && (
                  <span
                    className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono text-[9px] font-bold"
                    title={`Segmentos HLS generándose en memoria RAM (${telemetry.hlsRoot}) con 0% desgaste de disco`}
                  >
                    RAMDisk HLS ON
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2.5 pt-1">
            {servers.map((srv) => (
              <div
                key={srv.id}
                className="p-3 rounded-xl bg-[#090e1a] border border-slate-800/80 flex items-center justify-between gap-3 text-xs"
              >
                <div>
                  <div className="font-semibold text-slate-100 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    {srv.name}
                    {srv.is_main ? (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                        MAIN
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-800 text-slate-300 uppercase">
                        LB • {srv.lb_mode}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                    {srv.host}:{srv.port} • {srv.bandwidth_mbps} Mbps
                  </div>
                </div>
                <div className="text-right font-mono text-[11px] text-slate-300">
                  <div>CPU {srv.cpu_usage}%</div>
                  <div className="text-slate-400">RAM {srv.ram_usage}%</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 24/7 Custom Channels Now Playing */}
        <div className="lg:col-span-7 rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Tv2 className="w-4 h-4 text-violet-400" />
                Emisión Continua 24/7 — En el Aire Ahora
              </h2>
              {user?.role === 'admin' && (
                <button
                  onClick={() => setActiveTab('channels247')}
                  className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
                >
                  Gestionar Canales 24/7 →
                </button>
              )}
            </div>

            <div className="space-y-3">
              {channels247Live.map((ch) => {
                const st = ch.liveState || {};
                return (
                  <div
                    key={ch.id}
                    className="p-4 rounded-xl bg-[#090e1a] border border-slate-800/90 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            ch.status === 'running'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-slate-700/50 text-slate-400'
                          }`}
                        >
                          {ch.status === 'running' ? 'EN VIVO 24/7' : 'DETENIDO'}
                        </span>
                        <h3 className="font-semibold text-slate-100 text-sm truncate">{ch.name}</h3>
                      </div>

                      {st.currentItem ? (
                        <>
                          <div className="text-xs text-indigo-300 font-medium truncate">
                            ▶ {st.currentItem.title}
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-slate-800 mt-2 overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-indigo-500 to-violet-500"
                              style={{ width: `${st.progressPct || 0}%` }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" /> Restan {Math.ceil((st.remainingSec || 0) / 60)} min
                            </span>
                            <span className="truncate max-w-[230px]">
                              Sigue: {st.nextItem?.title || 'Loop'}
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="text-xs text-slate-500">Sin programación cargada</div>
                      )}
                    </div>

                    <button
                      onClick={() =>
                        onPreview({
                          id: ch.id,
                          kind: 'channel247',
                          title: ch.name,
                          watermark: ch.watermark_text,
                          liveState: st,
                          url: st.currentItem?.url
                        })
                      }
                      className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600/25 hover:bg-indigo-600 text-indigo-200 hover:text-white border border-indigo-500/35 text-xs font-semibold transition"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Ver Señal
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {openClaims.length > 0 && user?.role === 'admin' && (
            <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-amber-300">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Tienes {openClaims.length} reporte(s) de clientes abiertos ({openClaims[0].stream_name})
              </span>
              <button
                onClick={() => setActiveTab('epg')}
                className="text-amber-300 underline hover:text-amber-200"
              >
                Revisar
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Live Client Connections Monitor */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-400" />
            Monitor de Conexiones de Clientes en Tiempo Real ({connections.length})
          </h2>
          <span className="text-xs text-slate-400">Actualización automática cada 6s</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#090e1a] text-slate-400 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">Línea / Usuario</th>
                <th className="px-4 py-3">Canal / Contenido</th>
                <th className="px-4 py-3">IP & País</th>
                <th className="px-4 py-3">ISP / Operador</th>
                <th className="px-4 py-3">Agente del Player (User-Agent)</th>
                <th className="px-4 py-3">Protocolo</th>
                <th className="px-4 py-3 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {connections.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    No hay clientes reproduciendo flujos en este instante.
                  </td>
                </tr>
              ) : (
                connections.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-3 font-semibold text-white">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        {c.username}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-indigo-300 font-medium">{c.target_name}</td>
                    <td className="px-4 py-3 font-mono text-amber-300">
                      {c.ip_address}{' '}
                      {c.country && c.country !== '--' && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-200 font-sans font-bold ml-1">
                          {c.country}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-block px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 text-[11px] font-medium max-w-[200px] truncate"
                        title={c.isp || 'ISP Desconocido'}
                      >
                        {c.isp || 'ISP Desconocido'}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-[280px]">
                      <div className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-violet-500/15 border border-violet-500/30 text-violet-300 text-[10px] font-semibold shrink-0">
                          {c.player_name || 'IPTV Player'}
                        </span>
                        <span
                          className="font-mono text-[11px] text-slate-400 truncate"
                          title={c.user_agent}
                        >
                          {c.user_agent}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono text-[11px]">
                        {c.protocol}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleKick(c.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 text-xs transition"
                        title="Desconectar sesión"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Kick
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
