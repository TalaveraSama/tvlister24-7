import React, { useEffect, useState } from 'react';
import {
  Zap,
  Play,
  Square,
  Download,
  Network,
  Tv,
  Sliders,
  CheckCircle2,
  AlertTriangle,
  ArrowLeftRight,
  Power,
  HardDrive
} from 'lucide-react';
import { apiFetch, getToken } from '../lib/api.js';

const CATV_NUMBERS = Array.from({ length: 124 }, (_, idx) => idx + 2);

export default function Wk2500CatvPage({ setActiveTab }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [warningNotice, setWarningNotice] = useState('');
  const [errorNotice, setErrorNotice] = useState('');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState('rf_grid'); // 'rf_grid' | 'by_stream'
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'assigned' | 'enabled' | 'streaming'

  // Dedicated Network Interface (NIC) Form
  const [nicForm, setNicForm] = useState({
    if_name: '',
    ip_address: '',
    multicast_subnet: '239.25.0.0/24',
    apply_to_all_channels: true
  });
  const [savingNic, setSavingNic] = useState(false);
  const [linuxRouteCmd, setLinuxRouteCmd] = useState('');

  // MNF Peer-to-Peer Trunk Form
  const [trunkForm, setTrunkForm] = useState({
    name: 'Panel TVLister Origen (Nube)',
    origin_url: '',
    username: '',
    password: '',
    auto_assign_catv: true,
    start_catv_ch: 2
  });
  const [syncingTrunk, setSyncingTrunk] = useState(false);

  // Bulk WK2500 UDP Configurator Form
  const [bulkForm, setBulkForm] = useState({
    ch_start: 2,
    ch_end: 125,
    ip_mode: 'multicast',
    dest_ip: '239.25.0.0',
    base_port: 5000,
    local_interface_ip: '',
    ttl: 16,
    output_mode: 'direct_spts',
    muxrate_kbps: 0
  });
  const [applyingBulk, setApplyingBulk] = useState(false);

  const showToast = (msg) => {
    setErrorNotice('');
    setNotice(msg);
    setTimeout(() => setNotice(''), 9000);
  };

  const loadPlan = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await apiFetch('/api/wk2500/plan');
      setPlan(res);
      if (!silent && res.dedicated_nic) {
        setNicForm((prev) => ({
          ...prev,
          if_name: res.dedicated_nic.if_name || prev.if_name,
          ip_address: res.dedicated_nic.ip_address || prev.ip_address,
          multicast_subnet: res.dedicated_nic.multicast_subnet || '239.25.0.0/24'
        }));
        if (res.dedicated_nic.ip_address) {
          setBulkForm((prev) => ({
            ...prev,
            local_interface_ip: prev.local_interface_ip || res.dedicated_nic.ip_address
          }));
        }
      }
      if (Array.isArray(res.trunks) && res.trunks.length > 0 && !trunkForm.origin_url) {
        const t = res.trunks[0];
        setTrunkForm((prev) => ({
          ...prev,
          name: t.name || prev.name,
          origin_url: t.origin_url || '',
          username: t.username || '',
          password: t.password || ''
        }));
      }
    } catch (err) {
      if (!silent) setErrorNotice(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    loadPlan(false);
    const t = setInterval(() => loadPlan(true), 4000);
    return () => clearInterval(t);
  }, []);

  const handleSaveDedicatedNic = async (e) => {
    e.preventDefault();
    setSavingNic(true);
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/wk2500/dedicated-interface', {
        method: 'POST',
        body: JSON.stringify(nicForm)
      });
      setBulkForm((prev) => ({ ...prev, local_interface_ip: res.dedicated_nic?.ip_address || '' }));
      if (res.linuxRouteCmd) setLinuxRouteCmd(res.linuxRouteCmd);
      await loadPlan(true);
      showToast(
        res.dedicated_nic?.ip_address
          ? `🔒 Salida UDP fijada en interfaz dedicada ${res.dedicated_nic.if_name || ''} (${res.dedicated_nic.ip_address}). ${res.reboundCount} canales activos reconectados en caliente.`
          : 'Interfaz de salida UDP devuelta a ruta automática del sistema.'
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setSavingNic(false);
    }
  };

  const handleSyncMnfTrunk = async (e) => {
    e.preventDefault();
    setSyncingTrunk(true);
    setErrorNotice('');
    setWarningNotice('');
    try {
      const res = await apiFetch('/api/wk2500/mnf-trunks/sync', {
        method: 'POST',
        body: JSON.stringify(trunkForm)
      });
      if (res.maxConnWarning) setWarningNotice(res.maxConnWarning);
      await loadPlan(true);
      showToast(
        `⚡ Troncal MNF sincronizada: ${res.totalSynced} canales vía mnf:// (${res.insertedCount} nuevos, ${res.updatedCount} actualizados).`
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setSyncingTrunk(false);
    }
  };

  const handleBulkConfigure = async (autoAssignStreams = false) => {
    setApplyingBulk(true);
    setErrorNotice('');
    try {
      await apiFetch('/api/wk2500/bulk-configure', {
        method: 'POST',
        body: JSON.stringify({
          ...bulkForm,
          auto_assign_panel_streams: autoAssignStreams
        })
      });
      await loadPlan(true);
      showToast(
        autoAssignStreams
          ? `✅ Canales numerados del CH ${bulkForm.ch_start} al CH ${bulkForm.ch_end}. Puedes cambiar cualquier número (ej. pasar del 2 al 3) o activar/desactivar canal por canal abajo.`
          : `✅ Direccionamiento UDP aplicado del CH ${bulkForm.ch_start} al CH ${bulkForm.ch_end}.`
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setApplyingBulk(false);
    }
  };

  const handleSlotChange = async (catvCh, patch) => {
    setErrorNotice('');
    try {
      await apiFetch(`/api/wk2500/channels/${catvCh}`, {
        method: 'PUT',
        body: JSON.stringify(patch)
      });
      await loadPlan(true);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleSwapOrMoveSlot = async (fromCh, toCh) => {
    if (!toCh || Number(fromCh) === Number(toCh)) return;
    setErrorNotice('');
    try {
      await apiFetch('/api/wk2500/swap-or-move', {
        method: 'POST',
        body: JSON.stringify({ from_ch: Number(fromCh), to_ch: Number(toCh) })
      });
      await loadPlan(true);
      showToast(`🔀 Canal movido/intercambiado: CH ${fromCh} ↔ CH ${toCh}.`);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleAssignStreamToExactChannel = async (streamId, targetCatvCh, enabledOverride = undefined) => {
    setErrorNotice('');
    try {
      await apiFetch('/api/wk2500/assign-stream-channel', {
        method: 'POST',
        body: JSON.stringify({
          stream_id: Number(streamId),
          target_catv_ch: targetCatvCh ? Number(targetCatvCh) : null,
          enabled: enabledOverride,
          swap_if_occupied: true
        })
      });
      await loadPlan(true);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleMasterControl = async (action, catvCh = null) => {
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/wk2500/control', {
        method: 'POST',
        body: JSON.stringify({
          action,
          catv_ch: catvCh,
          ch_start: bulkForm.ch_start,
          ch_end: bulkForm.ch_end
        })
      });
      await loadPlan(true);
      if (action === 'start_all') {
        showToast(`🚀 Activados ${res.startedCount} canales UDP hacia WK2500.`);
      } else if (action === 'stop_all') {
        showToast('⏹ Todos los canales UDP fueron desactivados.');
      }
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const handleDownloadExport = async (format = 'csv') => {
    try {
      const resp = await fetch(`/api/wk2500/export-table?format=${format}`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = format === 'm3u' ? 'wk2500_udp_2_al_125.m3u' : 'wk2500_plan_canales_2_al_125.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorNotice(err.message);
    }
  };

  const slots = plan?.slots || [];
  const streams = plan?.streams || [];
  const interfaces = plan?.interfaces || [];
  const unconfiguredNics = plan?.unconfigured_nics || [];
  const dedicatedNic = plan?.dedicated_nic || { if_name: '', ip_address: '' };
  const summary = plan?.summary || {
    total_catv_slots: 124,
    assigned_slots: 0,
    enabled_slots: 0,
    streaming_slots: 0,
    total_udp_mbps: 0
  };

  const slotMapByCh = new Map(slots.map((s) => [s.catv_ch, s]));

  const filteredSlots = slots.filter((s) => {
    if (filterMode === 'assigned' && !s.stream_id && !s.custom_source_url) return false;
    if (filterMode === 'enabled' && !s.enabled) return false;
    if (filterMode === 'streaming' && s.live_status !== 'streaming') return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      String(s.catv_ch).includes(q) ||
      String(s.freq_mhz).includes(q) ||
      String(s.effective_name || '').toLowerCase().includes(q) ||
      String(s.udp_host || '').toLowerCase().includes(q) ||
      String(s.udp_port).includes(q)
    );
  });

  const filteredStreams = streams.filter((st) => {
    if (filterMode === 'assigned' && !st.catv_assignment) return false;
    if (filterMode === 'enabled' && !st.catv_assignment?.enabled) return false;
    if (filterMode === 'streaming' && st.catv_assignment?.live_status !== 'streaming') return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      String(st.name || '').toLowerCase().includes(q) ||
      String(st.category_name || '').toLowerCase().includes(q) ||
      String(st.catv_assignment?.catv_ch || '').includes(q)
    );
  });

  return (
    <div className="space-y-5">
      {/* Header Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-[#131c31] via-[#17203a] to-[#0f172a] border border-amber-500/35 p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/35 text-amber-300 text-[11px] font-bold">
            <Tv className="w-3.5 h-3.5" />
            SALIDA UDP POR TARJETA DEDICADA · CONTROL POR CANAL (CH 2 AL 125) · SOPORTE MNF / M4F / TS / HLS
          </div>
          <h1 className="text-xl font-bold text-white">
            Moduladores Analógicos WK2500 — Selección Exacta de Canal (2, 3, 4... 125) y Red Dedicada
          </h1>
          <p className="text-xs text-slate-300 max-w-3xl leading-relaxed">
            Saca todos tus flujos UDP SPTS (`1316 bytes`) por una <strong>segunda tarjeta de red dedicada</strong> hacia tus equipos{' '}
            <strong>WK2500</strong>, elige libremente qué número exacto lleva cada televisora (si va en el <strong>2</strong>, en el{' '}
            <strong>3</strong>, etc.) y <strong>activa o desactiva</strong> cada canal de forma independiente.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {setActiveTab && (
            <button
              type="button"
              onClick={() => setActiveTab('flussonic-2312')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-indigo-600/25 hover:bg-indigo-600/40 border border-indigo-400/40 text-indigo-200 text-xs font-bold"
            >
              <Zap className="w-3.5 h-3.5" />
              Pasar TS/HLS → M4F Flussonic
            </button>
          )}
          <button
            type="button"
            onClick={() => handleMasterControl('start_all')}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-950/50"
          >
            <Play className="w-4 h-4" />
            Activar Asignados
          </button>
          <button
            type="button"
            onClick={() => handleMasterControl('stop_all')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-rose-600/25 hover:bg-rose-600/40 border border-rose-500/40 text-rose-200 text-xs font-bold"
          >
            <Square className="w-3.5 h-3.5" />
            Desactivar Todos
          </button>
          <button
            type="button"
            onClick={() => handleDownloadExport('csv')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-amber-200 text-xs font-bold"
          >
            <Download className="w-3.5 h-3.5" />
            CSV WK2500
          </button>
        </div>
      </div>

      {/* Dedicated Network Interface (NIC) Selector Card */}
      <form
        onSubmit={handleSaveDedicatedNic}
        className="rounded-2xl bg-[#0e1526] border border-cyan-500/40 p-4 space-y-3"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-bold text-white">
              Interfaz de Red Dedicada para Salida UDP hacia WK2500 (Aísla el tráfico UDP del puerto de Internet)
            </h2>
          </div>
          <span
            className={`text-[11px] px-2.5 py-0.5 rounded-full font-bold ${
              dedicatedNic.ip_address
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-slate-800 text-slate-300'
            }`}
          >
            {dedicatedNic.ip_address
              ? `🔒 Salida Fija en ${dedicatedNic.if_name || 'NIC'} (${dedicatedNic.ip_address})`
              : 'Ruta Automática del Sistema'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end text-xs">
          <div className="md:col-span-5">
            <label className="text-[11px] text-slate-300 block mb-1">
              1. Elegir Tarjeta de Red Física / VLAN Detectada en este Servidor
            </label>
            <select
              value={nicForm.ip_address}
              onChange={(e) => {
                const chosenIp = e.target.value;
                const found = interfaces.find((x) => x.address === chosenIp);
                setNicForm({
                  ...nicForm,
                  ip_address: chosenIp,
                  if_name: found ? found.name : ''
                });
              }}
              className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            >
              <option value="">— Ruta automática del Kernel (sin fijar tarjeta) —</option>
              {interfaces.map((iface) => (
                <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                  {iface.name} — {iface.address} ({iface.operstate?.toUpperCase() || 'UP'}
                  {iface.speedMbps ? ` · ${iface.speedMbps} Mbps` : ''})
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <label className="text-[11px] text-slate-300 block mb-1">
              O escribir IP local de tu NIC dedicada
            </label>
            <input
              type="text"
              placeholder="Ej. 192.168.25.1"
              value={nicForm.ip_address}
              onChange={(e) => setNicForm({ ...nicForm, ip_address: e.target.value })}
              className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-cyan-300 font-mono"
            />
          </div>

          <div className="md:col-span-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={savingNic}
              className="w-full py-2 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-bold transition shadow-lg shadow-cyan-950/40"
            >
              {savingNic ? 'Aplicando NIC...' : '🔒 Fijar Salida UDP en esta Tarjeta'}
            </button>
          </div>
        </div>

        {unconfiguredNics.length > 0 && (
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200">
            💡 Tarjetas físicas detectadas aún sin IP IPv4 asignada:{' '}
            <strong>
              {unconfiguredNics.map((n) => `${n.name} (${n.operstate})`).join(', ')}
            </strong>
            . Para dedicar por ejemplo <code>{unconfiguredNics[0].name}</code> al switch de tus WK2500 ejecuta en consola:{' '}
            <code className="text-white bg-black/40 px-1.5 py-0.5 rounded">
              sudo ip addr add 192.168.25.1/24 dev {unconfiguredNics[0].name} && sudo ip link set {unconfiguredNics[0].name} up
            </code>
          </div>
        )}

        {linuxRouteCmd && (
          <div className="p-2.5 rounded-xl bg-slate-900/90 border border-slate-700 text-[11px] text-slate-300 flex flex-wrap items-center justify-between gap-2">
            <span>
              Tip Multicast Linux (opcional si usas IPs <code className="text-emerald-300">239.25.0.x</code> en switch dedicado):{' '}
              <code className="text-cyan-300 font-mono">{linuxRouteCmd}</code>
            </span>
          </div>
        )}
      </form>

      {notice && (
        <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-200 font-medium flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {warningNotice && (
        <div className="p-3.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-xs text-amber-100 font-medium flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span>{warningNotice}</span>
        </div>
      )}

      {errorNotice && (
        <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/45 text-xs text-rose-200 font-medium">
          ⚠️ {errorNotice}
        </div>
      )}

      {/* Collapsible / Compact MNF Trunk & Bulk UDP Addressing Cards */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <form
          onSubmit={handleSyncMnfTrunk}
          className="rounded-2xl bg-[#0e1526] border border-violet-500/35 p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold text-white flex items-center gap-2 uppercase tracking-wide">
              <Zap className="w-4 h-4 text-violet-400" />
              Troncal Panel a Panel vía MNF (`mnf://`)
            </h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-bold">
              OPCIONAL (2º VPS)
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <input
              type="text"
              required
              placeholder="http://IP_PANEL_ORIGEN:8095"
              value={trunkForm.origin_url}
              onChange={(e) => setTrunkForm({ ...trunkForm, origin_url: e.target.value })}
              className="sm:col-span-3 px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
            />
            <input
              type="text"
              required
              placeholder="Usuario línea"
              value={trunkForm.username}
              onChange={(e) => setTrunkForm({ ...trunkForm, username: e.target.value })}
              className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            />
            <input
              type="password"
              required
              placeholder="Contraseña"
              value={trunkForm.password}
              onChange={(e) => setTrunkForm({ ...trunkForm, password: e.target.value })}
              className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            />
            <button
              type="submit"
              disabled={syncingTrunk}
              className="py-1.5 px-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white font-bold"
            >
              {syncingTrunk ? 'Sincronizando...' : '⚡ Traer por MNF'}
            </button>
          </div>
        </form>

        <div className="rounded-2xl bg-[#0e1526] border border-amber-500/35 p-4 space-y-3">
          <h2 className="text-xs font-bold text-white flex items-center gap-2 uppercase tracking-wide">
            <Sliders className="w-4 h-4 text-amber-400" />
            Plantilla Rápida IP/Puerto UDP para Rango WK2500
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <input
              type="number"
              min={2}
              max={125}
              value={bulkForm.ch_start}
              onChange={(e) => setBulkForm({ ...bulkForm, ch_start: Number(e.target.value) })}
              className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-amber-300 font-bold"
              title="Canal Inicial"
            />
            <input
              type="number"
              min={2}
              max={125}
              value={bulkForm.ch_end}
              onChange={(e) => setBulkForm({ ...bulkForm, ch_end: Number(e.target.value) })}
              className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-amber-300 font-bold"
              title="Canal Final"
            />
            <select
              value={bulkForm.ip_mode}
              onChange={(e) =>
                setBulkForm({
                  ...bulkForm,
                  ip_mode: e.target.value,
                  dest_ip: e.target.value === 'multicast' ? '239.25.0.0' : '192.168.25.10'
                })
              }
              className="px-2 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            >
              <option value="multicast">Multicast 239.x</option>
              <option value="unicast">Unicast IP WK2500</option>
            </select>
            <input
              type="text"
              value={bulkForm.dest_ip}
              onChange={(e) => setBulkForm({ ...bulkForm, dest_ip: e.target.value })}
              className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-emerald-300 font-mono"
            />
            <select
              value={bulkForm.output_mode}
              onChange={(e) => setBulkForm({ ...bulkForm, output_mode: e.target.value })}
              className="px-2 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
            >
              <option value="direct_spts">⚡ Directo 1316B</option>
              <option value="copy_mp2_leveled">🔊 Copy + MP2</option>
              <option value="copy_aac_leveled">🔊 Copy + AAC</option>
              <option value="ntsc_sd_wk2500">📺 NTSC 480 SD</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={applyingBulk}
              onClick={() => handleBulkConfigure(true)}
              className="flex-1 py-1.5 px-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold"
            >
              🔢 Auto-Llenar Canales ({bulkForm.ch_start}–{bulkForm.ch_end})
            </button>
            <button
              type="button"
              disabled={applyingBulk}
              onClick={() => handleBulkConfigure(false)}
              className="py-1.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 text-xs font-bold"
            >
              Aplicar Solo IPs/Puertos
            </button>
          </div>
        </div>
      </div>

      {/* Main Selector & Per-Channel Activation Workspace */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4 space-y-3.5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-slate-800 pb-3">
          {/* Switch between RF Grid (CH 2..125) and Stream-Centric Picker ("Elegir por Mis Canales -> CH 2, CH 3...") */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setViewMode('rf_grid')}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition ${
                viewMode === 'rf_grid'
                  ? 'bg-amber-600 text-white shadow-lg shadow-amber-950/50'
                  : 'bg-[#090e1a] border border-slate-700 text-slate-300 hover:text-white'
              }`}
            >
              📺 Grilla Numerada RF (Canal 2 al 125)
            </button>
            <button
              type="button"
              onClick={() => setViewMode('by_stream')}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition ${
                viewMode === 'by_stream'
                  ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-950/50'
                  : 'bg-[#090e1a] border border-slate-700 text-slate-300 hover:text-white'
              }`}
            >
              🎯 Elegir desde Mis Canales (Asignar si es 2, 3, 4... + Activar/Desactivar)
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filterMode}
              onChange={(e) => setFilterMode(e.target.value)}
              className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-slate-200"
            >
              <option value="all">Ver Todos</option>
              <option value="assigned">Solo Asignados ({summary.assigned_slots})</option>
              <option value="enabled">Solo Activados ({summary.enabled_slots})</option>
              <option value="streaming">Transmitiendo UDP ({summary.streaming_slots})</option>
            </select>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar nombre de canal, CH (2, 3, 10...) o IP..."
              className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white min-w-[250px]"
            />
          </div>
        </div>

        {viewMode === 'by_stream' ? (
          /* STREAM-CENTRIC VIEW: Pick exact CATV channel number (2, 3, 4... 125) and toggle ON/OFF per stream */
          <div className="overflow-x-auto rounded-xl border border-slate-800 max-h-[620px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090e1a] text-slate-400 uppercase sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2.5">Televisora / Stream en tu Panel</th>
                  <th className="px-3 py-2.5">Protocolo</th>
                  <th className="px-3 py-2.5 min-w-[250px]">Elegir Número de Canal WK2500 (2 al 125)</th>
                  <th className="px-3 py-2.5">Salida UDP & Tarjeta</th>
                  <th className="px-3 py-2.5 text-center">Activar / Desactivar Canal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredStreams.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                      No hay canales que coincidan con el filtro actual.
                    </td>
                  </tr>
                ) : (
                  filteredStreams.map((st) => {
                    const assigned = st.catv_assignment;
                    const assignedSlot = assigned ? slotMapByCh.get(assigned.catv_ch) : null;
                    const isEnabled = Boolean(assigned?.enabled);
                    const isLive = assigned?.live_status === 'streaming';

                    return (
                      <tr key={st.id} className="hover:bg-slate-800/25">
                        <td className="px-3 py-2.5">
                          <div className="font-bold text-white">{st.name}</div>
                          <div className="text-[10px] text-slate-400">{st.category_name || 'Sin Categoría'}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 text-[10px] font-bold">
                            {st.upstream_proto}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <select
                            value={assigned?.catv_ch || ''}
                            onChange={(e) =>
                              handleAssignStreamToExactChannel(
                                st.id,
                                e.target.value ? Number(e.target.value) : null
                              )
                            }
                            className="w-full px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-amber-500/40 text-xs text-amber-200 font-semibold"
                          >
                            <option value="">— No sacar por WK2500 (Sin número) —</option>
                            {CATV_NUMBERS.map((num) => {
                              const sl = slotMapByCh.get(num);
                              const occ =
                                sl?.effective_name && Number(sl.stream_id) !== Number(st.id)
                                  ? ` [Ocupado: ${sl.effective_name} — intercambiar]`
                                  : '';
                              return (
                                <option key={num} value={num}>
                                  Canal {num} ({sl?.freq_mhz || ''} MHz){occ}
                                </option>
                              );
                            })}
                          </select>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[11px]">
                          {assignedSlot ? (
                            <div>
                              <div className="text-emerald-300">
                                udp://{assignedSlot.udp_host}:{assignedSlot.udp_port}
                              </div>
                              <div className="text-[10px] text-cyan-300">
                                NIC: {assignedSlot.effective_interface_name}
                                {assignedSlot.effective_interface_ip ? ` (${assignedSlot.effective_interface_ip})` : ''}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {assigned ? (
                            <button
                              type="button"
                              title={
                                isLive
                                  ? `Enviando ${(assigned.bitrate_kbps / 1000).toFixed(1)} Mbps por UDP al WK2500 (CH ${assigned.catv_ch})`
                                  : assigned.last_error || 'Canal activado, esperando flujo del origen'
                              }
                              onClick={() => handleSlotChange(assigned.catv_ch, { enabled: !isEnabled })}
                              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition ${
                                isEnabled
                                  ? isLive
                                    ? 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30'
                                    : 'bg-amber-500/15 border border-amber-500/45 text-amber-300 hover:bg-amber-500/25'
                                  : 'bg-slate-800 border border-slate-700 text-slate-400 hover:text-white'
                              }`}
                            >
                              <Power className="w-3.5 h-3.5" />
                              {!isEnabled
                                ? 'DESACTIVADO'
                                : isLive
                                  ? `ACTIVO ${(assigned.bitrate_kbps / 1000).toFixed(1)}M`
                                  : assigned.live_status === 'reconnecting'
                                    ? 'RECONECTANDO'
                                    : 'CONECTANDO'}
                            </button>
                          ) : (
                            <span className="text-[11px] text-slate-500">Elige Nº primero</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        ) : (
          /* RF GRID VIEW: Channels 2 through 125 with Move/Swap number selector, Stream selector, NIC selector & ON/OFF Switch */
          <div className="overflow-x-auto rounded-xl border border-slate-800 max-h-[620px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090e1a] text-slate-400 uppercase sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2.5">Nº Canal CATV / Mover</th>
                  <th className="px-3 py-2.5">Frecuencia RF</th>
                  <th className="px-3 py-2.5 min-w-[230px]">Canal Asignado</th>
                  <th className="px-3 py-2.5">Tarjeta NIC Dedicada</th>
                  <th className="px-3 py-2.5">Destino UDP (WK2500)</th>
                  <th className="px-3 py-2.5">Perfil</th>
                  <th className="px-3 py-2.5 text-center">Activar / Desactivar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                      Cargando grilla CATV Canal 2 al 125...
                    </td>
                  </tr>
                ) : (
                  filteredSlots.map((slot) => {
                    const isLive = slot.live_status === 'streaming';
                    const hasAssigned = Boolean(slot.stream_id || slot.custom_source_url);
                    return (
                      <tr key={slot.catv_ch} className="hover:bg-slate-800/25">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold font-mono">
                              CH {slot.catv_ch}
                            </span>
                            {hasAssigned && (
                              <select
                                value=""
                                title="Mover o intercambiar este canal a otro número (ej. pasar del 2 al 3)"
                                onChange={(e) => {
                                  if (e.target.value) handleSwapOrMoveSlot(slot.catv_ch, Number(e.target.value));
                                }}
                                className="px-1.5 py-1 rounded bg-[#090e1a] border border-slate-700 text-[10px] text-slate-300"
                              >
                                <option value="">⇄ Mover</option>
                                {CATV_NUMBERS.filter((n) => n !== slot.catv_ch).map((n) => (
                                  <option key={n} value={n}>
                                    Pasar a CH {n}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-mono font-bold text-slate-200">{slot.freq_mhz} MHz</div>
                          <div className="text-[10px] text-slate-500">{slot.band_label}</div>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={slot.stream_id || ''}
                            onChange={(e) =>
                              handleSlotChange(slot.catv_ch, {
                                stream_id: e.target.value ? Number(e.target.value) : null,
                                enabled: e.target.value ? slot.enabled : false
                              })
                            }
                            className="w-full px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-slate-700 text-xs text-white"
                          >
                            <option value="">— Libre (Elegir canal para CH {slot.catv_ch}) —</option>
                            {streams.map((st) => (
                              <option key={st.id} value={st.id}>
                                {st.name} [{st.upstream_proto}]
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={slot.local_interface_ip || ''}
                            onChange={(e) => handleSlotChange(slot.catv_ch, { local_interface_ip: e.target.value })}
                            className="px-2 py-1 rounded bg-[#090e1a] border border-slate-700 text-[11px] text-cyan-300"
                          >
                            <option value="">
                              {dedicatedNic.ip_address
                                ? `Global (${dedicatedNic.if_name || dedicatedNic.ip_address})`
                                : 'Automática'}
                            </option>
                            {interfaces.map((iface) => (
                              <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                                {iface.name} ({iface.address})
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1 font-mono">
                            <input
                              type="text"
                              key={`h-${slot.catv_ch}-${slot.udp_host}`}
                              defaultValue={slot.udp_host}
                              onBlur={(e) => {
                                if (e.target.value.trim() && e.target.value.trim() !== slot.udp_host) {
                                  handleSlotChange(slot.catv_ch, { udp_host: e.target.value.trim() });
                                }
                              }}
                              className="w-28 px-2 py-1 rounded bg-[#090e1a] border border-slate-700 text-emerald-300 text-[11px]"
                            />
                            <span className="text-slate-500">:</span>
                            <input
                              type="number"
                              key={`p-${slot.catv_ch}-${slot.udp_port}`}
                              defaultValue={slot.udp_port}
                              onBlur={(e) => {
                                const p = Number(e.target.value);
                                if (p > 0 && p !== slot.udp_port) {
                                  handleSlotChange(slot.catv_ch, { udp_port: p });
                                }
                              }}
                              className="w-16 px-1.5 py-1 rounded bg-[#090e1a] border border-slate-700 text-cyan-300 text-[11px]"
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={slot.output_mode}
                            onChange={(e) => handleSlotChange(slot.catv_ch, { output_mode: e.target.value })}
                            className="px-2 py-1 rounded bg-[#090e1a] border border-slate-700 text-[11px] text-slate-200"
                          >
                            <option value="direct_spts">Directo 1316B</option>
                            <option value="copy_mp2_leveled">Copy + MP2 Niv.</option>
                            <option value="copy_aac_leveled">Copy + AAC Niv.</option>
                            <option value="ntsc_sd_wk2500">NTSC 480 SD</option>
                          </select>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            type="button"
                            disabled={!hasAssigned && !slot.enabled}
                            title={
                              isLive
                                ? `Enviando ${(slot.bitrate_kbps / 1000).toFixed(1)} Mbps a udp://${slot.udp_host}:${slot.udp_port}`
                                : slot.last_error || (slot.enabled ? 'Canal activado, esperando flujo del origen' : 'Canal apagado')
                            }
                            onClick={() => handleSlotChange(slot.catv_ch, { enabled: !slot.enabled })}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition ${
                              slot.enabled
                                ? isLive
                                  ? 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/35'
                                  : 'bg-amber-500/15 border border-amber-500/45 text-amber-300 hover:bg-amber-500/25'
                                : 'bg-slate-800/90 border border-slate-700 text-slate-400 hover:text-white disabled:opacity-35'
                            }`}
                          >
                            <Power className="w-3.5 h-3.5" />
                            {!slot.enabled
                              ? 'DESACTIVADO'
                              : isLive
                                ? `ACTIVO ${(slot.bitrate_kbps / 1000).toFixed(1)}M`
                                : slot.live_status === 'reconnecting'
                                  ? 'RECONECTANDO'
                                  : 'CONECTANDO'}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
