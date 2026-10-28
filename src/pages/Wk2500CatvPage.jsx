import React, { useEffect, useState } from 'react';
import {
  Radio,
  Zap,
  Play,
  Square,
  Download,
  RefreshCw,
  Network,
  Tv,
  Sliders,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import { apiFetch, getToken } from '../lib/api.js';

export default function Wk2500CatvPage() {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [warningNotice, setWarningNotice] = useState('');
  const [errorNotice, setErrorNotice] = useState('');
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'assigned' | 'streaming'

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
    setTimeout(() => setNotice(''), 8500);
  };

  const loadPlan = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await apiFetch('/api/wk2500/plan');
      setPlan(res);
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
        `⚡ Troncal MNF sincronizada: ${res.totalSynced} canales enlazados vía mnf:// (${res.insertedCount} nuevos, ${res.updatedCount} actualizados)${
          res.autoAssignedToCatv ? ' y numerados en CATV 2 al 125.' : '.'
        }`
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
          ? `✅ Canales del panel numerados automáticamente del Canal ${bulkForm.ch_start} al ${bulkForm.ch_end} con salida UDP lista para WK2500.`
          : `✅ Direccionamiento UDP aplicado del Canal ${bulkForm.ch_start} al ${bulkForm.ch_end}.`
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setApplyingBulk(false);
    }
  };

  const handleSlotChange = async (catvCh, patch) => {
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
        showToast(`🚀 Iniciando transmisión UDP 1316B en ${res.startedCount} canales CATV hacia WK2500.`);
      } else if (action === 'stop_all') {
        showToast('⏹ Todas las salidas UDP hacia WK2500 fueron detenidas.');
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
  const summary = plan?.summary || {
    total_catv_slots: 124,
    assigned_slots: 0,
    enabled_slots: 0,
    streaming_slots: 0,
    total_udp_mbps: 0
  };

  const filteredSlots = slots.filter((s) => {
    if (filterMode === 'assigned' && !s.stream_id && !s.custom_source_url) return false;
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

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-[#131c31] via-[#17203a] to-[#0f172a] border border-amber-500/35 p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/35 text-amber-300 text-[11px] font-bold">
            <Tv className="w-3.5 h-3.5" />
            MODULADORES IP-ANALÓGICO WK2500 · PLAN NTSC-M STD CANAL 2 AL 125 · TRONCAL MNF v1
          </div>
          <h1 className="text-xl font-bold text-white">
            Salida UDP SPTS (1316B) para Moduladores Analógicos WK2500 (Canales 2 al 125)
          </h1>
          <p className="text-xs text-slate-300 max-w-3xl leading-relaxed">
            Recibe canales desde otro Panel TVLister en VPS por protocolo comprimido{' '}
            <code className="text-violet-300 font-bold">mnf://</code> (o desde Flussonic / Astra) y entrega{' '}
            <strong>124 flujos UDP MPEG-TS SPTS (`pkt_size=1316`)</strong> numerados del{' '}
            <strong className="text-amber-300">Canal 2 (55.25 MHz) al Canal 125 (799.25 MHz)</strong> directo a tus equipos{' '}
            <strong>WK2500</strong> por LAN Gigabit o túnel VPN MikroTik.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleMasterControl('start_all')}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-950/50"
          >
            <Play className="w-4 h-4" />
            Encender Todos UDP (2–125)
          </button>
          <button
            type="button"
            onClick={() => handleMasterControl('stop_all')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-rose-600/25 hover:bg-rose-600/40 border border-rose-500/40 text-rose-200 text-xs font-bold"
          >
            <Square className="w-3.5 h-3.5" />
            Detener Todos
          </button>
          <button
            type="button"
            onClick={() => handleDownloadExport('csv')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-amber-200 text-xs font-bold"
          >
            <Download className="w-3.5 h-3.5" />
            Hoja CSV WK2500
          </button>
          <button
            type="button"
            onClick={() => handleDownloadExport('m3u')}
            className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-cyan-200 text-xs font-bold"
          >
            <Download className="w-3.5 h-3.5" />
            M3U UDP
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4">
          <div className="text-[11px] text-slate-400">Grilla CATV NTSC-M</div>
          <div className="text-xl font-bold text-white mt-0.5">CH 2 – CH 125</div>
          <div className="text-[11px] text-amber-300">124 canales (55.25–799.25 MHz)</div>
        </div>
        <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4">
          <div className="text-[11px] text-slate-400">Canales Asignados</div>
          <div className="text-xl font-bold text-cyan-300 mt-0.5">
            {summary.assigned_slots} / {summary.total_catv_slots}
          </div>
          <div className="text-[11px] text-slate-400">{summary.enabled_slots} marcados 24/7 autostart</div>
        </div>
        <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4">
          <div className="text-[11px] text-slate-400">Salidas UDP Activas</div>
          <div className="text-xl font-bold text-emerald-400 mt-0.5">{summary.streaming_slots} EN VIVO</div>
          <div className="text-[11px] text-emerald-300/80">Paquetes SPTS 1316 bytes</div>
        </div>
        <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4">
          <div className="text-[11px] text-slate-400">Caudal UDP Hacia WK2500</div>
          <div className="text-xl font-bold text-violet-300 mt-0.5">{summary.total_udp_mbps} Mbps</div>
          <div className="text-[11px] text-slate-400">Puerto GE1/GE2 Modulador</div>
        </div>
      </div>

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

      {/* Two Top Configuration Panels: (1) MNF Peer Trunk Importer, (2) Bulk WK2500 UDP Mapping */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Card 1: Connect to Origin TVLister VPS via MNF */}
        <form
          onSubmit={handleSyncMnfTrunk}
          className="rounded-2xl bg-[#0e1526] border border-violet-500/35 p-5 space-y-3.5"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Zap className="w-4 h-4 text-violet-400" />
              1. Conectar otro Panel TVLister Origen por Troncal MNF (`mnf://`)
            </h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-bold">
              AHORRA ~18% ANCHO DE BANDA WAN
            </span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Si este es tu segundo Panel TVLister (en otro VPS o en un servidor local junto al WK2500), escribe los datos de una línea creada en tu Panel Principal (ponle <strong>Conexiones Máximas = 150 o 0 ilimitado</strong>):
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
            <div className="sm:col-span-3">
              <label className="text-[11px] text-slate-300 block mb-1">
                URL del Panel TVLister Principal (Origen)
              </label>
              <input
                type="text"
                required
                placeholder="http://69.30.212.194:8095"
                value={trunkForm.origin_url}
                onChange={(e) => setTrunkForm({ ...trunkForm, origin_url: e.target.value })}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-300 block mb-1">Usuario Línea Troncal</label>
              <input
                type="text"
                required
                placeholder="troncal_wk2500"
                value={trunkForm.username}
                onChange={(e) => setTrunkForm({ ...trunkForm, username: e.target.value })}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-300 block mb-1">Contraseña Línea</label>
              <input
                type="password"
                required
                placeholder="••••••••"
                value={trunkForm.password}
                onChange={(e) => setTrunkForm({ ...trunkForm, password: e.target.value })}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={syncingTrunk}
                className="w-full py-2 px-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-bold transition"
              >
                {syncingTrunk ? 'Sincronizando MNF...' : '⚡ Traer Canales MNF'}
              </button>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={trunkForm.auto_assign_catv}
              onChange={(e) => setTrunkForm({ ...trunkForm, auto_assign_catv: e.target.checked })}
              className="rounded accent-violet-500"
            />
            Asignar automáticamente los canales recibidos del <strong>Canal 2 al Canal 125</strong>
          </label>
        </form>

        {/* Card 2: Bulk UDP Addressing & WK2500 Output Profile */}
        <div className="rounded-2xl bg-[#0e1526] border border-amber-500/35 p-5 space-y-3.5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-amber-400" />
              2. Configurador IP UDP Hacia Equipos WK2500 (Por Rango o Completo 2–125)
            </h2>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Desde Canal</label>
              <input
                type="number"
                min={2}
                max={125}
                value={bulkForm.ch_start}
                onChange={(e) => setBulkForm({ ...bulkForm, ch_start: Number(e.target.value) })}
                className="w-full px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-amber-300 font-bold"
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Hasta Canal</label>
              <input
                type="number"
                min={2}
                max={125}
                value={bulkForm.ch_end}
                onChange={(e) => setBulkForm({ ...bulkForm, ch_end: Number(e.target.value) })}
                className="w-full px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-amber-300 font-bold"
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Modo Red UDP</label>
              <select
                value={bulkForm.ip_mode}
                onChange={(e) =>
                  setBulkForm({
                    ...bulkForm,
                    ip_mode: e.target.value,
                    dest_ip: e.target.value === 'multicast' ? '239.25.0.0' : '192.168.88.201'
                  })
                }
                className="w-full px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              >
                <option value="multicast">Multicast LAN (239.x.x.CH)</option>
                <option value="unicast">Unicast IP WK2500 / VPN</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Puerto Base (+CH)</label>
              <input
                type="number"
                value={bulkForm.base_port}
                onChange={(e) => setBulkForm({ ...bulkForm, base_port: Number(e.target.value) })}
                className="w-full px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-cyan-300 font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">
                {bulkForm.ip_mode === 'multicast' ? 'Subred Multicast (ej. 239.25.0.0)' : 'IP GE1/GE2 del WK2500'}
              </label>
              <input
                type="text"
                value={bulkForm.dest_ip}
                onChange={(e) => setBulkForm({ ...bulkForm, dest_ip: e.target.value })}
                className="w-full px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-emerald-300 font-mono"
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Interfaz / VPN de Salida</label>
              <select
                value={bulkForm.local_interface_ip}
                onChange={(e) => setBulkForm({ ...bulkForm, local_interface_ip: e.target.value })}
                className="w-full px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              >
                <option value="">Automática (Ruta del Kernel)</option>
                {interfaces.map((iface) => (
                  <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                    {iface.name} — {iface.address}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Perfil Audio/Video WK2500</label>
              <select
                value={bulkForm.output_mode}
                onChange={(e) => setBulkForm({ ...bulkForm, output_mode: e.target.value })}
                className="w-full px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              >
                <option value="direct_spts">⚡ Directo SPTS 1316B (~0% CPU)</option>
                <option value="copy_mp2_leveled">🔊 Copy Video + Audio MP2 Nivelado</option>
                <option value="copy_aac_leveled">🔊 Copy Video + Audio AAC Nivelado</option>
                <option value="ntsc_sd_wk2500">📺 NTSC SD 720x480 H.264 + MP2</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={applyingBulk}
              onClick={() => handleBulkConfigure(true)}
              className="flex-1 py-2 px-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold transition"
            >
              🔢 Auto-Numerar Canales del Panel ({bulkForm.ch_start} al {bulkForm.ch_end})
            </button>
            <button
              type="button"
              disabled={applyingBulk}
              onClick={() => handleBulkConfigure(false)}
              className="py-2 px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 text-xs font-bold transition"
            >
              Solo Cambiar IPs/Puertos UDP
            </button>
          </div>
        </div>
      </div>

      {/* Main CATV 2..125 Channel Table */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFilterMode('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${
                filterMode === 'all' ? 'bg-amber-600 text-white' : 'bg-[#090e1a] text-slate-400'
              }`}
            >
              Todos (CH 2–125)
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('assigned')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${
                filterMode === 'assigned' ? 'bg-cyan-600 text-white' : 'bg-[#090e1a] text-slate-400'
              }`}
            >
              Asignados ({summary.assigned_slots})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('streaming')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${
                filterMode === 'streaming' ? 'bg-emerald-600 text-white' : 'bg-[#090e1a] text-slate-400'
              }`}
            >
              En Vivo UDP ({summary.streaming_slots})
            </button>
          </div>

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar CH (ej. 10, 95, 125), frecuencia MHz, canal o IP..."
            className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white min-w-[270px]"
          />
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 max-h-[600px]">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#090e1a] text-slate-400 uppercase sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2.5">Canal CATV</th>
                <th className="px-3 py-2.5">Frecuencia NTSC</th>
                <th className="px-3 py-2.5 min-w-[240px]">Canal Asignado (Panel / MNF)</th>
                <th className="px-3 py-2.5">Destino UDP (WK2500)</th>
                <th className="px-3 py-2.5">Perfil</th>
                <th className="px-3 py-2.5">Entrada / Estado</th>
                <th className="px-3 py-2.5 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    Cargando plan de frecuencias CATV Canal 2 al 125...
                  </td>
                </tr>
              ) : (
                filteredSlots.map((slot) => {
                  const isLive = slot.live_status === 'streaming';
                  return (
                    <tr key={slot.catv_ch} className="hover:bg-slate-800/25">
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold font-mono">
                          CH {slot.catv_ch}
                        </span>
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
                              stream_id: e.target.value ? Number(e.target.value) : null
                            })
                          }
                          className="w-full px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-slate-700 text-xs text-white"
                        >
                          <option value="">— Sin asignar (Slot libre) —</option>
                          {streams.map((st) => (
                            <option key={st.id} value={st.id}>
                              {st.name} ({st.category_name || 'TV'})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 font-mono">
                          <input
                            type="text"
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
                          <option value="ntsc_sd_wk2500">NTSC 480i/p SD</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                isLive
                                  ? 'bg-emerald-500/20 text-emerald-300'
                                  : slot.live_status === 'reconnecting'
                                  ? 'bg-amber-500/20 text-amber-300'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {isLive
                                ? `UDP ${slot.bitrate_kbps} kbps`
                                : slot.live_status === 'reconnecting'
                                ? 'RECONECTANDO'
                                : 'DETENIDO'}
                            </span>
                            {slot.upstream_proto !== '—' && (
                              <span className="text-[10px] text-violet-300 font-semibold">{slot.upstream_proto}</span>
                            )}
                          </div>
                          {slot.last_error && !isLive && (
                            <span className="text-[10px] text-rose-300 truncate max-w-[180px]" title={slot.last_error}>
                              {slot.last_error}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {slot.enabled || isLive ? (
                          <button
                            type="button"
                            onClick={() => handleMasterControl('stop_one', slot.catv_ch)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/35 text-rose-300 text-[11px] font-bold"
                          >
                            <Square className="w-3 h-3" />
                            Parar
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={!slot.stream_id && !slot.custom_source_url}
                            onClick={() => handleMasterControl('start_one', slot.catv_ch)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white text-[11px] font-bold"
                          >
                            <Play className="w-3 h-3" />
                            UDP ON
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
