import React, { useEffect, useState } from 'react';
import {
  Users,
  Plus,
  Link2,
  Edit3,
  Trash2,
  Copy,
  ExternalLink,
  X,
  Tv,
  Cpu,
  Check,
  Database,
  Globe,
  Wifi,
  Smartphone,
  Activity,
  ShieldAlert,
  RefreshCw,
  Search,
  PowerOff
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

function formatSessionDuration(startedAt) {
  if (!startedAt) return 'recién conectado';
  const normalized = startedAt.endsWith('Z') ? startedAt : `${startedAt.replace(' ', 'T')}Z`;
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(normalized).getTime()) / 1000));
  if (Number.isNaN(diffSec)) return 'en vivo';
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

export default function UsersDevicesPage({ user, onRefreshUser, onOpenXuiImport }) {
  const [lines, setLines] = useState([]);
  const [bouquets, setBouquets] = useState([]);
  const [packages, setPackages] = useState([]);
  const [filterType, setFilterType] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingLine, setEditingLine] = useState(null);
  const [linksLine, setLinksLine] = useState(null);
  const [sessionsLineId, setSessionsLineId] = useState(null);
  const [devicesLineId, setDevicesLineId] = useState(null);
  const [devicesState, setDevicesState] = useState({ loading: false, list: [], meta: null });
  const [registry, setRegistry] = useState(null);
  const [newDeviceMac, setNewDeviceMac] = useState('');
  const [newDeviceName, setNewDeviceName] = useState('');
  const [savingMode, setSavingMode] = useState(false);
  const [copiedKey, setCopiedKey] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const [form, setForm] = useState({
    username: '',
    password: '',
    package_id: 2,
    exp_date: '2027-12-31',
    max_connections: 2,
    device_type: 'm3u',
    mac_address: '',
    bouquet_ids: [1],
    status: 'active',
    notes: ''
  });

  const isReseller = user?.role === 'reseller';
  const isAdmin = user?.role === 'admin';

  const loadLinesOnly = async () => {
    try {
      const ln = await apiFetch('/api/lines');
      setLines(ln);
    } catch {
      // ignore transient network error during background polling
    }
  };

  const loadAll = async () => {
    setRefreshing(true);
    try {
      const [ln, bq, pk] = await Promise.all([
        apiFetch('/api/lines'),
        apiFetch('/api/bouquets'),
        apiFetch('/api/packages')
      ]);
      setLines(ln);
      setBouquets(bq);
      setPackages(pk);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadAll();
    loadRegistry();
    const timer = setInterval(loadLinesOnly, 6000);
    const registryTimer = setInterval(loadRegistry, 30000);
    return () => {
      clearInterval(timer);
      clearInterval(registryTimer);
    };
  }, []);

  const openCreate = (deviceType = 'm3u') => {
    setEditingLine(null);
    setError('');
    const randSuffix = Math.floor(Math.random() * 8999 + 1000);
    setForm({
      username: deviceType === 'mag' ? `mag_${randSuffix}` : `cliente_${randSuffix}`,
      password: Math.random().toString(36).slice(2, 10),
      package_id: packages[1]?.id || packages[0]?.id || 1,
      exp_date: '2027-12-31',
      max_connections: 2,
      device_type: deviceType,
      mac_address: deviceType === 'mag' ? '00:1A:79:5C:10:22' : '',
      bouquet_ids: [bouquets[0]?.id || 1],
      status: 'active',
      notes: ''
    });
    setModalOpen(true);
  };

  const openEdit = (l) => {
    setEditingLine(l);
    setError('');
    setForm({
      username: l.username,
      password: l.password,
      package_id: '',
      exp_date: l.exp_date ? l.exp_date.slice(0, 10) : '',
      max_connections: l.max_connections || 1,
      device_type: l.device_type || 'm3u',
      mac_address: l.mac_address || '',
      bouquet_ids: l.bouquet_ids || [1],
      status: l.status || 'active',
      notes: l.notes || ''
    });
    setModalOpen(true);
  };

  const toggleBouquet = (id) => {
    setForm((prev) => {
      const exists = prev.bouquet_ids.includes(id);
      return {
        ...prev,
        bouquet_ids: exists ? prev.bouquet_ids.filter((x) => x !== id) : [...prev.bouquet_ids, id]
      };
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const payload = {
        ...form,
        exp_date: form.exp_date ? new Date(`${form.exp_date}T23:59:59Z`).toISOString() : null
      };
      if (editingLine) {
        await apiFetch(`/api/lines/${editingLine.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      } else {
        await apiFetch('/api/lines', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }
      setModalOpen(false);
      loadAll();
      if (onRefreshUser) onRefreshUser();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar esta línea/dispositivo permanentemente?')) return;
    await apiFetch(`/api/lines/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const handleKickSession = async (connId) => {
    await apiFetch(`/api/connections/${connId}`, { method: 'DELETE' });
    await loadLinesOnly();
  };

  const handleKickAllLine = async (line) => {
    if (!window.confirm(`¿Desconectar todas las sesiones activas de "${line.username}"?`)) return;
    await apiFetch(`/api/lines/${line.id}/kick`, { method: 'POST' });
    await loadLinesOnly();
  };

  const loadRegistry = async () => {
    try {
      const r = await apiFetch('/api/devices/registry');
      setRegistry(r);
    } catch {
      /* el resumen es informativo: si falla, la página sigue funcionando */
    }
  };

  const changeRegistryMode = async (mode) => {
    setSavingMode(true);
    try {
      await apiFetch('/api/devices/registry', { method: 'POST', body: JSON.stringify({ mode }) });
      await loadRegistry();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setSavingMode(false);
    }
  };

  const openDevices = async (line) => {
    setDevicesLineId(line.id);
    setDevicesState({ loading: true, list: [], meta: null });
    try {
      const d = await apiFetch(`/api/lines/${line.id}/devices`);
      setDevicesState({
        loading: false,
        list: d.devices || [],
        meta: { ...d.line, mode: d.mode, allowed: d.line?.allowed ?? d.line?.device_limit_effective }
      });
    } catch (err) {
      setDevicesState({ loading: false, list: [], meta: null });
      window.alert(err.message);
    }
  };

  const refreshDevices = async () => {
    if (!devicesLineId) return;
    try {
      const d = await apiFetch(`/api/lines/${devicesLineId}/devices`);
      setDevicesState({
        loading: false,
        list: d.devices || [],
        meta: { ...d.line, mode: d.mode, allowed: d.line?.allowed ?? d.line?.device_limit_effective }
      });
    } catch {
      /* polling silencioso */
    }
  };

  const setDeviceLimit = async (next) => {
    if (!devicesLineId) return;
    const limit = Math.max(0, Math.min(20, Number(next) || 0));
    const r = await apiFetch(`/api/lines/${devicesLineId}/devices/limit`, {
      method: 'POST',
      body: JSON.stringify({ limit })
    });
    setDevicesState((prev) => ({
      ...prev,
      meta: {
        ...prev.meta,
        device_limit: r.device_limit,
        device_limit_effective: r.device_limit_effective,
        allowed: r.device_limit_effective
      }
    }));
    await loadLinesOnly();
  };

  const blockDevice = async (deviceId) => {
    if (!devicesLineId) return;
    if (!window.confirm(`¿Bloquear el aparato "${deviceId}"? Se le corta la sesión y no podrá volver a conectar.`))
      return;
    await apiFetch(`/api/lines/${devicesLineId}/devices/${encodeURIComponent(deviceId)}/block`, {
      method: 'POST'
    });
    await refreshDevices();
    await loadLinesOnly();
  };

  const removeDevice = async (deviceId) => {
    if (!devicesLineId) return;
    if (!window.confirm(`¿Borrar el aparato "${deviceId}" del registro? Se volverá a registrar con la próxima conexión.`))
      return;
    await apiFetch(`/api/lines/${devicesLineId}/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE'
    });
    await refreshDevices();
    await loadLinesOnly();
  };

  const allowDevice = async (deviceId) => {
    if (!devicesLineId) return;
    await apiFetch(`/api/lines/${devicesLineId}/devices/${encodeURIComponent(deviceId)}/allow`, {
      method: 'POST'
    });
    await refreshDevices();
  };

  const addDevice = async () => {
    if (!devicesLineId) return;
    const mac = newDeviceMac.trim();
    if (!mac) return;
    try {
      await apiFetch(`/api/lines/${devicesLineId}/devices`, {
        method: 'POST',
        body: JSON.stringify({ mac, name: newDeviceName.trim() })
      });
      setNewDeviceMac('');
      setNewDeviceName('');
      await refreshDevices();
    } catch (err) {
      window.alert(err.message);
    }
  };

  const resetDevices = async () => {
    if (!devicesLineId) return;
    if (!window.confirm('¿Borrar TODOS los aparatos registrados de esta línea? Se volverán a registrar al conectar.'))
      return;
    await apiFetch(`/api/lines/${devicesLineId}/devices/reset`, { method: 'POST' });
    await refreshDevices();
    await loadLinesOnly();
  };

  const handleBlockIpFirewall = async (ip, username) => {
    if (!ip) return;
    if (!window.confirm(`¿Bloquear la IP ${ip} (usuario ${username}) en el Firewall de TVLister?`)) return;
    try {
      await apiFetch('/api/firewall', {
        method: 'POST',
        body: JSON.stringify({
          rule_type: 'ip',
          value: ip,
          action: 'block',
          description: `Bloqueada desde monitor en vivo (${username})`
        })
      });
      await loadLinesOnly();
      window.alert(`IP ${ip} agregada al Firewall.`);
    } catch (err) {
      window.alert(err.message);
    }
  };

  const copyText = (key, text) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 1800);
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const onlineLinesCount = lines.filter((l) => (l.active_conns || 0) > 0).length;
  const totalLiveSessions = lines.reduce((acc, l) => acc + (l.active_conns || 0), 0);

  const q = searchQuery.trim().toLowerCase();
  const visibleLines = lines.filter((l) => {
    if (filterType === 'online' && !(l.active_conns > 0)) return false;
    if (filterType !== 'all' && filterType !== 'online' && l.device_type !== filterType) return false;
    if (!q) return true;
    const inUser = (l.username || '').toLowerCase().includes(q) || (l.notes || '').toLowerCase().includes(q);
    const inMac = (l.mac_address || '').toLowerCase().includes(q);
    const inSessions = (l.active_sessions || []).some(
      (s) =>
        (s.ip_address || '').toLowerCase().includes(q) ||
        (s.isp || '').toLowerCase().includes(q) ||
        (s.user_agent || '').toLowerCase().includes(q) ||
        (s.player_name || '').toLowerCase().includes(q) ||
        (s.target_name || '').toLowerCase().includes(q)
    );
    return inUser || inMac || inSessions;
  });

  const inspectedLine = sessionsLineId ? lines.find((l) => l.id === sessionsLineId) || null : null;

  return (
    <div className="space-y-5">
      {/* Top Filters & Actions Bar */}
      <div className="flex flex-col gap-3 bg-[#0e1526] p-4 rounded-2xl border border-slate-800/80">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {[
              { id: 'all', label: `Todos (${lines.length})` },
              {
                id: 'online',
                label: `Conectados Ahora (${onlineLinesCount})`,
                highlight: onlineLinesCount > 0
              },
              { id: 'm3u', label: 'Líneas M3U / Xtream' },
              { id: 'mag', label: 'Dispositivos MAG (Stalker)' },
              { id: 'enigma2', label: 'Enigma2' }
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setFilterType(t.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition ${
                  filterType === t.id
                    ? t.id === 'online'
                      ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/40'
                      : 'bg-indigo-600 text-white'
                    : t.highlight
                    ? 'bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 border border-emerald-500/30'
                    : 'bg-[#090e1a] text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                {t.id === 'online' && (
                  <span
                    className={`w-2 h-2 rounded-full ${
                      onlineLinesCount > 0 ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
                    }`}
                  />
                )}
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={loadAll}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#090e1a] hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-medium transition"
              title="Refrescar telemetría de conectados (auto cada 6s)"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin text-indigo-400' : ''}`} />
              En vivo ({totalLiveSessions} ses.)
            </button>
            {onOpenXuiImport && (
              <button
                onClick={onOpenXuiImport}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition"
              >
                <Database className="w-3.5 h-3.5" />
                Importar Usuarios XUI.one
              </button>
            )}
            <button
              onClick={() => openCreate('m3u')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
            >
              <Plus className="w-4 h-4" />
              Nueva Línea M3U
            </button>
            <button
              onClick={() => openCreate('mag')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 text-xs font-semibold transition"
            >
              <Tv className="w-3.5 h-3.5" />
              Agregar MAG
            </button>
          </div>
        </div>

        {/* Search by user, IP, ISP, Player Agent, or Channel */}
        <div className="relative">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por usuario, IP pública, ISP (Claro, Tigo, Starlink...), Agente del Player (TiviMate, VLC, Smarters...) o canal..."
            className="w-full pl-9 pr-4 py-2 rounded-xl bg-[#090e1a] border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500/60"
          />
        </div>
      </div>

      {/* Registro de aparatos por MAC (sustituye al DRM) */}
      {registry && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-2xl bg-[#0e1526] border border-slate-800/80 text-xs">
          <span className="flex items-center gap-1.5 font-semibold text-white">
            <Cpu className="w-4 h-4 text-cyan-400" /> Registro de aparatos
          </span>
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${
              registry.mode === 'enforce'
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                : registry.mode === 'monitor'
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
          >
            {registry.mode === 'enforce' ? 'Bloquear' : registry.mode === 'monitor' ? 'Sólo registrar' : 'Apagado'}
          </span>
          <span className="text-slate-400">
            <span className="text-white font-semibold">{registry.active}</span> activos de{' '}
            {registry.devices} registrados
          </span>
          <span className="text-slate-500">
            {registry.auto} automáticos
            {Array.isArray(registry.byType) && registry.byType.length > 0
              ? ` • ${registry.byType
                  .slice(0, 4)
                  .map((t) => `${t.type} ${t.n}`)
                  .join(' · ')}`
              : ''}
          </span>
          {registry.linesOverLimit?.length > 0 && (
            <span className="px-2 py-0.5 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-semibold">
              {registry.linesOverLimit.length} línea(s) por encima del cupo
            </span>
          )}
          {registry.drm_legacy?.length > 0 && (
            <span
              className="px-2 py-0.5 rounded-lg bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[10px] font-semibold"
              title="Canales que todavía tienen el bloque drm en Flussonic. Quítalo con: tvlister-admin devices undrm --apply"
            >
              {registry.drm_legacy.length} canal(es) con DRM antiguo en Flussonic
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {['off', 'monitor', 'enforce'].map((m) => (
              <button
                key={m}
                onClick={() => changeRegistryMode(m)}
                disabled={savingMode || registry.mode === m}
                className={`px-2.5 py-1 rounded-lg font-semibold border ${
                  registry.mode === m
                    ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40'
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                }`}
              >
                {m === 'off' ? 'Apagado' : m === 'monitor' ? 'Sólo registrar' : 'Bloquear'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Lines Table with Real-Time IP, Player Agent & ISP */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#090e1a] text-slate-400 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">Usuario / Contraseña</th>
                <th className="px-4 py-3">Dispositivo</th>
                <th className="px-4 py-3">Conexiones</th>
                <th className="px-4 py-3">Conexión en Vivo (IP • Agente Player • ISP)</th>
                <th className="px-4 py-3">Vencimiento</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Playlists & Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {visibleLines.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    {filterType === 'online'
                      ? 'Ningún suscriptor está reproduciendo contenido en este momento.'
                      : 'No se encontraron líneas con los filtros seleccionados.'}
                  </td>
                </tr>
              ) : (
                visibleLines.map((l) => {
                  const sessions = l.active_sessions || [];
                  const primary = sessions[0] || null;
                  const isOnline = sessions.length > 0;

                  return (
                    <tr
                      key={l.id}
                      className={`transition ${
                        isOnline ? 'bg-emerald-950/10 hover:bg-emerald-950/20' : 'hover:bg-slate-800/30'
                      }`}
                    >
                      <td className="px-4 py-3 align-top">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                            }`}
                            title={isOnline ? 'Conectado ahora mismo' : 'Desconectado'}
                          />
                          <span className="font-semibold text-white">{l.username}</span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 pl-4">Pass: {l.password}</div>
                        {l.owner_username && (
                          <div className="text-[10px] text-slate-500 pl-4 mt-0.5">
                            Owner: {l.owner_username}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 align-top">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-indigo-300 uppercase font-bold text-[10px]">
                          {l.device_type}
                        </span>
                        {l.mac_address && (
                          <div className="text-[11px] font-mono text-cyan-400 mt-1">{l.mac_address}</div>
                        )}
                      </td>

                      <td className="px-4 py-3 font-mono align-top">
                        <div className="flex flex-col items-start gap-1">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] ${
                              isOnline
                                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-bold'
                                : 'text-slate-400'
                            }`}
                          >
                            {l.active_conns || 0} / {l.max_connections}
                          </span>
                          {isOnline && (
                            <button
                              onClick={() => setSessionsLineId(l.id)}
                              className="text-[10px] font-sans text-indigo-400 hover:text-indigo-300 underline"
                            >
                              Ver detalle ({sessions.length})
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Real-Time IP, Player User-Agent & ISP Column */}
                      <td className="px-4 py-3 align-top min-w-[310px]">
                        {!primary ? (
                          <span className="text-slate-500 text-[11px] italic">Sin conexión activa</span>
                        ) : (
                          <div className="space-y-1.5">
                            {/* Watched Channel + Protocol */}
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold">
                                ▶ {primary.target_name || 'Stream'}
                              </span>
                              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[10px]">
                                {primary.protocol}
                              </span>
                              <span className="text-[10px] text-slate-400">
                                • {formatSessionDuration(primary.started_at)}
                              </span>
                            </div>

                            {/* Client IP + Country + ISP */}
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#090e1a] border border-slate-800 font-mono text-amber-300">
                                <Globe className="w-3 h-3 text-amber-400" />
                                {primary.ip_address}
                                {primary.country && primary.country !== '--' && (
                                  <span className="px-1 rounded bg-slate-800 text-[9px] text-slate-200 font-sans font-bold">
                                    {primary.country}
                                  </span>
                                )}
                              </span>
                              <button
                                onClick={() => copyText(`ip_${primary.id}`, primary.ip_address)}
                                className="p-1 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-300"
                                title="Copiar IP del cliente"
                              >
                                {copiedKey === `ip_${primary.id}` ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                              <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 text-[10px] font-medium max-w-[210px] truncate"
                                title={`ISP: ${primary.isp || 'Desconocido'}`}
                              >
                                <Wifi className="w-3 h-3 shrink-0 text-cyan-400" />
                                {primary.isp || 'ISP Desconocido'}
                              </span>
                            </div>

                            {/* Player User-Agent (Friendly App + Raw User-Agent) */}
                            <div className="flex items-center gap-1.5 text-[11px]">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-violet-500/15 border border-violet-500/30 text-violet-300 text-[10px] font-semibold shrink-0">
                                <Smartphone className="w-3 h-3 text-violet-400" />
                                {primary.player_name || 'IPTV Player'}
                              </span>
                              <span
                                className="font-mono text-[10px] text-slate-400 truncate max-w-[220px]"
                                title={primary.user_agent}
                              >
                                {primary.user_agent}
                              </span>
                            </div>

                            {sessions.length > 1 && (
                              <button
                                onClick={() => setSessionsLineId(l.id)}
                                className="text-[10px] text-emerald-300 hover:text-emerald-200 font-semibold"
                              >
                                + {sessions.length - 1} dispositivo(s) más conectado(s) — clic para inspeccionar
                              </button>
                            )}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 text-slate-300 align-top">
                        {l.exp_date ? new Date(l.exp_date).toLocaleDateString() : 'Ilimitado'}
                      </td>

                      <td className="px-4 py-3 align-top">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                            l.status === 'active'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          }`}
                        >
                          {l.status === 'active' ? 'ACTIVA' : 'BLOQUEADA'}
                        </span>
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className="flex items-center justify-end gap-1.5">
                          {isOnline && (
                            <>
                              <button
                                onClick={() => setSessionsLineId(l.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 font-semibold transition"
                                title="Inspeccionar IP, Agente del Player e ISP"
                              >
                                <Activity className="w-3.5 h-3.5" />
                                IP / ISP
                              </button>
                              <button
                                onClick={() => handleKickAllLine(l)}
                                className="p-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 text-amber-300"
                                title="Desconectar sesiones activas (Kick)"
                              >
                                <PowerOff className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => setLinksLine(l)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600/25 hover:bg-indigo-600 text-indigo-300 hover:text-white font-semibold transition"
                            title="Descargar M3U / XMLTV / API Xtream"
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            M3U / API
                          </button>
                          <button
                            onClick={() => openDevices(l)}
                            className={`p-1.5 rounded-lg ${
                              (l.device_count || 0) > 0
                                ? 'bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                            }`}
                            title={`Aparatos registrados por MAC (${l.device_count ?? 0})`}
                          >
                            <Smartphone className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => openEdit(l)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                            title="Editar línea"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(l.id)}
                            className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                            title="Eliminar línea"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Live Sessions Inspector Modal (IP, Player Agent, ISP, Channel & Kick) */}
      {inspectedLine && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-3xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden shadow-2xl">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  Telemetría de Conexión en Vivo — {inspectedLine.username}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Sesiones activas: {inspectedLine.active_conns || 0} / {inspectedLine.max_connections} • Actualización automática cada 6s
                </p>
              </div>
              <button onClick={() => setSessionsLineId(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-3 max-h-[75vh] overflow-y-auto text-xs">
              {(inspectedLine.active_sessions || []).length === 0 ? (
                <div className="p-8 text-center text-slate-400 bg-[#090e1a] rounded-xl border border-slate-800">
                  El usuario ya no tiene reproducciones activas en este momento.
                </div>
              ) : (
                (inspectedLine.active_sessions || []).map((s, idx) => (
                  <div
                    key={s.id}
                    className="p-4 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold text-[10px]">
                          SESIÓN #{idx + 1} • EN LÍNEA
                        </span>
                        <span className="text-white font-semibold">▶ {s.target_name}</span>
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-indigo-300 font-mono text-[10px]">
                          {s.protocol}
                        </span>
                        <span className="text-slate-400 text-[11px]">
                          Activo hace {formatSessionDuration(s.started_at)}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        {isAdmin && s.ip_address && (
                          <button
                            onClick={() => handleBlockIpFirewall(s.ip_address, inspectedLine.username)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-[11px] font-medium transition"
                            title="Bloquear esta IP en el Firewall"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            Bloquear IP
                          </button>
                        )}
                        <button
                          onClick={() => handleKickSession(s.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 text-[11px] font-semibold transition"
                        >
                          <PowerOff className="w-3.5 h-3.5" />
                          Kick Sesión
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div className="p-3 rounded-xl bg-[#0e1526] border border-slate-800/80">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center gap-1">
                          <Globe className="w-3 h-3 text-amber-400" /> Dirección IP & País
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-sm font-bold text-amber-300">
                            {s.ip_address}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-bold text-white">
                              {s.country || '--'}
                            </span>
                            <button
                              onClick={() => copyText(`modal_ip_${s.id}`, s.ip_address)}
                              className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                              title="Copiar IP"
                            >
                              {copiedKey === `modal_ip_${s.id}` ? (
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-[#0e1526] border border-slate-800/80">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center gap-1">
                          <Wifi className="w-3 h-3 text-cyan-400" /> ISP / Proveedor de Internet
                        </div>
                        <div className="text-xs font-semibold text-cyan-300 break-words">
                          {s.isp || 'ISP Desconocido'}
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-[#0e1526] border border-slate-800/80">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center gap-1">
                          <Smartphone className="w-3 h-3 text-violet-400" /> Reproductor Detectado
                        </div>
                        <div className="text-xs font-semibold text-violet-300">
                          {s.player_name || 'IPTV Player'}
                        </div>
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-[#0e1526] border border-slate-800/70">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 block mb-0.5">
                        Agente del Player (User-Agent Completo):
                      </span>
                      <code className="text-[11px] font-mono text-slate-200 break-all">
                        {s.user_agent || 'Sin User-Agent'}
                      </code>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="px-5 py-3 bg-[#131c31] border-t border-slate-800 flex items-center justify-between">
              {(inspectedLine.active_sessions || []).length > 1 ? (
                <button
                  onClick={() => handleKickAllLine(inspectedLine)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-xs font-semibold"
                >
                  <PowerOff className="w-3.5 h-3.5" />
                  Desconectar Todas las Sesiones
                </button>
              ) : (
                <div />
              )}
              <button
                onClick={() => setSessionsLineId(null)}
                className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Line Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                {editingLine ? `Editar Línea: ${editingLine.username}` : 'Crear Nueva Línea / Dispositivo'}
              </h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4 text-xs max-h-[82vh] overflow-y-auto">
              {error && (
                <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Usuario *</label>
                  <input
                    type="text"
                    required
                    disabled={Boolean(editingLine)}
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Contraseña *</label>
                  <input
                    type="text"
                    required
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">Tipo de Dispositivo</label>
                  <select
                    value={form.device_type}
                    onChange={(e) => setForm({ ...form, device_type: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="m3u">Línea M3U / Xtream / Smart TV</option>
                    <option value="mag">STB MAG (Stalker / Ministra)</option>
                    <option value="enigma2">Receptor Enigma2</option>
                  </select>
                </div>

                {form.device_type !== 'm3u' ? (
                  <div>
                    <label className="block text-slate-300 mb-1">Dirección MAC (STB)</label>
                    <input
                      type="text"
                      value={form.mac_address}
                      onChange={(e) => setForm({ ...form, mac_address: e.target.value })}
                      placeholder="00:1A:79:XX:XX:XX"
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-cyan-300 font-mono"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-slate-300 mb-1">Estado</label>
                    <select
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    >
                      <option value="active">Activa</option>
                      <option value="banned">Suspendida / Bloqueada</option>
                    </select>
                  </div>
                )}
              </div>

              {!editingLine && (isReseller || packages.length > 0) && (
                <div>
                  <label className="block text-slate-300 mb-1">
                    Paquete de Suscripción {isReseller ? '(Descuenta Créditos)' : '(Opcional)'}
                  </label>
                  <select
                    value={form.package_id}
                    onChange={(e) => setForm({ ...form, package_id: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {!isReseller && <option value="">Fecha manual personalizada</option>}
                    {packages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {p.duration_days} días • {p.max_connections} conex • {p.cost_credits} crédito(s)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!isReseller && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 mb-1">Fecha Expiración</label>
                    <input
                      type="date"
                      value={form.exp_date}
                      onChange={(e) => setForm({ ...form, exp_date: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-300 mb-1">Conexiones Simultáneas</label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={form.max_connections}
                      onChange={(e) => setForm({ ...form, max_connections: Number(e.target.value) })}
                      className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-slate-300 mb-1.5 font-medium">Bouquets Asignados</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {bouquets.map((b) => (
                    <label
                      key={b.id}
                      className="flex items-center gap-2 p-2.5 rounded-xl bg-[#090e1a] border border-slate-800 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={form.bouquet_ids.includes(b.id)}
                        onChange={() => toggleBouquet(b.id)}
                        className="rounded accent-indigo-500"
                      />
                      <span className="text-slate-200">{b.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">Notas del Cliente</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  placeholder="Ej. WhatsApp o habitación de hotel"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                >
                  {editingLine ? 'Guardar Cambios' : 'Crear Línea'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Aparatos vinculados (anti-compartición) */}
      {devicesLineId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-4xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden shadow-2xl">
            {(() => {
              const lineInfo = lines.find((x) => x.id === devicesLineId);
              const meta = devicesState.meta || {};
              const active = devicesState.list.filter((d) => d.status === 'active' && !d.blocked);
              const allowed = meta.allowed || meta.device_limit_effective || meta.max_connections || 1;
              const mode = meta.mode || registry?.mode || 'monitor';
              const overLimit = active.length > allowed;
              return (
                <>
                  <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        <Smartphone className="w-4 h-4 text-cyan-400" /> Aparatos de{' '}
                        {lineInfo?.username || 'la línea'}
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        <span className={overLimit ? 'text-amber-300 font-semibold' : 'text-white font-semibold'}>
                          {active.length}
                        </span>{' '}
                        aparato(s) de {allowed} permitido(s) • modo{' '}
                        <span
                          className={
                            mode === 'enforce'
                              ? 'text-emerald-300 font-semibold'
                              : mode === 'monitor'
                                ? 'text-amber-300 font-semibold'
                                : 'text-slate-400 font-semibold'
                          }
                        >
                          {mode === 'enforce' ? 'BLOQUEAR' : mode === 'monitor' ? 'SÓLO REGISTRAR' : 'APAGADO'}
                        </span>
                      </p>
                    </div>
                    <button onClick={() => setDevicesLineId(null)} className="text-slate-400 hover:text-white">
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-xs">
                    <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                      <span className="text-slate-300 font-semibold">Cupo de aparatos de esta línea</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          max="20"
                          value={meta.device_limit ?? 0}
                          onChange={(e) => setDeviceLimit(e.target.value)}
                          className="w-16 px-2 py-1 rounded-lg bg-[#0e1526] border border-slate-800 text-white"
                        />
                        <span className="text-[10px] text-slate-500">
                          {Number(meta.device_limit) > 0
                            ? 'cupo propio de la línea'
                            : `0 = usar las conexiones de la línea (${meta.max_connections || 1})`}
                        </span>
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        {['off', 'monitor', 'enforce'].map((m) => (
                          <button
                            key={m}
                            onClick={() => changeRegistryMode(m)}
                            disabled={savingMode || mode === m}
                            className={`px-2.5 py-1 rounded-lg font-semibold border ${
                              mode === m
                                ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40'
                                : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                            }`}
                            title={
                              m === 'off'
                                ? 'No se registra ni se corta a nadie'
                                : m === 'monitor'
                                  ? 'Se registra y se avisa, pero no se corta'
                                  : 'Se corta al aparato que pase del cupo'
                            }
                          >
                            {m === 'off' ? 'Apagado' : m === 'monitor' ? 'Sólo registrar' : 'Bloquear'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-500 -mt-2">
                      El modo es global: se aplica a todas las líneas. «Sólo registrar» deja ver qué
                      aparatos entran sin cortar a ningún cliente. Empieza así y cambia a «Bloquear»
                      cuando el registro esté completo.
                    </p>

                    {meta.device_lock && (
                      <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-amber-500/5 border border-amber-500/30">
                        <span className="text-amber-200 font-semibold">
                          Esta línea exige el token de la app propia (bloqueo antiguo)
                        </span>
                        <span className="text-[10px] text-slate-400">
                          Con esto activo, los reproductores que no sean la app de TVLister reciben
                          403. Se desactiva aquí si el cliente usa TiviMate, VLC o una TV.
                        </span>
                        <button
                          onClick={async () => {
                            await apiFetch(`/api/lines/${devicesLineId}/device-lock`, {
                              method: 'POST',
                              body: JSON.stringify({ enabled: false })
                            });
                            await refreshDevices();
                          }}
                          className="ml-auto px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 font-semibold"
                        >
                          Desactivar ese bloqueo
                        </button>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-[#090e1a] border border-slate-800">
                      <span className="text-slate-300 font-semibold">Alta manual</span>
                      <input
                        value={newDeviceMac}
                        onChange={(e) => setNewDeviceMac(e.target.value)}
                        placeholder="AA:BB:CC:DD:EE:FF"
                        className="w-48 px-2 py-1 rounded-lg bg-[#0e1526] border border-slate-800 text-white font-mono"
                      />
                      <input
                        value={newDeviceName}
                        onChange={(e) => setNewDeviceName(e.target.value)}
                        placeholder="Nombre (TV salón)"
                        className="w-40 px-2 py-1 rounded-lg bg-[#0e1526] border border-slate-800 text-white"
                      />
                      <button
                        onClick={addDevice}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 font-semibold"
                      >
                        <Plus className="w-3.5 h-3.5" /> Añadir
                      </button>
                    </div>

                    {devicesState.loading ? (
                      <div className="p-6 text-center text-slate-400">Cargando aparatos…</div>
                    ) : devicesState.list.length === 0 ? (
                      <div className="p-8 text-center text-slate-400 bg-[#090e1a] rounded-xl border border-slate-800">
                        Esta línea todavía no tiene aparatos apuntados. En cuanto el cliente abra la
                        lista M3U o su app Xtream, el aparato se registra solo (MAC, tipo, marca,
                        modelo, sistema y reproductor).
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {devicesState.list.map((d) => (
                          <div
                            key={d.device_id}
                            className={`p-3 rounded-xl border ${
                              d.blocked
                                ? 'bg-[#090e1a] border-rose-500/40 opacity-80'
                                : d.status === 'active'
                                  ? 'bg-[#090e1a] border-emerald-500/25'
                                  : 'bg-[#090e1a] border-amber-500/25 opacity-80'
                            }`}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-white font-semibold">
                                {d.mac || d.device_id}
                              </span>
                              {d.auto_registered && (
                                <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 text-[10px]">
                                  AUTO
                                </span>
                              )}
                              {d.device_type && (
                                <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] uppercase">
                                  {d.device_type}
                                </span>
                              )}
                              <span
                                className={`ml-auto px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                                  d.blocked
                                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                    : d.status === 'active'
                                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                      : d.status === 'pending'
                                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                                }`}
                              >
                                {d.blocked
                                  ? 'BLOQUEADO'
                                  : d.status === 'active'
                                    ? 'ACTIVO'
                                    : d.status === 'pending'
                                      ? 'PENDIENTE'
                                      : 'LIBERADO'}
                              </span>
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400">
                              {[d.brand, d.model].filter(Boolean).length > 0 && (
                                <span>
                                  <span className="text-slate-500">Equipo:</span>{' '}
                                  {[d.brand, d.model].filter(Boolean).join(' ')}
                                </span>
                              )}
                              {d.os && (
                                <span>
                                  <span className="text-slate-500">Sistema:</span> {d.os}
                                </span>
                              )}
                              {d.player && (
                                <span>
                                  <span className="text-slate-500">Reproductor:</span> {d.player}
                                </span>
                              )}
                              <span>
                                <span className="text-slate-500">IP:</span> {d.ip || 'sin IP'}
                              </span>
                              <span>
                                <span className="text-slate-500">Visto:</span> {d.last_seen}
                              </span>
                              <span>
                                <span className="text-slate-500">Veces:</span> {d.seen_count}
                              </span>
                            </div>
                            {d.user_agent && (
                              <div className="mt-1 font-mono text-[9px] text-slate-600 truncate">
                                {d.user_agent}
                              </div>
                            )}
                            <div className="mt-2 flex flex-wrap gap-2">
                              {d.blocked || d.status !== 'active' ? (
                                <button
                                  onClick={() => allowDevice(d.device_id)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300 font-semibold"
                                >
                                  <Check className="w-3.5 h-3.5" /> Permitir
                                </button>
                              ) : (
                                <button
                                  onClick={() => blockDevice(d.device_id)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 font-semibold"
                                >
                                  <ShieldAlert className="w-3.5 h-3.5" /> Bloquear
                                </button>
                              )}
                              <button
                                onClick={() => removeDevice(d.device_id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold"
                                title="Borra la fila: el aparato se vuelve a registrar solo al conectar"
                              >
                                <Trash2 className="w-3.5 h-3.5" /> Borrar
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800">
                      <p className="text-[10px] text-slate-500 max-w-lg">
                        El aparato se identifica por su MAC; si la app no la envía, por huella de
                        modelo + sistema + reproductor. Bloquear corta la sesión al instante; borrar
                        sólo limpia el registro.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={refreshDevices}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                        >
                          <RefreshCw className="w-3.5 h-3.5" /> Actualizar
                        </button>
                        <button
                          onClick={resetDevices}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 font-semibold"
                        >
                          <PowerOff className="w-3.5 h-3.5" /> Limpiar todos
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* M3U / XMLTV / Xtream API Modal */}
      {linksLine && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Enlaces de Integración OTT — {linksLine.username}
                </h3>
                <p className="text-xs text-slate-400">
                  Compatible con TiviMate, IPTV Smarters, VLC, Kodi, MAG Stalker & TVLister Player
                </p>
              </div>
              <button onClick={() => setLinksLine(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {[
              {
                key: 'm3u_hls',
                label: 'Lista M3U Plus (HLS .m3u8 — Recomendado)',
                url: `${origin}/get.php?username=${encodeURIComponent(linksLine.username)}&password=${encodeURIComponent(linksLine.password)}&type=m3u_plus&output=hls`
              },
              {
                key: 'm3u_ts',
                label: 'Lista M3U Plus (MPEG-TS Direct Stream)',
                url: `${origin}/get.php?username=${encodeURIComponent(linksLine.username)}&password=${encodeURIComponent(linksLine.password)}&type=m3u_plus&output=ts`
              },
              {
                key: 'xmltv',
                label: 'Guía EPG XMLTV Dinámica (Incluye Canales 24/7)',
                url: `${origin}/xmltv.php?username=${encodeURIComponent(linksLine.username)}&password=${encodeURIComponent(linksLine.password)}`
              },
              {
                key: 'xtream',
                label: 'Xtream / MS Player API Endpoint',
                url: `${origin}/player_api.php?username=${encodeURIComponent(linksLine.username)}&password=${encodeURIComponent(linksLine.password)}`
              }
            ].map((item) => (
              <div key={item.key} className="space-y-1 text-xs">
                <div className="text-slate-300 font-medium">{item.label}</div>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={item.url}
                    className="flex-1 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-800 font-mono text-indigo-300 text-[11px]"
                  />
                  <button
                    onClick={() => copyText(item.key, item.url)}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 inline-flex items-center gap-1"
                  >
                    {copiedKey === item.key ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-2 rounded-xl bg-indigo-600/25 hover:bg-indigo-600 text-indigo-200 hover:text-white"
                    title="Abrir en nueva pestaña"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            ))}

            <div className="p-3 rounded-xl bg-[#090e1a] border border-slate-800 text-xs font-mono text-slate-300">
              <div className="text-slate-400 font-sans mb-1 flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-cyan-400" /> Datos Xtream Codes Login:
              </div>
              Host: <span className="text-emerald-300">{origin}</span> • Usuario:{' '}
              <span className="text-white">{linksLine.username}</span> • Pass:{' '}
              <span className="text-white">{linksLine.password}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
