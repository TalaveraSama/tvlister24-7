import React, { useEffect, useState } from 'react';
import {
  Cpu,
  Plus,
  Copy,
  Check,
  Radio,
  Zap,
  Volume2,
  Monitor,
  RefreshCw,
  Upload,
  Play,
  Trash2,
  Save,
  Server,
  Wifi,
  CheckSquare,
  Flame,
  Leaf,
  Layers,
  X
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

export default function HeadendNodesPage({ onPreview }) {
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [nodeStreams, setNodeStreams] = useState([]);
  const [totalCloudStreams, setTotalCloudStreams] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: 'HP ProLiant G9 — Cabecera Astra',
    public_url: '',
    astra_url: 'http://127.0.0.1:8000',
    astra_auth: '',
    allowed_cloud_ip: ''
  });

  const [settingsForm, setSettingsForm] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [notice, setNotice] = useState('');
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Astra Discovery & Import Modal
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState('migrate'); // 'migrate' | 'scan' | 'paste'
  const [migrateVipCount, setMigrateVipCount] = useState(35);
  const [migrateRewriteHost, setMigrateRewriteHost] = useState('');
  const [migrateFilterHost, setMigrateFilterHost] = useState('all');
  const [existingSummary, setExistingSummary] = useState({ totalUnassigned: 0, hosts: [], firstChannelUrl: '' });
  const [pastedAstra, setPastedAstra] = useState('');
  const [discoveredList, setDiscoveredList] = useState([]);
  const [importDefaultMode, setImportDefaultMode] = useState('ondemand');
  const [scanningAstra, setScanningAstra] = useState(false);

  // Stream Table Filters & Multi-Select
  const [search, setSearch] = useState('');
  const [modeFilter, setModeFilter] = useState('all'); // 'all' | 'vip_247' | 'ondemand' | 'copy_audio' | 'awake'
  const [selectedStreamIds, setSelectedStreamIds] = useState([]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0] || null;

  const loadData = async (keepForm = true) => {
    try {
      const [ndList, summary] = await Promise.all([
        apiFetch('/api/headend/nodes'),
        apiFetch('/api/headend/existing-summary')
      ]);
      setNodes(ndList);
      setExistingSummary(summary || { totalUnassigned: 0, hosts: [], firstChannelUrl: '' });
      setTotalCloudStreams(summary?.totalUnassigned || 0);

      const activeId =
        selectedNodeId && ndList.some((n) => n.id === selectedNodeId)
          ? selectedNodeId
          : ndList[0]?.id || null;

      if (activeId !== selectedNodeId) setSelectedNodeId(activeId);

      if (activeId) {
        const curNode = ndList.find((n) => n.id === activeId);
        if (curNode && (!keepForm || !settingsForm || settingsForm.id !== curNode.id)) {
          setSettingsForm({
            id: curNode.id,
            name: curNode.name,
            public_url: curNode.public_url,
            astra_url: curNode.astra_url || 'http://127.0.0.1:8000',
            astra_auth: curNode.astra_auth || '',
            allowed_cloud_ip: curNode.allowed_cloud_ip || '',
            audio_leveling_enabled: Boolean(curNode.audio_leveling_enabled),
            audio_preset: curNode.audio_preset || 'standard',
            audio_bitrate: curNode.audio_bitrate || '128k',
            auto_resolution: Boolean(curNode.auto_resolution),
            sd_kbps: curNode.sd_kbps || 1000,
            hd_kbps: curNode.hd_kbps || 2500,
            fhd_kbps: curNode.fhd_kbps || 3000,
            auto_deinterlace: Boolean(curNode.auto_deinterlace)
          });
        }
        if (Array.isArray(curNode?.last_astra_scan) && curNode.last_astra_scan.length > 0 && discoveredList.length === 0) {
          setDiscoveredList(curNode.last_astra_scan);
        }
        const stRows = await apiFetch(`/api/headend/nodes/${activeId}/streams`);
        setNodeStreams(stRows);
      } else {
        setNodeStreams([]);
        setSettingsForm(null);
      }
    } catch {
      // ignore transient poll error
    }
  };

  useEffect(() => {
    loadData(false);
    const timer = setInterval(() => loadData(true), 4000);
    return () => clearInterval(timer);
  }, [selectedNodeId]);

  const showToast = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 6000);
  };

  const handleCreateNode = async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/headend/nodes', {
        method: 'POST',
        body: JSON.stringify(createForm)
      });
      setCreateOpen(false);
      if (res?.node) {
        setSelectedNodeId(res.node.id);
        setSettingsForm(null);
      }
      await loadData(false);
      showToast('✅ Nodo Cabecera registrado. Copia el comando SSH de 1 línea para instalarlo en tu HP ProLiant G9.');
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleSaveNodeSettings = async (e) => {
    if (e) e.preventDefault();
    if (!selectedNode || !settingsForm) return;
    setSavingSettings(true);
    try {
      await apiFetch(`/api/headend/nodes/${selectedNode.id}`, {
        method: 'PUT',
        body: JSON.stringify(settingsForm)
      });
      await loadData(true);
      showToast('✅ Configuración enviada al Nodo ProLiant (se aplica automáticamente en el próximo latido de 5s).');
    } catch (err) {
      window.alert(err.message);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleDeleteNode = async () => {
    if (!selectedNode) return;
    if (
      !window.confirm(
        `¿Desvincular y eliminar el nodo "${selectedNode.name}"? Los canales conservarán su URL original de Astra.`
      )
    ) {
      return;
    }
    await apiFetch(`/api/headend/nodes/${selectedNode.id}`, { method: 'DELETE' });
    setSelectedNodeId(null);
    setSettingsForm(null);
    await loadData(false);
  };

  const handleChangeStreamMode = async (ids, headend_mode, scope = 'selected') => {
    if (!selectedNode) return;
    try {
      const res = await apiFetch(`/api/headend/nodes/${selectedNode.id}/streams-mode`, {
        method: 'POST',
        body: JSON.stringify({ ids, scope, headend_mode })
      });
      await loadData(true);
      showToast(`✅ ${res.updatedCount} canal(es) actualizados a modo ${headend_mode.toUpperCase()} en el ProLiant.`);
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleDiscoverFromProliantLan = async () => {
    if (!selectedNode) return;
    setScanningAstra(true);
    try {
      const res = await apiFetch(`/api/headend/nodes/${selectedNode.id}/discover-astra`, {
        method: 'POST',
        body: JSON.stringify({
          astra_url: settingsForm?.astra_url || selectedNode.astra_url,
          astra_auth: settingsForm?.astra_auth || selectedNode.astra_auth
        })
      });
      if (Array.isArray(res.channels) && res.channels.length > 0) {
        setDiscoveredList(res.channels);
        showToast(`📡 ${res.channels.length} canales detectados en tu Cesbo Astra local.`);
      } else {
        showToast(res.message || 'Orden enviada al ProLiant; esperando respuesta de tu Astra local...');
      }
    } catch (err) {
      window.alert(err.message);
    } finally {
      setScanningAstra(false);
    }
  };

  const handleParsePastedAstra = async () => {
    try {
      const res = await apiFetch('/api/headend/parse-astra-text', {
        method: 'POST',
        body: JSON.stringify({
          content: pastedAstra,
          astra_url: settingsForm?.astra_url || 'http://127.0.0.1:8000'
        })
      });
      setDiscoveredList(res.channels || []);
      if ((res.channels || []).length === 0) {
        window.alert('No se detectaron canales en el texto pegado. Verifica que sea M3U o JSON/Conf de Astra.');
      }
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleCommitAstraImport = async () => {
    if (!selectedNode || discoveredList.length === 0) return;
    try {
      const res = await apiFetch(`/api/headend/nodes/${selectedNode.id}/import-astra`, {
        method: 'POST',
        body: JSON.stringify({
          channels: discoveredList,
          default_headend_mode: importDefaultMode
        })
      });
      setImportOpen(false);
      setDiscoveredList([]);
      setPastedAstra('');
      await loadData(true);
      showToast(
        `✅ ${res.importedCount} canales de Cesbo Astra importados y enlazados ProLiant ↔ Nube (1 flujo por canal).`
      );
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleMigrateExistingCloudStreams = async (limitCount = 0) => {
    if (!selectedNode) return;
    if (selectedNode.status !== 'online') {
      const ok = window.confirm(
        '⚠️ Tu Nodo ProLiant aún aparece desconectado (no has ejecutado el comando SSH en el ProLiant).\n\n¿Seguro que deseas migrar los canales antes de encender el agente?'
      );
      if (!ok) return;
    }
    try {
      const res = await apiFetch(`/api/headend/nodes/${selectedNode.id}/attach-existing`, {
        method: 'POST',
        body: JSON.stringify({
          default_headend_mode: 'ondemand',
          vip_top_count: Number(migrateVipCount) || 0,
          rewrite_host_to_local: migrateRewriteHost,
          filter_hostname: migrateFilterHost,
          limit_count: limitCount
        })
      });
      setImportOpen(false);
      await loadData(true);
      showToast(
        `✅ ${res.migratedCount} canal(es) vinculados al Nodo ProLiant conservando IDs, logos, EPG, puertos originales y orden de parrilla.`
      );
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleDetachStreams = async (ids, scope = 'selected') => {
    if (!selectedNode) return;
    try {
      const res = await apiFetch(`/api/headend/nodes/${selectedNode.id}/detach-streams`, {
        method: 'POST',
        body: JSON.stringify({ ids, scope })
      });
      setSelectedStreamIds([]);
      await loadData(true);
      showToast(`↩️ ${res.detachedCount} canal(es) regresados a su URL Pública original en la Nube.`);
    } catch (err) {
      window.alert(err.message);
    }
  };

  const previewRewrittenUrl = (sampleUrl, rewriteInput) => {
    if (!sampleUrl) return '';
    const raw = String(rewriteInput || '').trim();
    if (!raw) return sampleUrl;
    try {
      const oldU = new URL(sampleUrl);
      const newU = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
      oldU.protocol = newU.protocol;
      if (newU.port) {
        oldU.host = newU.host;
      } else {
        oldU.hostname = newU.hostname;
      }
      return oldU.toString();
    } catch {
      return sampleUrl;
    }
  };

  const buildInstallCommand = () => {
    if (!selectedNode) return '';
    let port = 8097;
    try {
      const u = new URL(selectedNode.public_url);
      if (u.port) port = Number(u.port);
    } catch {
      // default 8097
    }
    const cloudOrigin = window.location.origin;
    return `curl -fsSL "${cloudOrigin}/api/headend/install.sh?token=${selectedNode.api_token}&port=${port}" | sudo bash`;
  };

  const filteredStreams = nodeStreams.filter((s) => {
    const matchText =
      !search.trim() ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      String(s.astra_local_url || '').toLowerCase().includes(search.toLowerCase());
    if (!matchText) return false;
    if (modeFilter === 'awake') return Boolean(s.liveHeadend?.running);
    if (modeFilter !== 'all') return s.headend_mode === modeFilter;
    return true;
  });

  const freeGhz = selectedNode
    ? Math.max(0, Number(((selectedNode.cpu_total_ghz || 0) - (selectedNode.cpu_used_ghz || 0)).toFixed(2)))
    : 0;
  const freeRamGb = selectedNode
    ? Math.max(0, Number(((selectedNode.ram_total_gb || 0) - (selectedNode.ram_used_gb || 0)).toFixed(2)))
    : 0;
  const sleepingCount = selectedNode
    ? Math.max(0, (selectedNode.assigned_streams_count || 0) - (selectedNode.active_workers || 0))
    : 0;

  return (
    <div className="space-y-5">
      {/* Top Header & Node Selector */}
      <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-bold text-white flex items-center gap-2">
            <Cpu className="w-5 h-5 text-cyan-400" />
            Nodo Cabecera Remoto (Cesbo Astra / Transcoder ProLiant)
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Nivela audio, desentrelaza 1080i y comprime a 1M / 2.5M / 3M localmente en tu HP ProLiant antes de subir 1 solo flujo limpio a la Nube
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {nodes.length > 0 && (
            <select
              value={selectedNode?.id || ''}
              onChange={(e) => {
                setSelectedNodeId(Number(e.target.value));
                setSettingsForm(null);
              }}
              className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white font-semibold"
            >
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.status === 'online' ? '🟢' : '🔴'} {n.name} ({n.assigned_streams_count} canales)
                </option>
              ))}
            </select>
          )}

          {selectedNode && (
            <button
              onClick={() => setImportOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-lg shadow-emerald-950/50"
            >
              <Upload className="w-4 h-4" />
              Cargar / Migrar Canales Astra
            </button>
          )}

          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition"
          >
            <Plus className="w-4 h-4" />
            Registrar Nodo ProLiant
          </button>
        </div>
      </div>

      {notice && (
        <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-200 font-medium">
          {notice}
        </div>
      )}

      {!selectedNode ? (
        <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-10 text-center space-y-4">
          <Server className="w-12 h-12 text-cyan-400 mx-auto opacity-80" />
          <div className="space-y-1 max-w-xl mx-auto">
            <h2 className="text-sm font-bold text-white">
              Conecta tu HP ProLiant G9 (con Cesbo Astra local) a tu Panel en la Nube
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Crea una VM Ubuntu 22.04 en tu HP ProLiant G9 (22 vCPUs, 16 GB RAM, 40 GB Disco), regístrala aquí con su IP Pública + puerto (ej. <code className="text-cyan-300">IP_PUBLICA:8097</code>) y ejecuta el comando de 1 línea que te daremos.
            </p>
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold"
          >
            <Plus className="w-4 h-4" />
            Registrar Mi HP ProLiant G9 Ahora
          </button>
        </div>
      ) : (
        <>
          {/* 1-Line SSH Installer Box */}
          <div className="rounded-2xl bg-[#0e1526] border border-indigo-500/35 p-4 space-y-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`px-2.5 py-0.5 rounded-full font-bold text-[10px] ${
                    selectedNode.status === 'online'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  }`}
                >
                  {selectedNode.status === 'online'
                    ? `● EN LÍNEA (${selectedNode.hostname || 'ProLiant'})`
                    : '● ESPERANDO CONEXIÓN DEL AGENTE'}
                </span>
                <span className="text-slate-300 font-semibold">
                  Comando SSH de Instalación (Ubuntu 22.04 en tu HP ProLiant G9 — Cero apt):
                </span>
              </div>
              <button
                onClick={handleDeleteNode}
                className="text-[11px] text-rose-400 hover:text-rose-300 inline-flex items-center gap-1 self-end sm:self-auto"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Desvincular Nodo
              </button>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <pre className="flex-1 px-3.5 py-2.5 rounded-xl bg-[#070b13] border border-slate-800 text-[11px] font-mono text-cyan-300 overflow-x-auto">
                {buildInstallCommand()}
              </pre>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(buildInstallCommand());
                  setCopiedCmd(true);
                  setTimeout(() => setCopiedCmd(false), 2000);
                }}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shrink-0"
              >
                {copiedCmd ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copiedCmd ? 'Copiado' : 'Copiar Comando SSH'}
              </button>
            </div>
          </div>

          {/* ESXi-Style Live ProLiant Telemetry Gauges (Idea 1 + Idea 2) */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {/* CPU GHz Card */}
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-300">CPU PROLIANT</span>
                <span className="font-mono text-emerald-300 font-semibold">
                  LIBRE: {freeGhz} GHz
                </span>
              </div>
              <div className="w-full h-3 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-lime-400 to-emerald-500 transition-all duration-500"
                  style={{ width: `${Math.min(100, selectedNode.cpu_usage_pct || 0)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                <span>USADO: {selectedNode.cpu_used_ghz || 0} GHz ({selectedNode.cpu_usage_pct || 0}%)</span>
                <span>CAP: {selectedNode.cpu_total_ghz || 0} GHz ({selectedNode.cpu_cores || 0}c)</span>
              </div>
            </div>

            {/* RAM + RAMDisk Card */}
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-300">MEMORIA RAM</span>
                <span className="font-mono text-cyan-300 font-semibold">
                  LIBRE: {freeRamGb} GB
                </span>
              </div>
              <div className="w-full h-3 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-sky-400 transition-all duration-500"
                  style={{ width: `${Math.min(100, selectedNode.ram_usage_pct || 0)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                <span>USADO: {selectedNode.ram_used_gb || 0} GB ({selectedNode.ram_usage_pct || 0}%)</span>
                <span className="text-emerald-300 font-bold">
                  {selectedNode.hls_ramdisk ? '⚡ RAMDisk ON' : `CAP: ${selectedNode.ram_total_gb || 0} GB`}
                </span>
              </div>
            </div>

            {/* Upload ProLiant -> Cloud */}
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-300 flex items-center gap-1.5">
                  <Wifi className="w-3.5 h-3.5 text-indigo-400" />
                  SUBIDA PROLIANT → NUBE
                </span>
                <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono text-[10px] font-bold">
                  1 FLUJO / CANAL
                </span>
              </div>
              <div className="text-2xl font-extrabold text-white font-mono">
                {selectedNode.upload_mbps || 0} <span className="text-xs text-slate-400 font-normal">Mbps</span>
              </div>
              <div className="text-[11px] text-slate-400">
                La Nube multiplica cada canal a 300+ clientes con 0% CPU extra
              </div>
            </div>

            {/* Hybrid VIP 24/7 vs On-Demand Savings */}
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-4 space-y-2">
              <div className="text-xs font-bold text-slate-300">ESTADO HÍBRIDO (200+ CANALES)</div>
              <div className="grid grid-cols-3 gap-1.5 text-center pt-0.5">
                <div className="p-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30">
                  <div className="font-mono font-bold text-sm text-amber-300">{selectedNode.vip_count || 0}</div>
                  <div className="text-[9px] text-amber-200/80 font-semibold">VIP 24/7</div>
                </div>
                <div className="p-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30">
                  <div className="font-mono font-bold text-sm text-emerald-300">
                    {selectedNode.ondemand_awake_count || 0}
                  </div>
                  <div className="text-[9px] text-emerald-200/80 font-semibold">ON-DEMAND ON</div>
                </div>
                <div className="p-1.5 rounded-lg bg-slate-800/90 border border-slate-700">
                  <div className="font-mono font-bold text-sm text-slate-300">{sleepingCount}</div>
                  <div className="text-[9px] text-slate-400 font-semibold">DORMIDOS 0M</div>
                </div>
              </div>
            </div>
          </div>

          {/* Remote Control Panel (Idea 1 + Idea 3: Auto-Res 1M/2.5M/3M + Audio Igual + Astra Deinterlace) */}
          {settingsForm && (
            <form
              onSubmit={handleSaveNodeSettings}
              className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" />
                  Control Remoto en Vivo del Nodo ProLiant + Modo Especial Cesbo Astra
                </h2>
                <button
                  type="submit"
                  disabled={savingSettings}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold transition"
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingSettings ? 'Enviando al ProLiant...' : 'Guardar y Enviar al ProLiant'}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Auto Resolution on ProLiant */}
                <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2.5">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                      <Monitor className="w-4 h-4" />
                      Auto-Resolución (1M / 2.5M / 3M)
                    </span>
                    <input
                      type="checkbox"
                      checked={settingsForm.auto_resolution}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, auto_resolution: e.target.checked })
                      }
                      className="rounded accent-emerald-500"
                    />
                  </label>
                  <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div>
                      <span className="text-slate-400 block mb-0.5">SD/540p</span>
                      <input
                        type="number"
                        value={settingsForm.sd_kbps}
                        onChange={(e) =>
                          setSettingsForm({ ...settingsForm, sd_kbps: Number(e.target.value) })
                        }
                        className="w-full px-2 py-1 rounded bg-[#0e1526] border border-slate-700 text-white font-mono"
                      />
                    </div>
                    <div>
                      <span className="text-slate-400 block mb-0.5">HD 720p</span>
                      <input
                        type="number"
                        value={settingsForm.hd_kbps}
                        onChange={(e) =>
                          setSettingsForm({ ...settingsForm, hd_kbps: Number(e.target.value) })
                        }
                        className="w-full px-2 py-1 rounded bg-[#0e1526] border border-slate-700 text-white font-mono"
                      />
                    </div>
                    <div>
                      <span className="text-slate-400 block mb-0.5">FHD 1080p</span>
                      <input
                        type="number"
                        value={settingsForm.fhd_kbps}
                        onChange={(e) =>
                          setSettingsForm({ ...settingsForm, fhd_kbps: Number(e.target.value) })
                        }
                        className="w-full px-2 py-1 rounded bg-[#0e1526] border border-slate-700 text-white font-mono"
                      />
                    </div>
                  </div>
                </div>

                {/* Audio Leveling on ProLiant */}
                <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2.5">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                      <Volume2 className="w-4 h-4" />
                      Audio Igual (MP2/AC3 → AAC 48k)
                    </span>
                    <input
                      type="checkbox"
                      checked={settingsForm.audio_leveling_enabled}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          audio_leveling_enabled: e.target.checked
                        })
                      }
                      className="rounded accent-amber-400"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <select
                      value={settingsForm.audio_preset}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, audio_preset: e.target.value })
                      }
                      className="px-2 py-1.5 rounded bg-[#0e1526] border border-slate-700 text-white text-[11px]"
                    >
                      <option value="standard">Estándar TV (-13dB)</option>
                      <option value="voice">Voz & Deportes</option>
                      <option value="cinema">Suave Cine</option>
                    </select>
                    <select
                      value={settingsForm.audio_bitrate}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, audio_bitrate: e.target.value })
                      }
                      className="px-2 py-1.5 rounded bg-[#0e1526] border border-slate-700 text-white text-[11px]"
                    >
                      <option value="96k">96k AAC</option>
                      <option value="128k">128k AAC</option>
                      <option value="160k">160k AAC</option>
                    </select>
                  </div>
                </div>

                {/* Cesbo Astra Special Deinterlacer & Local LAN Link */}
                <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2.5">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-xs font-bold text-cyan-300">
                      📺 Anti-Rayas Astra (1080i → Progresivo)
                    </span>
                    <input
                      type="checkbox"
                      checked={settingsForm.auto_deinterlace}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, auto_deinterlace: e.target.checked })
                      }
                      className="rounded accent-cyan-400"
                    />
                  </label>
                  <div className="grid grid-cols-1 gap-1.5 text-[11px]">
                    <input
                      type="text"
                      value={settingsForm.astra_url}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, astra_url: e.target.value })
                      }
                      placeholder="URL Interna Astra (ej. http://192.168.1.50:8000)"
                      className="w-full px-2.5 py-1 rounded bg-[#0e1526] border border-slate-700 text-white font-mono"
                    />
                  </div>
                </div>
              </div>
            </form>
          )}

          {/* Headend Streams Table (VIP 24/7 vs Remote On-Demand) */}
          <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 space-y-4">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar canal o IP local Astra..."
                  className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white min-w-[220px]"
                />
                <select
                  value={modeFilter}
                  onChange={(e) => setModeFilter(e.target.value)}
                  className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-slate-200"
                >
                  <option value="all">Todos en ProLiant ({nodeStreams.length})</option>
                  <option value="vip_247">🔥 Fijos VIP 24/7</option>
                  <option value="ondemand">🌱 On-Demand Remoto (Ahorro Subida)</option>
                  <option value="copy_audio">⚡ Copy Video + Audio Igual</option>
                  <option value="awake">🟢 Transmitiendo en este instante</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  disabled={selectedStreamIds.length === 0}
                  onClick={() => handleChangeStreamMode(selectedStreamIds, 'vip_247')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 text-amber-200 border border-amber-500/35 font-semibold"
                >
                  <Flame className="w-3.5 h-3.5 text-amber-400" />
                  Marcar VIP 24/7 ({selectedStreamIds.length})
                </button>
                <button
                  type="button"
                  disabled={selectedStreamIds.length === 0}
                  onClick={() => handleChangeStreamMode(selectedStreamIds, 'ondemand')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-40 text-emerald-200 border border-emerald-500/35 font-semibold"
                >
                  <Leaf className="w-3.5 h-3.5 text-emerald-400" />
                  Pasar a On-Demand ({selectedStreamIds.length})
                </button>
                <button
                  type="button"
                  disabled={selectedStreamIds.length === 0}
                  onClick={() => handleChangeStreamMode(selectedStreamIds, 'copy_audio')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-40 text-cyan-200 border border-cyan-500/35 font-semibold"
                >
                  <Zap className="w-3.5 h-3.5 text-cyan-400" />
                  Copy Video + Audio Igual ({selectedStreamIds.length})
                </button>
                <button
                  type="button"
                  disabled={selectedStreamIds.length === 0}
                  onClick={() => handleDetachStreams(selectedStreamIds, 'selected')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-600 font-semibold"
                  title="Desvincula del ProLiant y restaura su URL pública original intacta"
                >
                  ↩️ Regresar a Pública ({selectedStreamIds.length})
                </button>
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#090e1a] text-slate-400 uppercase">
                  <tr>
                    <th className="px-3 py-2.5 w-10">
                      <input
                        type="checkbox"
                        checked={
                          filteredStreams.length > 0 &&
                          filteredStreams.every((s) => selectedStreamIds.includes(s.id))
                        }
                        onChange={() => {
                          const fIds = filteredStreams.map((s) => s.id);
                          const allIn = fIds.every((id) => selectedStreamIds.includes(id));
                          setSelectedStreamIds((prev) =>
                            allIn ? prev.filter((id) => !fIds.includes(id)) : Array.from(new Set([...prev, ...fIds]))
                          );
                        }}
                        className="rounded accent-indigo-500"
                      />
                    </th>
                    <th className="px-3 py-2.5">#</th>
                    <th className="px-3 py-2.5">Canal</th>
                    <th className="px-3 py-2.5">Entrada Local Cesbo Astra</th>
                    <th className="px-3 py-2.5">Modo Subida</th>
                    <th className="px-3 py-2.5">Señal Detectada en ProLiant</th>
                    <th className="px-3 py-2.5">Estado ProLiant</th>
                    <th className="px-3 py-2.5 text-right">Ver</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredStreams.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                        Aún no hay canales asignados a este Nodo ProLiant. Usa el botón verde &laquo;Cargar / Migrar Canales Astra&raquo;.
                      </td>
                    </tr>
                  ) : (
                    filteredStreams.map((s, idx) => {
                      const live = s.liveHeadend || {};
                      const isVip = s.headend_mode === 'vip_247';
                      return (
                        <tr key={s.id} className="hover:bg-slate-800/30">
                          <td className="px-3 py-2.5">
                            <input
                              type="checkbox"
                              checked={selectedStreamIds.includes(s.id)}
                              onChange={() =>
                                setSelectedStreamIds((prev) =>
                                  prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]
                                )
                              }
                              className="rounded accent-indigo-500"
                            />
                          </td>
                          <td className="px-3 py-2.5 font-mono text-sky-300 font-bold">#{idx + 1}</td>
                          <td className="px-3 py-2.5">
                            <div className="font-semibold text-white">{s.name}</div>
                            <div className="text-[10px] text-slate-500">{s.category_name || 'Astra'}</div>
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-slate-300 max-w-[230px] truncate">
                            {s.astra_local_url}
                          </td>
                          <td className="px-3 py-2.5">
                            <select
                              value={s.headend_mode || 'ondemand'}
                              onChange={(e) => handleChangeStreamMode([s.id], e.target.value)}
                              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border ${
                                isVip
                                  ? 'bg-amber-500/15 text-amber-200 border-amber-500/40'
                                  : s.headend_mode === 'copy_audio'
                                  ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40'
                                  : 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40'
                              }`}
                            >
                              <option value="vip_247">🔥 VIP 24/7</option>
                              <option value="ondemand">🌱 On-Demand</option>
                              <option value="copy_audio">⚡ Copy+Audio</option>
                            </select>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap items-center gap-1">
                              {(live.resolution || s.detected_resolution) ? (
                                <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono text-[10px] font-bold">
                                  {live.resolution || s.detected_resolution} → {live.effectiveKbps || s.bitrate_kbps}k
                                </span>
                              ) : (
                                <span className="text-[10px] text-slate-500">Se mide al abrir</span>
                              )}
                              {Boolean(live.interlaced || s.headend_interlaced) && (
                                <span className="px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200 font-mono text-[9px] font-bold">
                                  1080i→YADIF
                                </span>
                              )}
                              {(live.audioIn || s.headend_audio_in) && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-200 font-mono text-[9px] font-bold uppercase">
                                  {live.audioIn || s.headend_audio_in}→AAC
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            {live.running ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/35 text-[10px] font-bold">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                SUBIENDO (PID {live.pid})
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-400 text-[10px] font-semibold">
                                💤 AHORRO (0 Mbps)
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <button
                              onClick={() =>
                                onPreview &&
                                onPreview({
                                  id: s.id,
                                  kind: 'live',
                                  title: s.name,
                                  url: s.source_url
                                })
                              }
                              className="p-1.5 rounded-lg bg-indigo-600/25 hover:bg-indigo-600 text-indigo-300 hover:text-white transition"
                              title="Previsualizar señal nivelada desde la Nube"
                            >
                              <Play className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Modal: Register New Headend Node */}
      {createOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-[#0e1526] border border-indigo-500/40 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-white">Registrar Nodo Cabecera (HP ProLiant / Astra)</h3>
              <button onClick={() => setCreateOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateNode} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Nombre del Nodo</label>
                <input
                  type="text"
                  required
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  IP Pública y Puerto del VPS en tu HP ProLiant G9
                </label>
                <input
                  type="text"
                  required
                  value={createForm.public_url}
                  onChange={(e) => setCreateForm({ ...createForm, public_url: e.target.value })}
                  placeholder="ej. http://190.x.x.x:8097"
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  URL Interna Local de tu Cesbo Astra (LAN 10Gbps dentro del ProLiant)
                </label>
                <input
                  type="text"
                  value={createForm.astra_url}
                  onChange={(e) => setCreateForm({ ...createForm, astra_url: e.target.value })}
                  placeholder="ej. http://192.168.1.50:8000 o http://127.0.0.1:8000"
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-400 mb-1">Usuario:Clave Astra (Opcional)</label>
                  <input
                    type="text"
                    value={createForm.astra_auth}
                    onChange={(e) => setCreateForm({ ...createForm, astra_auth: e.target.value })}
                    placeholder="admin:admin"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Blindar solo para IP Nube (Opcional)</label>
                  <input
                    type="text"
                    value={createForm.allowed_cloud_ip}
                    onChange={(e) => setCreateForm({ ...createForm, allowed_cloud_ip: e.target.value })}
                    placeholder="ej. 69.30.212.194"
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 font-semibold"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold"
                >
                  Crear Nodo y Generar Instalador
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Migrate Existing / Scan Local Astra / Paste Astra M3U-JSON */}
      {importOpen && selectedNode && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-3xl rounded-2xl bg-[#0e1526] border border-emerald-500/40 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-white">
                Vincular o Importar Canales de Cesbo Astra → {selectedNode.name}
              </h3>
              <button onClick={() => setImportOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <button
                type="button"
                onClick={() => setImportTab('migrate')}
                className={`px-3.5 py-2 rounded-xl font-bold border ${
                  importTab === 'migrate'
                    ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/50'
                    : 'bg-[#090e1a] text-slate-400 border-slate-800'
                }`}
              >
                🔄 Migrar Mis Canales Actuales ({totalCloudStreams})
              </button>
              <button
                type="button"
                onClick={() => setImportTab('scan')}
                className={`px-3.5 py-2 rounded-xl font-bold border ${
                  importTab === 'scan'
                    ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/50'
                    : 'bg-[#090e1a] text-slate-400 border-slate-800'
                }`}
              >
                📡 Escanear Astra en LAN del ProLiant
              </button>
              <button
                type="button"
                onClick={() => setImportTab('paste')}
                className={`px-3.5 py-2 rounded-xl font-bold border ${
                  importTab === 'paste'
                    ? 'bg-indigo-500/20 text-indigo-200 border-indigo-400/50'
                    : 'bg-[#090e1a] text-slate-400 border-slate-800'
                }`}
              >
                📋 Pegar M3U / Config JSON de Astra
              </button>
            </div>

            {importTab === 'migrate' && (
              <div className="p-4 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3.5 text-xs">
                <p className="text-slate-300 leading-relaxed">
                  <strong>¡No importes canales nuevos ni los dupliques!</strong> Como tus{' '}
                  <strong>{totalCloudStreams} canales actuales</strong> ya son los mismos del Astra (saliendo por IP pública), este asistente los pasa al <strong>HP ProLiant</strong> cambiando automáticamente su IP pública por la IP interna LAN de tu Astra y <strong>conservando intactos cada puerto (:8000, :8001…), IDs de clientes, logos, EPG y tu orden #</strong>.
                </p>

                {existingSummary.hosts?.length > 0 && (
                  <div className="p-3 rounded-xl bg-[#0e1526] border border-cyan-500/30 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-bold text-cyan-300">
                        🔍 IP Pública detectada en tus canales actuales:
                      </span>
                      <select
                        value={migrateFilterHost}
                        onChange={(e) => setMigrateFilterHost(e.target.value)}
                        className="px-2.5 py-1 rounded-lg bg-[#070b13] border border-slate-700 text-[11px] text-white font-mono"
                      >
                        <option value="all">Todos los canales ({totalCloudStreams})</option>
                        {existingSummary.hosts.map((h) => (
                          <option key={h.hostname} value={h.hostname}>
                            Solo {h.hostname} ({h.count} canales{h.ports.length ? ` • :${h.ports.join(', :')}` : ''})
                          </option>
                        ))}
                      </select>
                    </div>
                    {existingSummary.firstChannelUrl && (
                      <div className="text-[11px] font-mono space-y-1 bg-[#070b13] p-2.5 rounded-lg border border-slate-800">
                        <div className="text-slate-400 truncate">
                          <span className="text-amber-300 font-bold">Antes (Pública): </span>
                          {existingSummary.firstChannelUrl}
                        </div>
                        <div className="text-emerald-300 truncate">
                          <span className="font-bold">Ahora en ProLiant: </span>
                          {previewRewrittenUrl(existingSummary.firstChannelUrl, migrateRewriteHost)}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 font-semibold mb-1">
                      IP Interna LAN de tu Astra dentro del ProLiant
                    </label>
                    <input
                      type="text"
                      value={migrateRewriteHost}
                      onChange={(e) => setMigrateRewriteHost(e.target.value)}
                      placeholder="ej. 192.168.1.50  (o 127.0.0.1 si es la misma VM)"
                      className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-emerald-500/40 text-white font-mono"
                    />
                    <span className="text-[10px] text-emerald-300/90">
                      Escribe solo la IP interna (sin puerto) para conservar los puertos :8000, :8001, etc. de cada canal.
                    </span>
                  </div>
                  <div>
                    <label className="block text-slate-300 font-semibold mb-1">
                      ¿Cuántos primeros canales dejar como 🔥 VIP 24/7?
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={300}
                      value={migrateVipCount}
                      onChange={(e) => setMigrateVipCount(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                    />
                    <span className="text-[10px] text-slate-400">
                      El resto quedará en 🌱 On-Demand Remoto (0 Mbps cuando nadie los mira).
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-800">
                  <button
                    type="button"
                    disabled={totalCloudStreams === 0}
                    onClick={() => handleMigrateExistingCloudStreams(1)}
                    className="px-4 py-2.5 rounded-xl bg-cyan-600/25 hover:bg-cyan-600/40 border border-cyan-400/40 disabled:opacity-40 text-cyan-200 font-bold"
                  >
                    🧪 Probar Primero con 1 Solo Canal Piloto
                  </button>
                  <button
                    type="button"
                    disabled={totalCloudStreams === 0}
                    onClick={() => handleMigrateExistingCloudStreams(0)}
                    className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold"
                  >
                    🚀 Migrar Todos ({totalCloudStreams}) al ProLiant
                  </button>
                </div>
              </div>
            )}

            {importTab === 'scan' && (
              <div className="p-4 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3 text-xs">
                <p className="text-slate-300">
                  El Agente instalado en tu ProLiant consultará internamente{' '}
                  <code className="text-cyan-300">{settingsForm?.astra_url || selectedNode.astra_url}</code> por la red local de 10 Gbps sin exponer Astra a internet.
                </p>
                <button
                  type="button"
                  disabled={scanningAstra}
                  onClick={handleDiscoverFromProliantLan}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold"
                >
                  <RefreshCw className={`w-4 h-4 ${scanningAstra ? 'animate-spin' : ''}`} />
                  {scanningAstra ? 'Escaneando Astra...' : 'Escanear Cesbo Astra Ahora'}
                </button>
              </div>
            )}

            {importTab === 'paste' && (
              <div className="space-y-2 text-xs">
                <textarea
                  rows={5}
                  value={pastedAstra}
                  onChange={(e) => setPastedAstra(e.target.value)}
                  placeholder="Pega aquí el contenido de http://IP_ASTRA:8000/playlist.m3u8 o tu archivo astra.conf / JSON..."
                  className="w-full p-3 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono text-[11px]"
                />
                <button
                  type="button"
                  onClick={handleParsePastedAstra}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold"
                >
                  Analizar Canales de Astra
                </button>
              </div>
            )}

            {discoveredList.length > 0 && importTab !== 'migrate' && (
              <div className="space-y-3 border-t border-slate-800 pt-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-emerald-300">
                    {discoveredList.length} canales de Astra listos para importar
                  </span>
                  <select
                    value={importDefaultMode}
                    onChange={(e) => setImportDefaultMode(e.target.value)}
                    className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="ondemand">Importar en 🌱 On-Demand Remoto (Recomendado 200 canales)</option>
                    <option value="vip_247">Importar todos en 🔥 VIP 24/7</option>
                    <option value="copy_audio">Importar en ⚡ Copy Video + Audio Igual</option>
                  </select>
                </div>
                <div className="max-h-48 overflow-y-auto rounded-xl bg-[#070b13] border border-slate-800 divide-y divide-slate-800/70">
                  {discoveredList.map((ch, i) => (
                    <div key={i} className="px-3 py-1.5 flex items-center justify-between text-[11px]">
                      <span className="text-white font-medium">{ch.name}</span>
                      <span className="text-slate-400 font-mono truncate max-w-[300px]">{ch.astra_local_url}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleCommitAstraImport}
                    className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                  >
                    Importar {discoveredList.length} Canales y Enlazar ProLiant ↔ Nube
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
