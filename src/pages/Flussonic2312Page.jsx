import React, { useEffect, useState } from 'react';
import {
  Zap,
  Plus,
  RefreshCw,
  Trash2,
  Play,
  Copy,
  Check,
  Download,
  Upload,
  Server,
  Radio,
  Volume2,
  FileCode,
  Send,
  Link2
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

export default function Flussonic2312Page({ onPreview }) {
  const [servers, setServers] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [totalPanelStreams, setTotalPanelStreams] = useState(0);
  const [liveStreams, setLiveStreams] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState('');

  // Tabs: 'live' | 'generator' | 'import_conf'
  const [activeSubTab, setActiveSubTab] = useState('live');
  const [search, setSearch] = useState('');

  // Create Server Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: 'Flussonic 23.12 — Cabecera Local',
    base_url: 'http://192.168.88.20:8080',
    username: 'admin',
    password: '',
    api_token: '',
    astra_url: 'http://192.168.88.10:8000',
    default_pull_protocol: 'mpegts',
    default_transcode_mode: 'copy_deint_aac'
  });

  // flussonic.conf v23.12 Generator & API Push State
  const [genSourceType, setGenSourceType] = useState('panel_streams'); // 'panel_streams' | 'astra_m3u'
  const [genAstraText, setGenAstraText] = useState('');
  const [genAstraOverrideHost, setGenAstraOverrideHost] = useState('192.168.88.10:8000');
  const [genTranscodeMode, setGenTranscodeMode] = useState('copy_deint_aac');
  const [genVideoKbps, setGenVideoKbps] = useState(2500);
  const [genAudioKbps, setGenAudioKbps] = useState(128);
  const [genConstant247, setGenConstant247] = useState(true);
  const [genIncludeHeader, setGenIncludeHeader] = useState(false);
  const [generatedConf, setGeneratedConf] = useState('');
  const [generatedCount, setGeneratedCount] = useState(0);
  const [copiedConf, setCopiedConf] = useState(false);
  const [pushingApi, setPushingApi] = useState(false);

  // Link to Panel State
  const [pullProtocol, setPullProtocol] = useState('mpegts');
  const [cloudLinkMode, setCloudLinkMode] = useState('constant_copy_247');
  const [pastedFlussConf, setPastedFlussConf] = useState('');
  const [linking, setLinking] = useState(false);

  const selectedServer = servers.find((s) => s.id === selectedId) || servers[0] || null;

  const showToast = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 6500);
  };

  const loadServers = async () => {
    try {
      const res = await apiFetch('/api/flussonic-2312/servers');
      const list = res.servers || [];
      setServers(list);
      setTotalPanelStreams(res.totalPanelStreams || 0);
      if (list.length > 0 && !selectedId) {
        setSelectedId(list[0].id);
      }
      if ((res.totalPanelStreams || 0) === 0) {
        setGenSourceType('astra_m3u');
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadServers();
  }, []);

  const handleCreateServer = async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/flussonic-2312/servers', {
        method: 'POST',
        body: JSON.stringify(createForm)
      });
      setCreateOpen(false);
      await loadServers();
      if (res.server?.id) setSelectedId(res.server.id);
      showToast(`✅ Servidor "${res.server.name}" (Flussonic 23.12) registrado.`);
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleDeleteServer = async () => {
    if (!selectedServer) return;
    if (!window.confirm(`¿Eliminar el servidor "${selectedServer.name}"? Los canales conservarán su URL original.`)) {
      return;
    }
    await apiFetch(`/api/flussonic-2312/servers/${selectedServer.id}`, { method: 'DELETE' });
    setSelectedId(null);
    setLiveStreams([]);
    await loadServers();
  };

  const handleSyncLive = async (srvOverride = null) => {
    const target = srvOverride || selectedServer;
    if (!target) return;
    setSyncing(true);
    try {
      const res = await apiFetch(`/api/flussonic-2312/servers/${target.id}/sync-live`, {
        method: 'POST'
      });
      setLiveStreams(res.streams || []);
      await loadServers();
      showToast(
        `📡 Flussonic v${res.server?.version || '23.12'} sincronizado: ${(res.streams || []).length} streams detectados en vivo.`
      );
    } catch (err) {
      window.alert(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleStreamAction = async (streamName, action) => {
    if (!selectedServer) return;
    if (action === 'delete' && !window.confirm(`¿Eliminar stream "${streamName}" en Flussonic 23.12?`)) return;
    try {
      await apiFetch(`/api/flussonic-2312/servers/${selectedServer.id}/stream-action`, {
        method: 'POST',
        body: JSON.stringify({ stream_name: streamName, action })
      });
      showToast(action === 'delete' ? `🗑️ Stream ${streamName} eliminado.` : `🔄 Stream ${streamName} reiniciado en Flussonic 23.12.`);
      await handleSyncLive();
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleUploadAstraFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const txt = await f.text();
      setGenAstraText(txt);
      setGenSourceType('astra_m3u');
      showToast(`📂 Archivo Astra "${f.name}" cargado listo para generar flussonic.conf v23.12.`);
    } finally {
      e.target.value = '';
    }
  };

  const handleGenerateConf = async () => {
    try {
      const res = await apiFetch('/api/flussonic-2312/generate-conf', {
        method: 'POST',
        body: JSON.stringify({
          source_type: genSourceType,
          astra_content: genAstraText,
          astra_url: selectedServer?.astra_url || 'http://192.168.88.10:8000',
          astra_override_host: genAstraOverrideHost,
          transcode_mode: genTranscodeMode,
          video_bitrate_kbps: genVideoKbps,
          audio_bitrate_kbps: genAudioKbps,
          constant_247: genConstant247,
          include_global_header: genIncludeHeader,
          edit_auth_user: selectedServer?.username || 'admin',
          edit_auth_pass: selectedServer?.password || 'admin'
        })
      });
      setGeneratedConf(res.confText || '');
      setGeneratedCount(res.channelCount || 0);
      showToast(`✅ flussonic.conf v23.12 generado para ${res.channelCount} canales (${genConstant247 ? '24/7 Constante' : 'On-Demand'}).`);
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleDownloadConf = () => {
    if (!generatedConf) return;
    const blob = new Blob([generatedConf], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flussonic.conf';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePushStreamsApi = async () => {
    if (!selectedServer) {
      window.alert('Primero registra y selecciona tu servidor Flussonic 23.12 arriba.');
      return;
    }
    setPushingApi(true);
    try {
      const res = await apiFetch(`/api/flussonic-2312/servers/${selectedServer.id}/push-streams`, {
        method: 'POST',
        body: JSON.stringify({
          source_type: genSourceType,
          astra_content: genAstraText,
          astra_override_host: genAstraOverrideHost,
          transcode_mode: genTranscodeMode,
          video_bitrate_kbps: genVideoKbps,
          audio_bitrate_kbps: genAudioKbps,
          constant_247: genConstant247
        })
      });
      showToast(`🚀 ${res.pushedCount}/${res.totalAttempted} canales creados/actualizados en vivo en Flussonic 23.12 vía API v3.`);
      await handleSyncLive();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setPushingApi(false);
    }
  };

  const handleLinkToPanel = async (useConfText = false) => {
    if (!selectedServer) {
      window.alert('Registra primero tu servidor Flussonic 23.12 para construir las URLs de salida.');
      return;
    }
    setLinking(true);
    try {
      const res = await apiFetch(`/api/flussonic-2312/servers/${selectedServer.id}/link-to-panel`, {
        method: 'POST',
        body: JSON.stringify({
          streams: !useConfText && liveStreams.length > 0 ? liveStreams : null,
          conf_text: useConfText ? pastedFlussConf : '',
          pull_protocol: pullProtocol,
          cloud_mode: cloudLinkMode,
          auto_categorize: true
        })
      });
      await loadServers();
      showToast(
        `✅ Flussonic 23.12 vinculado al Panel TVLister: ${res.updatedCount} canales existentes enlazados sin duplicar + ${res.insertedCount} nuevos (${cloudLinkMode === 'ondemand' ? 'On-Demand' : '24/7 Constante'}).`
      );
    } catch (err) {
      window.alert(err.message);
    } finally {
      setLinking(false);
    }
  };

  const filteredLive = liveStreams.filter((st) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      String(st.name || '').toLowerCase().includes(q) ||
      String(st.title || '').toLowerCase().includes(q) ||
      String(st.input_url || '').toLowerCase().includes(q)
    );
  });

  const tel = selectedServer?.telemetry || {};

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-2xl bg-gradient-to-r from-[#121a30] via-[#151e38] to-[#0f172a] border border-violet-500/30 p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-violet-500/15 border border-violet-500/30 text-violet-300 text-[11px] font-bold">
            <Zap className="w-3.5 h-3.5" />
            MÓDULO NATIVO FLUSSONIC MEDIA SERVER v23.12 · REST API v3 + GENERADOR CESBO ASTRA
          </div>
          <h1 className="text-xl font-bold text-white">
            Flussonic 23.12 — Control API v3, Anti-Rayas, Audio AAC &amp; Enlace 24/7 Constante
          </h1>
          <p className="text-xs text-slate-300 max-w-3xl leading-relaxed">
            Conecta tu servidor <strong>Flussonic v23.12</strong>, genera o empuja por API v3 todos tus canales de{' '}
            <code className="text-cyan-300">Cesbo Astra (192.168.88.10:8000)</code> usando{' '}
            <code className="text-violet-300">tshttp://</code> en modo <strong>24/7 estático</strong> con{' '}
            <code className="text-emerald-300">deinterlace=true</code> + audio AAC, y vincúlalos a la Nube en{' '}
            <strong>24/7 Constante Copy/Copy</strong> sin duplicar canales.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {servers.map((srv) => (
            <button
              key={srv.id}
              onClick={() => setSelectedId(srv.id)}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition ${
                selectedServer?.id === srv.id
                  ? 'bg-violet-600 text-white border-violet-400'
                  : 'bg-[#0b1120] text-slate-300 border-slate-700 hover:border-slate-500'
              }`}
            >
              {srv.name} (v{srv.version || '23.12'})
            </button>
          ))}
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition"
          >
            <Plus className="w-4 h-4" />
            Agregar Flussonic 23.12
          </button>
        </div>
      </div>

      {notice && (
        <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-200 font-medium">
          {notice}
        </div>
      )}

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveSubTab('live')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border transition ${
              activeSubTab === 'live'
                ? 'bg-violet-600 text-white border-violet-400'
                : 'bg-[#0e1526] text-slate-300 border-slate-800 hover:border-slate-600'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            1. Monitor API v3 &amp; Vincular a Panel 24/7
          </button>
          <button
            onClick={() => setActiveSubTab('generator')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border transition ${
              activeSubTab === 'generator'
                ? 'bg-cyan-600 text-white border-cyan-400'
                : 'bg-[#0e1526] text-slate-300 border-slate-800 hover:border-slate-600'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" />
            2. Generador flussonic.conf v23.12 (Cesbo Astra → Flussonic)
          </button>
          <button
            onClick={() => setActiveSubTab('import_conf')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border transition ${
              activeSubTab === 'import_conf'
                ? 'bg-emerald-600 text-white border-emerald-400'
                : 'bg-[#0e1526] text-slate-300 border-slate-800 hover:border-slate-600'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            3. Importar /etc/flussonic/flussonic.conf Existente
          </button>
        </div>

        {selectedServer && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSyncLive()}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Consultando API v3...' : 'Sincronizar API v3 en Vivo'}
            </button>
            <button
              onClick={handleDeleteServer}
              className="p-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30"
              title="Desvincular servidor Flussonic"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* TAB 1: LIVE MONITOR & 1-CLICK LINK TO PANEL */}
      {activeSubTab === 'live' && (
        <>
          {!selectedServer ? (
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-10 text-center space-y-4">
              <Server className="w-12 h-12 text-violet-400 mx-auto opacity-85" />
              <div className="max-w-xl mx-auto space-y-1">
                <h2 className="text-sm font-bold text-white">
                  Conecta tu Servidor Flussonic Media Server v23.12
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Ingresa la IP/puerto de tu Flussonic 23.12 (ej. <code className="text-violet-300">http://IP_FLUSSONIC:8080</code>) y tus credenciales{' '}
                  <code className="text-violet-300">edit_auth</code> para leer todos tus canales en tiempo real, ver bitrates, empujar tus 140 canales de Cesbo Astra o enlazarlos 24/7 constantes al panel.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                <button
                  onClick={() => setCreateOpen(true)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold"
                >
                  <Plus className="w-4 h-4" />
                  Registrar Servidor Flussonic 23.12
                </button>
                <button
                  onClick={() => setActiveSubTab('generator')}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700"
                >
                  <FileCode className="w-4 h-4 text-cyan-400" />
                  Generar flussonic.conf v23.12 sin conectar aún
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Telemetry Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="p-4 rounded-2xl bg-[#0e1526] border border-slate-800">
                  <div className="text-[11px] text-slate-400">Servidor Flussonic</div>
                  <div className="text-base font-bold text-white mt-0.5 truncate">{selectedServer.base_url}</div>
                  <div className="text-[11px] text-violet-300 font-mono mt-1">
                    Versión v{selectedServer.version || '23.12'} · {selectedServer.status === 'online' ? '🟢 EN LÍNEA' : '⚪ SIN SONDEAR'}
                  </div>
                </div>
                <div className="p-4 rounded-2xl bg-[#0e1526] border border-slate-800">
                  <div className="text-[11px] text-slate-400">Streams Online / Total</div>
                  <div className="text-xl font-bold text-emerald-300 font-mono mt-0.5">
                    {tel.alive_streams ?? 0} / {tel.total_streams ?? liveStreams.length}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    Estáticos 24/7: <strong className="text-white">{tel.static_247_streams ?? 0}</strong>
                  </div>
                </div>
                <div className="p-4 rounded-2xl bg-[#0e1526] border border-slate-800">
                  <div className="text-[11px] text-slate-400">Tráfico Total Flussonic</div>
                  <div className="text-xl font-bold text-cyan-300 font-mono mt-0.5">{tel.total_mbps ?? 0} Mbps</div>
                  <div className="text-[11px] text-slate-400 mt-1">Clientes activos: {tel.total_clients ?? 0}</div>
                </div>
                <div className="p-4 rounded-2xl bg-[#0e1526] border border-slate-800">
                  <div className="text-[11px] text-slate-400">Enlazados en Panel TVLister</div>
                  <div className="text-xl font-bold text-indigo-300 font-mono mt-0.5">
                    {selectedServer.linked_streams_count || 0}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">Cero duplicados (/play/id)</div>
                </div>
                <div className="p-4 rounded-2xl bg-[#0e1526] border border-violet-500/30 space-y-2">
                  <div className="text-[11px] text-violet-200 font-bold">Enlazar a TVLister Nube (24/7):</div>
                  <select
                    value={cloudLinkMode}
                    onChange={(e) => setCloudLinkMode(e.target.value)}
                    className="w-full px-2 py-1 rounded-lg bg-[#090e1a] border border-slate-700 text-[11px] text-white"
                  >
                    <option value="constant_copy_247">⚡ 24/7 Constante Copy/Copy (0% CPU)</option>
                    <option value="constant_copy_audio_247">🔊 24/7 Copy Video + Nivelador Audio</option>
                    <option value="ondemand">🌱 On-Demand</option>
                  </select>
                  <button
                    onClick={() => handleLinkToPanel(false)}
                    disabled={linking}
                    className="w-full py-1.5 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-bold flex items-center justify-center gap-1"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    {linking ? 'Vinculando...' : 'Vincular Todo al Panel 24/7'}
                  </button>
                </div>
              </div>

              {/* Streams Table from Flussonic 23.12 API v3 */}
              <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar stream en Flussonic 23.12 (nombre, título o input Astra)..."
                    className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white min-w-[260px]"
                  />
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-slate-400">Protocolo Pull hacia Nube:</span>
                    <select
                      value={pullProtocol}
                      onChange={(e) => setPullProtocol(e.target.value)}
                      className="px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-slate-700 text-white text-xs"
                    >
                      <option value="mpegts">HTTP MPEG-TS (/nombre/mpegts — 24/7 baja latencia)</option>
                      <option value="hls">HLS (/nombre/index.m3u8)</option>
                    </select>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#090e1a] text-slate-400 uppercase">
                      <tr>
                        <th className="px-3 py-2.5">Key Flussonic</th>
                        <th className="px-3 py-2.5">Canal</th>
                        <th className="px-3 py-2.5">Entrada (Astra / Upstream)</th>
                        <th className="px-3 py-2.5">Modo</th>
                        <th className="px-3 py-2.5">Codec / Bitrate</th>
                        <th className="px-3 py-2.5 text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {filteredLive.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                            Pulsa &laquo;Sincronizar API v3 en Vivo&raquo; arriba para listar tus streams de Flussonic 23.12, o usa la Pestaña 2 para generar/empujar tus canales de Cesbo Astra.
                          </td>
                        </tr>
                      ) : (
                        filteredLive.map((st) => (
                          <tr key={st.name} className="hover:bg-slate-800/30">
                            <td className="px-3 py-2.5 font-mono text-violet-300 font-bold">{st.name}</td>
                            <td className="px-3 py-2.5 font-semibold text-white">{st.title}</td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-slate-300 max-w-[260px] truncate">
                              {st.input_url || '—'}
                            </td>
                            <td className="px-3 py-2.5">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                  st.static
                                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                                    : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                                }`}
                              >
                                {st.static ? '24/7 ESTÁTICO' : 'ON-DEMAND'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                                <span
                                  className={`px-2 py-0.5 rounded font-bold ${
                                    st.alive ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
                                  }`}
                                >
                                  {st.alive ? `${st.bitrate_kbps} kbps` : 'OFFLINE'}
                                </span>
                                {st.resolution && (
                                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200">
                                    {st.resolution}
                                  </span>
                                )}
                                {st.has_transcoder && (
                                  <span className="px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200">
                                    TRANSCODER
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right space-x-1">
                              <button
                                onClick={() =>
                                  onPreview &&
                                  onPreview({
                                    title: `${st.title} (Flussonic 23.12)`,
                                    url: st.pull_hls_url,
                                    kind: 'live'
                                  })
                                }
                                className="p-1.5 rounded-lg bg-indigo-600/25 hover:bg-indigo-600 text-indigo-300 hover:text-white"
                                title="Previsualizar HLS desde Flussonic 23.12"
                              >
                                <Play className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleStreamAction(st.name, 'restart')}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300"
                                title="Reiniciar stream en Flussonic 23.12"
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleStreamAction(st.name, 'delete')}
                                className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                                title="Eliminar stream en Flussonic 23.12"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
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
          )}
        </>
      )}

      {/* TAB 2: FLUSSONIC.CONF v23.12 GENERATOR FOR CESBO ASTRA */}
      {activeSubTab === 'generator' && (
        <div className="rounded-2xl bg-[#0e1526] border border-cyan-500/30 p-5 space-y-4">
          <div className="space-y-1">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <FileCode className="w-4 h-4 text-cyan-400" />
              Generador Oficial /etc/flussonic/flussonic.conf (Flussonic v23.12) para Cesbo Astra
            </h2>
            <p className="text-xs text-slate-400">
              Convierte automáticamente tus entradas <code className="text-cyan-300">http://192.168.88.10:8000/play/a0ek?ts</code> al esquema nativo{' '}
              <code className="text-violet-300">tshttp://192.168.88.10:8000/play/a0ek?ts</code> de Flussonic 23.12 en bloques{' '}
              <code className="text-emerald-300">stream &lt;id&gt;</code> (24/7 constantes, nunca On-Demand).
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2">
              <label className="text-xs font-bold text-slate-200 block">1. Origen de Canales Astra</label>
              <select
                value={genSourceType}
                onChange={(e) => setGenSourceType(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-xs text-white"
              >
                <option value="panel_streams">
                  Usar mis canales actuales del Panel ({totalPanelStreams} canales)
                </option>
                <option value="astra_m3u">Subir / Pegar playlist.txt o .m3u de Cesbo Astra</option>
              </select>
              <input
                type="text"
                value={genAstraOverrideHost}
                onChange={(e) => setGenAstraOverrideHost(e.target.value)}
                placeholder="IP LAN Astra (ej. 192.168.88.10:8000)"
                className="w-full px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-xs text-cyan-300 font-mono"
              />
            </div>

            <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2">
              <label className="text-xs font-bold text-slate-200 block">2. Modo en Flussonic 23.12</label>
              <select
                value={genTranscodeMode}
                onChange={(e) => setGenTranscodeMode(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-xs text-white"
              >
                <option value="copy_deint_aac">
                  🛡️ Anti-Rayas (deinterlace=true) + CPU x264 + Audio AAC 48k
                </option>
                <option value="copy_video_aac">
                  ⚡ Copy Video (vb=copy) + Audio AAC 48k Estéreo
                </option>
                <option value="copy_pure">
                  ⚡ Copy/Copy Puro Passthrough (0% CPU en Flussonic)
                </option>
                <option value="nvenc_deint_aac">
                  🟢 NVIDIA NVENC + Anti-Rayas + Audio AAC 48k
                </option>
                <option value="qsv_deint_aac">
                  🔵 Intel QuickSync QSV + Anti-Rayas + Audio AAC 48k
                </option>
              </select>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <span className="text-slate-400">Video kbps:</span>
                  <input
                    type="number"
                    value={genVideoKbps}
                    onChange={(e) => setGenVideoKbps(Number(e.target.value))}
                    className="w-full px-2 py-1 rounded bg-[#0e1526] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <span className="text-slate-400">Audio kbps:</span>
                  <input
                    type="number"
                    value={genAudioKbps}
                    onChange={(e) => setGenAudioKbps(Number(e.target.value))}
                    className="w-full px-2 py-1 rounded bg-[#0e1526] border border-slate-700 text-white font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2.5 flex flex-col justify-between">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-emerald-300 font-bold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={genConstant247}
                    onChange={(e) => setGenConstant247(e.target.checked)}
                    className="rounded accent-emerald-500"
                  />
                  24/7 Constante (`stream` estático, NO ondemand)
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={genIncludeHeader}
                    onChange={(e) => setGenIncludeHeader(e.target.checked)}
                    className="rounded accent-cyan-500"
                  />
                  Incluir cabecera global (`http 8080; edit_auth ...`)
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleGenerateConf}
                  className="flex-1 py-2 px-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold"
                >
                  Generar flussonic.conf
                </button>
                {selectedServer && (
                  <button
                    type="button"
                    disabled={pushingApi}
                    onClick={handlePushStreamsApi}
                    className="py-2 px-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold inline-flex items-center gap-1"
                    title="Crea todos los canales directamente en Flussonic 23.12 vía PUT /streamer/api/v3/streams"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {pushingApi ? 'Enviando...' : 'Push API v3'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {genSourceType === 'astra_m3u' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-300">
                  Sube tu archivo <code className="text-cyan-300">playlist.txt</code> / <code className="text-cyan-300">.m3u</code> de Cesbo Astra o pégalo abajo:
                </span>
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  Subir playlist.txt / .m3u
                  <input
                    type="file"
                    accept=".txt,.m3u,.m3u8,.conf,.json"
                    onChange={handleUploadAstraFile}
                    className="hidden"
                  />
                </label>
              </div>
              <textarea
                rows={4}
                value={genAstraText}
                onChange={(e) => setGenAstraText(e.target.value)}
                placeholder="#EXTM3U&#10;#EXTINF:-1 tvg-logo=&quot;http://192.168.88.10:8000/playlist/tvg-logo/a0ek.png&quot;,A&amp;E&#10;http://192.168.88.10:8000/play/a0ek?ts"
                className="w-full p-3 rounded-xl bg-[#090e1a] border border-slate-700 text-xs font-mono text-slate-200"
              />
            </div>
          )}

          {generatedConf && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-emerald-300">
                  ✅ Configuración Flussonic v23.12 lista ({generatedCount} canales):
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(generatedConf);
                      setCopiedConf(true);
                      setTimeout(() => setCopiedConf(false), 2500);
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-white font-semibold"
                  >
                    {copiedConf ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedConf ? 'Copiado' : 'Copiar flussonic.conf'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadConf}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs text-white font-bold"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Descargar flussonic.conf
                  </button>
                </div>
              </div>
              <pre className="p-4 rounded-xl bg-[#070b14] border border-slate-800 text-[11px] font-mono text-cyan-200 max-h-96 overflow-auto whitespace-pre">
                {generatedConf}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: IMPORT EXISTING FLUSSONIC.CONF */}
      {activeSubTab === 'import_conf' && (
        <div className="rounded-2xl bg-[#0e1526] border border-emerald-500/30 p-5 space-y-4">
          <h2 className="text-sm font-bold text-white">
            Importar bloques desde un archivo /etc/flussonic/flussonic.conf existente hacia TVLister 24/7
          </h2>
          <textarea
            rows={8}
            value={pastedFlussConf}
            onChange={(e) => setPastedFlussConf(e.target.value)}
            placeholder={'stream a0ek {\n  title "A&E";\n  input tshttp://192.168.88.10:8000/play/a0ek?ts;\n}'}
            className="w-full p-3 rounded-xl bg-[#090e1a] border border-slate-700 text-xs font-mono text-slate-200"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400">Modo en Panel TVLister:</span>
              <select
                value={cloudLinkMode}
                onChange={(e) => setCloudLinkMode(e.target.value)}
                className="px-3 py-1.5 rounded-lg bg-[#090e1a] border border-slate-700 text-white text-xs"
              >
                <option value="constant_copy_247">⚡ 24/7 Constante Copy/Copy (0% CPU)</option>
                <option value="constant_copy_audio_247">🔊 24/7 Copy Video + Nivelador Audio</option>
                <option value="ondemand">🌱 On-Demand</option>
              </select>
            </div>
            <button
              type="button"
              disabled={linking || !pastedFlussConf.trim()}
              onClick={() => handleLinkToPanel(true)}
              className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold"
            >
              {linking ? 'Importando...' : 'Importar y Enlazar 24/7 sin Duplicar'}
            </button>
          </div>
        </div>
      )}

      {/* Modal: Register Flussonic 23.12 Server */}
      {createOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateServer}
            className="w-full max-w-lg rounded-2xl bg-[#0e1526] border border-violet-500/40 p-6 space-y-4"
          >
            <h2 className="text-base font-bold text-white">Registrar Servidor Flussonic v23.12</h2>
            <div className="space-y-3 text-xs">
              <div>
                <label className="text-slate-300 font-semibold block mb-1">Nombre Identificador</label>
                <input
                  type="text"
                  required
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                />
              </div>
              <div>
                <label className="text-slate-300 font-semibold block mb-1">
                  URL / IP:Puerto de Flussonic 23.12 (accesible desde este panel)
                </label>
                <input
                  type="text"
                  required
                  placeholder="http://IP_PUBLICA_O_LAN:8080"
                  value={createForm.base_url}
                  onChange={(e) => setCreateForm({ ...createForm, base_url: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-300 font-semibold block mb-1">Usuario (edit_auth)</label>
                  <input
                    type="text"
                    value={createForm.username}
                    onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="text-slate-300 font-semibold block mb-1">Contraseña</label>
                  <input
                    type="password"
                    value={createForm.password}
                    onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  />
                </div>
              </div>
              <div>
                <label className="text-slate-300 font-semibold block mb-1">
                  IP Local Cesbo Astra (en la red de Flussonic)
                </label>
                <input
                  type="text"
                  value={createForm.astra_url}
                  onChange={(e) => setCreateForm({ ...createForm, astra_url: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-cyan-300 font-mono"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold"
              >
                Guardar Flussonic 23.12
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
