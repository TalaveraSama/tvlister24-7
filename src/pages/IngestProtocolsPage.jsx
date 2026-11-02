import React, { useEffect, useState } from 'react';
import {
  Zap,
  Radio,
  Server,
  DownloadCloud,
  Play,
  Square,
  RefreshCw,
  Plus,
  Trash2,
  Copy,
  Check,
  ArrowRightLeft,
  ShieldCheck,
  Activity,
  Network,
  FileCode2,
  Gauge,
  Lock,
  Unlock,
  KeyRound
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

const SAMPLE_FLUSSONIC_CONF = `# Ejemplo /etc/flussonic/flussonic.conf
stream espn_latam_hd {
  input m4f://origin-flussonic.ejemplo.com:8080/espn_latam_hd;
  input http://backup-ts.ejemplo.com:8080/live/espn.ts;
  title "ESPN Latam FHD";
  group "Deportes Premium";
  meta tvg_id "espn.latam";
  dvr /storage 7d;
}

stream cine_estelar {
  input tshttp://origin-flussonic.ejemplo.com:8080/cine_estelar;
  title "Cine Estelar HD";
  group "Películas TV";
}`;

function formatBytes(bytes = 0) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function IngestProtocolsPage() {
  const [subTab, setSubTab] = useState('mnf'); // 'mnf' | 'ingest' | 'flussonic' | 'ports'
  const [copiedKey, setCopiedKey] = useState('');
  const [toast, setToast] = useState(null);

  // 1. MNF State
  const [mnfStats, setMnfStats] = useState(null);
  const [benchConfig, setBenchConfig] = useState({
    streamUrl: '',
    durationSec: 4,
    videoBitrateKbps: 3200,
    nullStuffingPct: 10,
  });
  const [benchResult, setBenchResult] = useState(null);
  const [benchRunning, setBenchRunning] = useState(false);

  // 2. Ingest RTMP/SRT/RTSP State
  const [ingestStatus, setIngestStatus] = useState(null);
  const [installingEngine, setInstallingEngine] = useState(false);
  const [portForm, setPortForm] = useState({
    rtmpPort: 1935,
    srtPort: 8890,
    rtspPort: 8554,
    hlsVariant: 'fmp4',
  });
  const [endpointForm, setEndpointForm] = useState({
    name: '',
    streamKey: '',
    protocolHint: 'rtmp',
    passphrase: '',
    autoCreateStream: true,
  });

  // 3. Flussonic State
  const [flussoMode, setFlussoMode] = useState('api'); // 'api' | 'conf'
  const [flussoForm, setFlussoForm] = useState({
    serverUrl: '',
    username: '',
    password: '',
    bearerToken: '',
    transport: 'm4f_scheme',
    streamToken: '',
    confText: SAMPLE_FLUSSONIC_CONF,
    pullBaseUrl: '',
    bouquetName: 'Flussonic M4F',
    createBouquet: true,
    onDemand: false,
  });
  const [flussoPreview, setFlussoPreview] = useState(null);
  const [flussoLoading, setFlussoLoading] = useState(false);
  const [m4fTestUrl, setM4fTestUrl] = useState('m4f://flussonic-edge.ejemplo.com:8080/deportes_fhd?token=abc123');
  const [m4fResolved, setM4fResolved] = useState([]);

  // 4. Multi-Port State
  const [portsData, setPortsData] = useState({ primaryPort: 8080, extraPorts: [], allListeningPorts: [] });
  const [newPortInput, setNewPortInput] = useState('');
  const [newPortScheme, setNewPortScheme] = useState('https');
  const [portBusy, setPortBusy] = useState(false);
  const [tlsInfo, setTlsInfo] = useState(null);
  const [tlsForm, setTlsForm] = useState({ certPath: '', keyPath: '' });
  const [tlsBusy, setTlsBusy] = useState(false);

  const notify = (msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4500);
  };

  const copyText = (key, value) => {
    navigator.clipboard?.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 1800);
  };

  const loadAll = async () => {
    try {
      const [mStats, ing, pList] = await Promise.all([
        apiFetch('/api/mnf/stats'),
        apiFetch('/api/ingest/status'),
        apiFetch('/api/ports'),
      ]);
      setMnfStats(mStats);
      setIngestStatus(ing);
      if (ing?.config) {
        setPortForm({
          rtmpPort: ing.config.rtmpPort,
          srtPort: ing.config.srtPort,
          rtspPort: ing.config.rtspPort,
          hlsVariant: ing.config.hlsVariant || 'fmp4',
        });
      }
      setPortsData(pList);
      // Certificado de los puertos 80/443: viene con el mismo listado para que
      // la tarjeta no parpadee al entrar en la pestaña.
      const tlsState = pList?.tls;
      if (tlsState) {
        setTlsInfo(tlsState);
        setTlsForm({ certPath: tlsState.certPath || '', keyPath: tlsState.keyPath || '' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadAll();
    runBenchmark(true);
  }, []);

  const runBenchmark = async (silent = false) => {
    setBenchRunning(true);
    try {
      const res = await apiFetch('/api/mnf/benchmark', {
        method: 'POST',
        body: JSON.stringify(benchConfig),
      });
      setBenchResult(res);
      if (!silent) notify(`Benchmark MNF completado: ${res.bandwidthSavedPct}% menos tráfico que MPEG-TS.`);
    } catch (err) {
      if (!silent) notify(err.message, 'err');
    } finally {
      setBenchRunning(false);
    }
  };

  const handleInstallMediaMtx = async () => {
    setInstallingEngine(true);
    try {
      const res = await apiFetch('/api/ingest/install-engine', { method: 'POST' });
      setIngestStatus(res.status);
      notify('Motor MediaMTX (RTMP/SRT/RTSP/CMAF) descargado e iniciado correctamente.');
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setInstallingEngine(false);
    }
  };

  const handleIngestControl = async (action) => {
    try {
      const res = await apiFetch('/api/ingest/control', {
        method: 'POST',
        body: JSON.stringify({ action, config: portForm }),
      });
      setIngestStatus(res);
      notify(action === 'stop' ? 'Servidor de ingesta detenido.' : 'Servidor RTMP/SRT/RTSP actualizado y activo.');
    } catch (err) {
      notify(err.message, 'err');
    }
  };

  const handleCreateEndpoint = async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/ingest/endpoints', {
        method: 'POST',
        body: JSON.stringify(endpointForm),
      });
      setIngestStatus(res.status);
      setEndpointForm({ name: '', streamKey: '', protocolHint: 'rtmp', passphrase: '', autoCreateStream: true });
      notify(`Punto de ingesta "${res.created.streamKey}" creado y vinculado a Canales en Vivo.`);
    } catch (err) {
      notify(err.message, 'err');
    }
  };

  const handleDeleteEndpoint = async (id) => {
    try {
      const res = await apiFetch(`/api/ingest/endpoints/${id}?deleteStream=true`, { method: 'DELETE' });
      setIngestStatus(res);
      notify('Punto de ingesta eliminado.');
    } catch (err) {
      notify(err.message, 'err');
    }
  };

  const handleFlussoPreview = async () => {
    setFlussoLoading(true);
    try {
      const res = await apiFetch('/api/flussonic/preview', {
        method: 'POST',
        body: JSON.stringify({ mode: flussoMode, ...flussoForm }),
      });
      setFlussoPreview(res);
      notify(`Se detectaron ${res.total} canales desde Flussonic.`);
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setFlussoLoading(false);
    }
  };

  const handleFlussoCommit = async () => {
    if (!flussoPreview?.streams?.length) return;
    setFlussoLoading(true);
    try {
      const res = await apiFetch('/api/flussonic/import', {
        method: 'POST',
        body: JSON.stringify({
          streams: flussoPreview.streams,
          createBouquet: flussoForm.createBouquet,
          bouquetName: flussoForm.bouquetName,
          onDemand: flussoForm.onDemand,
        }),
      });
      notify(
        `Importación Flussonic exitosa: ${res.streamsInserted} nuevos, ${res.streamsUpdated} actualizados (${res.categoriesCreated} categorías).`
      );
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setFlussoLoading(false);
    }
  };

  const handleResolveM4f = async () => {
    try {
      const res = await apiFetch('/api/flussonic/resolve-m4f', {
        method: 'POST',
        body: JSON.stringify({ url: m4fTestUrl }),
      });
      setM4fResolved(res.candidates || []);
    } catch (err) {
      notify(err.message, 'err');
    }
  };

  useEffect(() => {
    handleResolveM4f();
  }, []);

  const loadTls = async (refresh = false) => {
    try {
      const info = await apiFetch(`/api/ports/tls${refresh ? '?refresh=1' : ''}`);
      setTlsInfo(info);
      setTlsForm({ certPath: info.certPath || '', keyPath: info.keyPath || '' });
    } catch {
      /* la tarjeta queda en «sin datos» */
    }
  };

  const saveTlsPaths = async () => {
    setTlsBusy(true);
    try {
      const info = await apiFetch('/api/ports/tls', {
        method: 'POST',
        body: JSON.stringify({ certPath: tlsForm.certPath, keyPath: tlsForm.keyPath })
      });
      setTlsInfo(info);
      if (info.ports) setPortsData(info.ports);
      notify(info.available ? 'Certificado cargado y puertos TLS reabiertos.' : info.error || 'Certificado no válido', info.available ? 'ok' : 'err');
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setTlsBusy(false);
    }
  };

  const redetectTls = async () => {
    setTlsBusy(true);
    try {
      const info = await apiFetch('/api/ports/tls?refresh=1');
      setTlsInfo(info);
      notify(info.available ? `Certificado encontrado: ${info.source}` : info.error || 'Sin certificado', info.available ? 'ok' : 'err');
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setTlsBusy(false);
    }
  };

  const rebindPorts = async () => {
    setPortBusy(true);
    try {
      const res = await apiFetch('/api/ports/rebind', { method: 'POST' });
      setPortsData(res);
      notify('Puertos TLS reabiertos con el certificado actual.');
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setPortBusy(false);
    }
  };

  const handleAddPort = async (portVal, schemeVal) => {
    const p = Number(portVal || newPortInput);
    if (!p) return;
    const scheme = schemeVal || newPortScheme;
    setPortBusy(true);
    try {
      const res = await apiFetch('/api/ports', {
        method: 'POST',
        body: JSON.stringify({ port: p, scheme }),
      });
      setPortsData(res);
      setNewPortInput('');
      if (res.status === 'listening') {
        const proto = res.scheme === 'https' ? 'HTTPS' : res.scheme === 'both' ? 'HTTPS + HTTP' : 'HTTP';
        notify(`Puerto ${p} abierto (${proto}) y escuchando en 0.0.0.0:${p}`);
        if (res.tls) await loadTls();
      } else {
        notify(res.error || `No se pudo abrir el puerto ${p}`, 'err');
      }
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setPortBusy(false);
    }
  };

  const handleRemovePort = async (port) => {
    setPortBusy(true);
    try {
      const res = await apiFetch(`/api/ports/${port}`, { method: 'DELETE' });
      setPortsData(res);
      notify(`Puerto adicional ${port} cerrado y removido.`);
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setPortBusy(false);
    }
  };

  const baseHost = typeof window !== 'undefined' ? window.location.host : 'tu-servidor:8095';
  const wsProto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const httpProto = typeof window !== 'undefined' ? window.location.protocol.replace(':', '') : 'http';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Zap className="w-6 h-6 text-cyan-400" />
            Ingesta RTMP/SRT/RTSP, Flussonic M4F & Protocolo MNF
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Hub profesional de contribución en vivo, compatibilidad nativa Flussonic Media Server, multi-puerto dinámico y transporte ultraligero MNF v1.
          </p>
        </div>
        <button
          onClick={loadAll}
          className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-2 self-start"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Actualizar Estado
        </button>
      </div>

      {toast && (
        <div
          className={`px-4 py-3 rounded-xl border text-sm font-medium ${
            toast.type === 'err'
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Navigation Pills */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 bg-[#0d1322] p-2 rounded-2xl border border-slate-800/80">
        {[
          { id: 'mnf', label: 'Protocolo MNF v1 (Más Liviano que TS)', icon: Zap, badge: 'NUEVO' },
          { id: 'ingest', label: 'Servidor RTMP / SRT / RTSP', icon: Radio, badge: ingestStatus?.running ? 'ACTIVO' : null },
          { id: 'flussonic', label: 'Importar Flussonic & M4F', icon: ArrowRightLeft },
          { id: 'ports', label: `Multi-Puertos HTTPS/HTTP (${portsData.allListeningPorts?.length || 1})`, icon: Network },
        ].map((t) => {
          const Icon = t.icon;
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                active
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{t.label}</span>
              </span>
              {t.badge && (
                <span
                  className={`ml-1.5 px-1.5 py-0.5 text-[10px] rounded-md font-bold ${
                    active ? 'bg-white/20 text-white' : 'bg-cyan-500/20 text-cyan-300'
                  }`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ==================== TAB 1: MNF v1 PROTOCOL ==================== */}
      {subTab === 'mnf' && (
        <div className="space-y-6">
          {/* Architecture Overview */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-[#0d1322] border border-cyan-500/30 rounded-2xl p-5">
              <div className="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-1">
                ¿Qué inventamos? — MNF v1
              </div>
              <div className="text-lg font-bold text-white mb-2">TVLister Media NanoFrame (MNF)</div>
              <p className="text-xs text-slate-400 leading-relaxed">
                MPEG-TS (<code className="text-slate-200">.ts</code>) fue diseñado en 1994 para satélite con celdas fijas de <strong>188 bytes</strong>, cabeceras PES repetidas, tablas PAT/PMT cada 100ms y relleno nulo <code className="text-rose-300">0x1FFF</code>, desperdiciando <strong>10% a 18%</strong> de ancho de banda.
                <br />
                <strong>MNF v1</strong> encapsula cada Access Unit completa con solo <strong>9 bytes de cabecera</strong> (<code className="text-emerald-300">&lt;0.25% overhead</code>).
              </p>
            </div>

            <div className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5">
              <div className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-1">
                Zapping Instantáneo (&lt;35ms)
              </div>
              <div className="text-lg font-bold text-white mb-2">GOP Keyframe Burst en RAM</div>
              <p className="text-xs text-slate-400 leading-relaxed">
                En <code className="text-slate-200">.ts</code> tradicional, el reproductor queda en negro 1.5s–3s esperando el próximo Keyframe IDR. El Hub MNF indexa el último <code className="text-emerald-300">VIDEO_KEYFRAME (0x02)</code> en memoria y lo inyecta en ráfaga al instante en que el cliente o nodo Edge conecta.
              </p>
            </div>

            <div className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5">
              <div className="text-xs font-bold uppercase tracking-wider text-violet-400 mb-1">
                Trunking Híbrido Sin Pérdida
              </div>
              <div className="text-lg font-bold text-white mb-2">Ida y Vuelta TS ↔ MNF ↔ CMAF</div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Conecta dos paneles TVLister usando <code className="text-violet-300">mnf://origen:8095/u/p/1.mnf</code> para ahorrar hasta 18% de tráfico entre servidores VPS, y TVLister lo remuxea en tiempo real a <code className="text-slate-200">.ts</code> o HLS para Smart TVs antiguas sin recodificar CPU.
              </p>
            </div>
          </div>

          {/* Live Benchmark Card */}
          <div className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5 space-y-5">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Gauge className="w-5 h-5 text-cyan-400" />
                  Laboratorio de Benchmark en Vivo: MPEG-TS (.ts) vs MNF v1 (.mnf)
                </h2>
                <p className="text-xs text-slate-400">
                  Ejecuta una prueba binaria real sobre el motor <code className="text-cyan-300">TsToMnfTransmuxer</code> (o mide una URL .ts en vivo durante 3.5s).
                </p>
              </div>
              <button
                onClick={() => runBenchmark(false)}
                disabled={benchRunning}
                className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-2 disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                {benchRunning ? 'Midiendo paquetes...' : 'Ejecutar Benchmark Ahora'}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="md:col-span-2">
                <label className="block text-[11px] text-slate-400 mb-1">
                  URL de Stream MPEG-TS en Vivo (opcional — vacío usa generador Broadcast CBR H.264+AAC)
                </label>
                <input
                  type="text"
                  value={benchConfig.streamUrl}
                  onChange={(e) => setBenchConfig({ ...benchConfig, streamUrl: e.target.value })}
                  placeholder="Ej: http://proveedor:8080/live/user/pass/101.ts (o déjalo vacío)"
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Bitrate Video Simulado (kbps)</label>
                <input
                  type="number"
                  value={benchConfig.videoBitrateKbps}
                  onChange={(e) => setBenchConfig({ ...benchConfig, videoBitrateKbps: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">% Stuffing CBR 0x1FFF Satélite</label>
                <input
                  type="number"
                  min="0"
                  max="35"
                  value={benchConfig.nullStuffingPct}
                  onChange={(e) => setBenchConfig({ ...benchConfig, nullStuffingPct: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
            </div>

            {benchResult && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 pt-2">
                <div className="bg-[#090d16] border border-slate-800/90 rounded-xl p-3.5">
                  <div className="text-[11px] text-slate-400">Tráfico MPEG-TS (.ts)</div>
                  <div className="text-lg font-bold text-rose-400 mt-0.5">{formatBytes(benchResult.tsTotalBytes)}</div>
                  <div className="text-[11px] text-slate-500">Overhead: {benchResult.tsFramingOverheadPct}%</div>
                </div>
                <div className="bg-[#090d16] border border-cyan-500/40 rounded-xl p-3.5">
                  <div className="text-[11px] text-cyan-300">Tráfico MNF v1 (.mnf)</div>
                  <div className="text-lg font-bold text-cyan-400 mt-0.5">{formatBytes(benchResult.mnfTotalBytes)}</div>
                  <div className="text-[11px] text-emerald-400">Overhead: {benchResult.mnfFramingOverheadPct}%</div>
                </div>
                <div className="bg-[#090d16] border border-emerald-500/40 rounded-xl p-3.5">
                  <div className="text-[11px] text-emerald-300">Ahorro Neto de Banda</div>
                  <div className="text-lg font-bold text-emerald-400 mt-0.5">-{benchResult.bandwidthSavedPct}%</div>
                  <div className="text-[11px] text-slate-400">{formatBytes(benchResult.savedBytes)} eliminados</div>
                </div>
                <div className="bg-[#090d16] border border-slate-800/90 rounded-xl p-3.5">
                  <div className="text-[11px] text-slate-400">Basura TS Filtrada</div>
                  <div className="text-lg font-bold text-white mt-0.5">
                    {benchResult.nullPacketsRemoved + benchResult.psiPacketsRemoved} pkts
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {benchResult.nullPacketsRemoved} Null + {benchResult.psiPacketsRemoved} PSI
                  </div>
                </div>
                <div className="bg-[#090d16] border border-violet-500/40 rounded-xl p-3.5">
                  <div className="text-[11px] text-violet-300">Tiempo de Zapping</div>
                  <div className="text-lg font-bold text-violet-400 mt-0.5">{benchResult.estimatedZappingMnfMs} ms</div>
                  <div className="text-[11px] text-slate-500">vs ~{benchResult.estimatedZappingTsMs} ms en .ts</div>
                </div>
              </div>
            )}
          </div>

          {/* MNF Endpoints Reference */}
          <div className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-white">Endpoints Activos del Protocolo MNF v1 en tu Servidor</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              {[
                {
                  key: 'mnf_http',
                  title: 'Streaming Binario HTTP Chunked (.mnf)',
                  url: `${httpProto}://${baseHost}/mnf/<usuario>/<clave>/<id_canal>.mnf`,
                },
                {
                  key: 'mnf_ws',
                  title: 'WebSocket Binario Baja Latencia (MNF-WS)',
                  url: `${wsProto}://${baseHost}/ws/mnf/<usuario>/<clave>/<id_canal>`,
                },
                {
                  key: 'mnf_trunk',
                  title: 'Trunk Inter-Servidores TVLister (auto-remux a TS)',
                  url: `mnf://${baseHost}/mnf/<usuario>/<clave>/<id_canal>.mnf`,
                },
                {
                  key: 'mnf_m3u',
                  title: 'Lista M3U Completa en Formato Ultraligero MNF',
                  url: `${httpProto}://${baseHost}/get.php?username=<usuario>&password=<clave>&type=m3u_plus&output=mnf`,
                },
              ].map((item) => (
                <div key={item.key} className="bg-[#090d16] border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] text-slate-400 font-medium">{item.title}</div>
                    <code className="text-cyan-300 text-[11px] block truncate mt-0.5">{item.url}</code>
                  </div>
                  <button
                    onClick={() => copyText(item.key, item.url)}
                    className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 shrink-0"
                    title="Copiar plantilla"
                  >
                    {copiedKey === item.key ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ==================== TAB 2: RTMP / SRT / RTSP INGEST SERVER ==================== */}
      {subTab === 'ingest' && (
        <div className="space-y-6">
          <div className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="text-base font-bold text-white">Motor Servidor RTMP / SRT / RTSP</h2>
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                      ingestStatus?.running
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    }`}
                  >
                    {ingestStatus?.running
                      ? `EN EJECUCIÓN (PID ${ingestStatus.pid})`
                      : ingestStatus?.binaryInstalled
                      ? 'DETENIDO'
                      : 'BINARIO PENDIENTE DE DESCARGA'}
                  </span>
                  {/* Qué motor está recibiendo realmente la señal */}
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${
                      ingestStatus?.engineType === 'mediamtx'
                        ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
                        : ingestStatus?.engineType === 'native_node'
                        ? 'bg-violet-500/20 text-violet-300 border-violet-500/30'
                        : 'bg-slate-800 text-slate-400 border-slate-700'
                    }`}
                    title={
                      ingestStatus?.engineType === 'mediamtx'
                        ? 'Binario externo MediaMTX (aislado en /opt/tvlister24-7/.runtime/bin, sin apt)'
                        : ingestStatus?.engineType === 'native_node'
                        ? 'Motor propio de TVLister escrito en Node (RTMP + RTSP + socket UDP para SRT)'
                        : 'Motor detenido'
                    }
                  >
                    {ingestStatus?.engineType === 'mediamtx'
                      ? `MOTOR: ${ingestStatus?.version || 'MediaMTX'}`
                      : ingestStatus?.engineType === 'native_node'
                      ? 'MOTOR: PROPIO (Node)'
                      : 'MOTOR: DETENIDO'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Recibe señales en vivo desde OBS Studio, vMix, Larix Broadcaster, encoders Haivision/Kiloview o cámaras IP sin tocar paquetes del sistema Ubuntu (<code className="text-cyan-300">Zero-Apt</code>, 100% seguro junto a XUI.one).
                </p>
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Esto es la <b className="text-slate-300">entrada</b> (quien te manda señal). Cuando el panel
                  <b className="text-slate-300"> jala</b> de un proveedor lo hace con User-Agent
                  <code className="text-cyan-300"> TVLister/2.3</code>, y el transporte propio entre paneles es
                  <code className="text-cyan-300"> MNF v1</code>. La sesión <code className="text-slate-300">Streamer 23.12</code>
                  que ves en Astra es de Flussonic, no de este motor.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!ingestStatus?.binaryInstalled ? (
                  <button
                    onClick={handleInstallMediaMtx}
                    disabled={installingEngine}
                    className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 disabled:opacity-50"
                  >
                    <DownloadCloud className="w-4 h-4" />
                    {installingEngine ? 'Descargando MediaMTX v1.21.3...' : 'Activar e Instalar Motor RTMP/SRT/RTSP (1-Click)'}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => handleIngestControl('restart')}
                      className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5" /> Aplicar Puertos / Reiniciar
                    </button>
                    {ingestStatus?.running && (
                      <button
                        onClick={() => handleIngestControl('stop')}
                        className="px-3.5 py-2 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 font-semibold text-xs flex items-center gap-1.5"
                      >
                        <Square className="w-3.5 h-3.5" /> Detener
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Puerto RTMP (TCP - OBS/vMix)</label>
                <input
                  type="number"
                  value={portForm.rtmpPort}
                  onChange={(e) => setPortForm({ ...portForm, rtmpPort: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Puerto SRT Listener (UDP)</label>
                <input
                  type="number"
                  value={portForm.srtPort}
                  onChange={(e) => setPortForm({ ...portForm, srtPort: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Puerto RTSP Server (TCP/UDP)</label>
                <input
                  type="number"
                  value={portForm.rtspPort}
                  onChange={(e) => setPortForm({ ...portForm, rtspPort: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Empaquetado Interno</label>
                <select
                  value={portForm.hlsVariant}
                  onChange={(e) => setPortForm({ ...portForm, hlsVariant: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                >
                  <option value="fmp4">CMAF fMP4 (Estilo M4F Ultraligero)</option>
                  <option value="mpegts">MPEG-TS Clásico</option>
                </select>
              </div>
            </div>
          </div>

          {/* Create Stream Key Form */}
          <form onSubmit={handleCreateEndpoint} className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Plus className="w-4 h-4 text-indigo-400" />
              Crear Nueva Clave de Transmisión (Stream Key)
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Nombre del Canal / Evento *</label>
                <input
                  type="text"
                  required
                  value={endpointForm.name}
                  onChange={(e) => setEndpointForm({ ...endpointForm, name: e.target.value })}
                  placeholder="Ej: Evento Deportivo PPV 1"
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Stream Key (vacío = autogenerar)</label>
                <input
                  type="text"
                  value={endpointForm.streamKey}
                  onChange={(e) => setEndpointForm({ ...endpointForm, streamKey: e.target.value })}
                  placeholder="Ej: ppv_evento_01"
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Passphrase / Token (opcional)</label>
                <input
                  type="text"
                  value={endpointForm.passphrase}
                  onChange={(e) => setEndpointForm({ ...endpointForm, passphrase: e.target.value })}
                  placeholder="Opcional para proteger publicación"
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  className="w-full py-2 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" /> Crear Punto de Ingesta
                </button>
              </div>
            </div>
          </form>

          {/* Active Endpoints Table */}
          <div className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-white">
              Puntos de Ingesta Configurados ({ingestStatus?.endpoints?.length || 0})
            </h3>
            {!ingestStatus?.endpoints?.length ? (
              <div className="text-xs text-slate-500 py-6 text-center">
                No hay puntos de ingesta creados aún. Crea uno arriba para obtener tus URLs RTMP, SRT y RTSP listas para OBS o vMix.
              </div>
            ) : (
              <div className="space-y-3">
                {ingestStatus.endpoints.map((ep) => (
                  <div key={ep.id} className="bg-[#090d16] border border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            ep.status === 'live' ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                          }`}
                        />
                        <span className="font-bold text-sm text-white">{ep.name}</span>
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-cyan-300 text-[11px] font-mono">
                          Key: {ep.stream_key}
                        </span>
                        {ep.linked_stream_id && (
                          <span className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 text-[11px]">
                            Canal ID #{ep.linked_stream_id}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteEndpoint(ep.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10"
                        title="Eliminar ingesta y canal vinculado"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px]">
                      {[
                        { label: 'OBS / RTMP URL Completa', val: ep.urls.rtmpFull, k: `rtmp_${ep.id}` },
                        { label: 'SRT Listener (vMix / Larix)', val: ep.urls.srtPublish, k: `srt_${ep.id}` },
                        { label: 'RTSP Push (FFmpeg / Cámara)', val: ep.urls.rtspPublish, k: `rtsp_${ep.id}` },
                      ].map((u) => (
                        <div key={u.k} className="bg-[#0d1322] border border-slate-800/80 rounded-lg p-2.5 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-slate-400 text-[10px]">{u.label}</div>
                            <code className="text-emerald-300 block truncate">{u.val}</code>
                          </div>
                          <button
                            onClick={() => copyText(u.k, u.val)}
                            className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 shrink-0"
                          >
                            {copiedKey === u.k ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== TAB 3: FLUSSONIC IMPORTER & M4F ==================== */}
      {subTab === 'flussonic' && (
        <div className="space-y-6">
          <div className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <ArrowRightLeft className="w-5 h-5 text-indigo-400" />
                  Importador Nativo Flussonic Media Server & Protocolo M4F
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Importa canales en vivo desde la API v3 de Flussonic, playlist M3U8 de Flussonic o archivo <code className="text-cyan-300">/etc/flussonic/flussonic.conf</code>.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setFlussoMode('api')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold ${
                    flussoMode === 'api' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  Conectar por API / URL
                </button>
                <button
                  onClick={() => setFlussoMode('conf')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 ${
                    flussoMode === 'conf' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  <FileCode2 className="w-3.5 h-3.5" /> Pegar flussonic.conf
                </button>
              </div>
            </div>

            {flussoMode === 'api' ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">URL Servidor Flussonic *</label>
                  <input
                    type="text"
                    value={flussoForm.serverUrl}
                    onChange={(e) => setFlussoForm({ ...flussoForm, serverUrl: e.target.value })}
                    placeholder="http://ip-flussonic:8080"
                    className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Usuario Admin Flussonic</label>
                  <input
                    type="text"
                    value={flussoForm.username}
                    onChange={(e) => setFlussoForm({ ...flussoForm, username: e.target.value })}
                    placeholder="admin"
                    className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Contraseña / API Key</label>
                  <input
                    type="password"
                    value={flussoForm.password}
                    onChange={(e) => setFlussoForm({ ...flussoForm, password: e.target.value })}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Servidor Flussonic Destino (opcional — si lo indicas, TVLister armará URLs m4f:// hacia ese servidor; si lo dejas vacío, importará los inputs originales)
                  </label>
                  <input
                    type="text"
                    value={flussoForm.pullBaseUrl}
                    onChange={(e) => setFlussoForm({ ...flussoForm, pullBaseUrl: e.target.value })}
                    placeholder="Opcional: http://ip-flussonic:8080"
                    className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Contenido de flussonic.conf</label>
                  <textarea
                    rows={7}
                    value={flussoForm.confText}
                    onChange={(e) => setFlussoForm({ ...flussoForm, confText: e.target.value })}
                    className="w-full px-3 py-2.5 rounded-xl bg-[#090d16] border border-slate-800 text-xs font-mono text-cyan-200"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Protocolo de Lectura Preferido</label>
                <select
                  value={flussoForm.transport}
                  onChange={(e) => setFlussoForm({ ...flussoForm, transport: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                >
                  <option value="m4f_scheme">m4f:// Nativo (CMAF fMP4 + Failover HLS/TS)</option>
                  <option value="m4f">CMAF Fragmented MP4 (/index.fmp4.m3u8)</option>
                  <option value="hls">HLS Estándar (/index.m3u8)</option>
                  <option value="mpegts">HTTP MPEG-TS (/mpegts)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Token de Stream Flussonic (opcional)</label>
                <input
                  type="text"
                  value={flussoForm.streamToken}
                  onChange={(e) => setFlussoForm({ ...flussoForm, streamToken: e.target.value })}
                  placeholder="Ej: token fijo de peering"
                  className="w-full px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleFlussoPreview}
                  disabled={flussoLoading}
                  className="flex-1 py-2 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs"
                >
                  {flussoLoading ? 'Analizando...' : 'Analizar Streams'}
                </button>
                {flussoPreview?.streams?.length > 0 && (
                  <button
                    onClick={handleFlussoCommit}
                    disabled={flussoLoading}
                    className="flex-1 py-2 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs"
                  >
                    Importar ({flussoPreview.streams.length})
                  </button>
                )}
              </div>
            </div>

            {flussoPreview?.streams?.length > 0 && (
              <div className="border border-slate-800 rounded-xl overflow-hidden mt-3">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#090d16] text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Canal</th>
                      <th className="px-3 py-2">Grupo</th>
                      <th className="px-3 py-2">URL Primaria (M4F / CMAF / TS)</th>
                      <th className="px-3 py-2">DVR</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {flussoPreview.streams.slice(0, 25).map((s, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-2 font-semibold text-white">{s.name}</td>
                        <td className="px-3 py-2 text-slate-400">{s.group}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-cyan-300 truncate max-w-xs">{s.primaryUrl}</td>
                        <td className="px-3 py-2 text-slate-400">{s.dvrDays > 0 ? `${s.dvrDays}d` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Native M4F URL Resolver Tester */}
          <div className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              Traductor Nativo de Esquemas Flussonic (m4f://, m4fs://, tshttp://, hls://)
            </h3>
            <p className="text-xs text-slate-400">
              Puedes pegar directamente cualquier URL <code className="text-cyan-300">m4f://servidor:puerto/canal</code> al crear un canal en <strong>Canales en Vivo</strong>. Stream Shield negocia CMAF <code className="text-emerald-300">index.fmp4.m3u8</code> con failover automático:
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={m4fTestUrl}
                onChange={(e) => setM4fTestUrl(e.target.value)}
                className="flex-1 px-3 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs font-mono text-white"
              />
              <button
                onClick={handleResolveM4f}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white"
              >
                Probar Resolución
              </button>
            </div>
            {m4fResolved.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {m4fResolved.map((cand, i) => (
                  <div key={i} className="text-[11px] font-mono bg-[#090d16] border border-slate-800/80 px-3 py-1.5 rounded-lg text-emerald-300">
                    Prioridad #{i + 1}: {cand}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== TAB 4: MULTI-PORT HTTP/HTTPS MANAGER ==================== */}
      {subTab === 'ports' && (
        <div className="space-y-6">
          <div className="bg-[#0d1322] border border-slate-800 rounded-2xl p-5 space-y-4">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Network className="w-5 h-5 text-cyan-400" />
                Gestor Dinámico Multi-Puerto (HTTPS / HTTP / Xtream / HLS / TS / MNF)
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Abre puertos TCP simultáneos en caliente sin reiniciar el puerto principal, con TLS
                propio en el panel. Así los reproductores que exigen el <strong>443</strong> (o que
                rechazan HTTP) funcionan igual que los que usan 8080/8880, compartiendo las mismas
                líneas y conexiones.
              </p>
            </div>

            {/* Certificado TLS */}
            <div
              className={`rounded-xl border p-4 space-y-3 ${
                tlsInfo?.available ? 'bg-emerald-500/5 border-emerald-500/30' : 'bg-amber-500/5 border-amber-500/30'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  {tlsInfo?.available ? (
                    <Lock className="w-4 h-4 text-emerald-400 mt-0.5" />
                  ) : (
                    <Unlock className="w-4 h-4 text-amber-400 mt-0.5" />
                  )}
                  <div>
                    <div className="text-sm font-bold text-white">
                      {tlsInfo?.available ? 'Certificado HTTPS en uso' : 'Sin certificado HTTPS'}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {tlsInfo?.available
                        ? `${tlsInfo.domain} · vence ${String(tlsInfo.validTo || '').slice(0, 10)} · ${tlsInfo.daysLeft} días · ${tlsInfo.source}`
                        : tlsInfo?.error || 'Cargando estado del certificado…'}
                    </p>
                    {tlsInfo?.available && (
                      <p className="text-[10px] text-slate-500 mt-1 font-mono break-all">
                        cert: {tlsInfo.certPath} · key: {tlsInfo.keyPath}
                      </p>
                    )}
                    {tlsInfo?.available && tlsInfo.uncoveredDomains?.length > 0 && (
                      <p className="text-[10px] text-amber-300 mt-1">
                        El certificado no cubre: {tlsInfo.uncoveredDomains.join(', ')}
                      </p>
                    )}
                    {(tlsInfo?.expiresSoon || tlsInfo?.expired) && (
                      <p className={`text-[10px] mt-1 ${tlsInfo?.expired ? 'text-rose-300 font-semibold' : 'text-amber-300'}`}>
                        {tlsInfo.hint}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={redetectTls}
                    disabled={tlsBusy}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${tlsBusy ? 'animate-spin' : ''}`} /> Volver a detectar
                  </button>
                  <button
                    onClick={rebindPorts}
                    disabled={portBusy || !tlsInfo?.available}
                    className="px-3 py-1.5 rounded-lg bg-cyan-600/25 hover:bg-cyan-600 text-cyan-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40"
                    title="Reabre los puertos TLS con el certificado actual (tras renovarlo)"
                  >
                    <Lock className="w-3.5 h-3.5" /> Reabrir puertos TLS
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <input
                  value={tlsForm.certPath}
                  onChange={(e) => setTlsForm({ ...tlsForm, certPath: e.target.value })}
                  placeholder="/etc/letsencrypt/live/midominio.com/fullchain.pem"
                  className="px-3 py-2 rounded-lg bg-[#090d16] border border-slate-800 text-[11px] font-mono text-white"
                />
                <input
                  value={tlsForm.keyPath}
                  onChange={(e) => setTlsForm({ ...tlsForm, keyPath: e.target.value })}
                  placeholder="/etc/letsencrypt/live/midominio.com/privkey.pem"
                  className="px-3 py-2 rounded-lg bg-[#090d16] border border-slate-800 text-[11px] font-mono text-white"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={saveTlsPaths}
                  disabled={tlsBusy || !tlsForm.certPath || !tlsForm.keyPath}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-40"
                >
                  <KeyRound className="w-3.5 h-3.5" /> Guardar rutas y aplicar
                </button>
                <span className="text-[10px] text-slate-500">
                  Si el certificado está en Let&apos;s Encrypt o acme.sh del dominio del panel, se
                  detecta solo. Nunca se genera uno autofirmado. La clave privada no sale del servidor.
                </span>
              </div>
            </div>

            {/* Add Port Input & Presets */}
            <div className="flex flex-col md:flex-row gap-3">
              <div className="flex gap-2 flex-1">
                <input
                  type="number"
                  min="80"
                  max="65535"
                  value={newPortInput}
                  onChange={(e) => setNewPortInput(e.target.value)}
                  placeholder="Puerto TCP (ej. 443)"
                  className="flex-1 px-3.5 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                />
                <select
                  value={newPortScheme}
                  onChange={(e) => setNewPortScheme(e.target.value)}
                  className="px-2.5 py-2 rounded-xl bg-[#090d16] border border-slate-800 text-xs text-white"
                  title="Protocolo del puerto"
                >
                  <option value="https">Sólo HTTPS (TLS)</option>
                  <option value="both">HTTPS + HTTP (mismo puerto)</option>
                  <option value="http">Sólo HTTP (sin TLS)</option>
                </select>
                <button
                  onClick={() => handleAddPort()}
                  disabled={portBusy || !newPortInput}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" /> Abrir Puerto
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-500 mr-1">Estándar / ISP:</span>
                <button
                  onClick={() => handleAddPort(443, 'https')}
                  disabled={portBusy}
                  className="px-2.5 py-1.5 rounded-lg bg-emerald-600/25 hover:bg-emerald-600 text-emerald-200 hover:text-white text-xs font-mono font-bold"
                  title="HTTPS en el puerto estándar (requiere certificado)"
                >
                  :443 HTTPS
                </button>
                <button
                  onClick={() => handleAddPort(80, 'both')}
                  disabled={portBusy}
                  className="px-2.5 py-1.5 rounded-lg bg-cyan-600/25 hover:bg-cyan-600 text-cyan-200 hover:text-white text-xs font-mono font-bold"
                  title="HTTPS en el 80 y el HTTP plano redirige a HTTPS"
                >
                  :80 HTTPS+HTTP
                </button>
                {[8080, 8880, 25461].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => handleAddPort(preset, tlsInfo?.available ? 'both' : 'http')}
                    disabled={portBusy}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono"
                  >
                    +{preset}
                  </button>
                ))}
              </div>
            </div>

            {/* Active Ports Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
              <div className="bg-[#090d16] border border-indigo-500/40 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <div className="text-[11px] text-indigo-300 font-semibold">PUERTO PRINCIPAL</div>
                  <div className="text-xl font-bold text-white font-mono mt-0.5">:{portsData.primaryPort}</div>
                  <div className="text-[11px] text-emerald-400 mt-0.5">
                    0.0.0.0:{portsData.primaryPort} (Activo)
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    {typeof window !== 'undefined' && window.location.protocol === 'https:'
                      ? 'HTTPS (a través de tu nginx/proxy)'
                      : 'HTTP directo del panel'}
                  </div>
                </div>
                <Server className="w-6 h-6 text-indigo-400" />
              </div>

              {(portsData.extraPorts || []).map((p) => (
                <div
                  key={p.port}
                  className={`bg-[#090d16] border rounded-xl p-4 flex items-center justify-between ${
                    p.status === 'listening' ? 'border-emerald-500/30' : 'border-rose-500/40'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-slate-400 font-semibold">PUERTO ADICIONAL</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                          p.scheme === 'https'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : p.scheme === 'both'
                              ? 'bg-cyan-500/20 text-cyan-300'
                              : 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {p.scheme === 'https' ? 'HTTPS' : p.scheme === 'both' ? 'HTTPS+HTTP' : 'HTTP'}
                      </span>
                    </div>
                    <div className="text-xl font-bold text-white font-mono mt-0.5">:{p.port}</div>
                    <div
                      className={`text-[11px] mt-0.5 ${
                        p.status === 'listening' ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {p.status === 'listening' ? `Escuchando en 0.0.0.0:${p.port}` : p.error || 'Error'}
                    </div>
                    {p.status === 'listening' && (
                      <div className="text-[10px] text-slate-500 mt-1 font-mono break-all">
                        {p.httpsUrl && <div>{p.httpsUrl}/</div>}
                        {p.httpUrl && <div>{p.httpUrl}/</div>}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemovePort(p.port)}
                    className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 shrink-0"
                    title="Cerrar puerto"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>

            <div className="bg-[#090d16] border border-slate-800 rounded-xl p-3.5 text-xs text-slate-400 space-y-1.5">
              <p>
                <strong className="text-slate-200">Cómo se atiende cada puerto:</strong> «Sólo HTTPS»
                cifra todo. «HTTPS + HTTP» mira el primer byte de la conexión y atiende TLS o HTTP en
                el mismo puerto; en el <strong className="text-slate-200">80</strong> el HTTP plano
                contesta un 301 al mismo host por HTTPS, así ningún reproductor se queda fuera.
              </p>
              <p>
                <strong className="text-slate-200">Puertos &lt; 1024:</strong> el servicio debe correr
                como root o con <code className="text-cyan-300">CAP_NET_BIND_SERVICE</code>. Si no,
                el panel lo dice al abrirlo («Permiso denegado»).
              </p>
              <p>
                <strong className="text-slate-200">Firewall:</strong> además del panel, abre el puerto
                en UFW con <code className="text-cyan-300">sudo tvlister-admin add-port 443</code>.
              </p>
              <p>
                <strong className="text-slate-200">¿«Puerto ocupado» en el 443?</strong> Ya hay algo
                escuchando ahí (el nginx de XUI, otro proxy). O lo liberas, o dejas que ese nginx
                siga atendiendo el 443 y haga proxy al panel: no hacen falta los dos.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
