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
  FileCode,
  Send,
  Link2,
  ShieldCheck,
  RotateCcw,
  Filter
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

export default function Flussonic2312Page({ onPreview }) {
  const [servers, setServers] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [totalPanelStreams, setTotalPanelStreams] = useState(0);
  const [liveStreams, setLiveStreams] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorNotice, setErrorNotice] = useState('');

  // Tabs: 'migrate_ip' (DEFAULT!) | 'live' | 'generator' | 'import_conf'
  const [activeSubTab, setActiveSubTab] = useState('migrate_ip');
  const [search, setSearch] = useState('');

  // Smart Public-Astra-IP -> Local Flussonic Link Updater State
  const [hostsSummary, setHostsSummary] = useState({ totalStreams: 0, alreadyOnFlussonicCount: 0, hosts: [] });
  const [filterHost, setFilterHost] = useState('');
  const [localAstraHost, setLocalAstraHost] = useState('192.168.88.10');
  const [flussonicOutUrl, setFlussonicOutUrl] = useState('');
  const [flussonicAuthUser, setFlussonicAuthUser] = useState('admin');
  const [flussonicAuthPass, setFlussonicAuthPass] = useState('');
  const [testingConn, setTestingConn] = useState(false);
  const [localSshCommand, setLocalSshCommand] = useState('');
  const [copiedSsh, setCopiedSsh] = useState(false);
  const [migrateTranscodeMode, setMigrateTranscodeMode] = useState('copy_pure');
  const [migratePullProto, setMigratePullProto] = useState('mpegts');
  const [migrateCloudMode, setMigrateCloudMode] = useState('direct');
  const [previewRows, setPreviewRows] = useState([]);
  const [untouchedCount, setUntouchedCount] = useState(0);
  const [selectedPreviewIds, setSelectedPreviewIds] = useState([]);
  const [previewSearch, setPreviewSearch] = useState('');
  const [migratingLinks, setMigratingLinks] = useState(false);

  // Create Server Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: 'Flussonic 23.12 — Cabecera',
    base_url: 'http://',
    username: 'admin',
    password: '',
    api_token: '',
    astra_url: 'http://192.168.88.10:8000',
    default_pull_protocol: 'mpegts',
    default_transcode_mode: 'copy_pure'
  });

  // flussonic.conf v23.12 Generator & API Push State
  const [genSourceType, setGenSourceType] = useState('panel_streams');
  const [genAstraText, setGenAstraText] = useState('');
  const [genAstraOverrideHost, setGenAstraOverrideHost] = useState('192.168.88.10');
  const [genTranscodeMode, setGenTranscodeMode] = useState('copy_pure');
  const [genVideoKbps, setGenVideoKbps] = useState(2500);
  const [genAudioKbps, setGenAudioKbps] = useState(128);
  const [genConstant247, setGenConstant247] = useState(true);
  const [genIncludeHeader, setGenIncludeHeader] = useState(false);
  const [generatedConf, setGeneratedConf] = useState('');
  const [generatedCount, setGeneratedCount] = useState(0);
  const [copiedConf, setCopiedConf] = useState(false);
  const [pushingApi, setPushingApi] = useState(false);

  // Link to Panel State (Tab 2 & Tab 4)
  const [pullProtocol, setPullProtocol] = useState('mpegts');
  const [cloudLinkMode, setCloudLinkMode] = useState('direct');
  const [pastedFlussConf, setPastedFlussConf] = useState('');
  const [linking, setLinking] = useState(false);

  // TS/HLS -> Flussonic M4F Converter State (Tab 5)
  const [m4fScope, setM4fScope] = useState('all_ts_hls');
  const [m4fFormat, setM4fFormat] = useState('m4f_scheme');
  const [m4fPushFirst, setM4fPushFirst] = useState(true);
  const [m4fTranscodeMode, setM4fTranscodeMode] = useState('copy_pure');
  const [convertingM4f, setConvertingM4f] = useState(false);

  // 3-Stage ProLiant Audio Leveler -> Local Flussonic -> Remote Flussonic #2 (Tab 6)
  const [relayForm, setRelayForm] = useState({
    proliant_lan_url: '',
    trunk_username: 'troncal_flussonic',
    trunk_password: 'proliant247',
    audio_preset: 'ultra_200ch',
    audio_bitrate: '128k',
    proliant_video_mode: 'copy_video_ultralight_200',
    push_local_flussonic: true,
    local_flussonic_url: 'http://192.168.88.20:8080',
    local_flussonic_user: 'admin',
    local_flussonic_pass: '',
    local_flussonic_public_host: '',
    push_remote_flussonic: false,
    remote_flussonic_url: '',
    remote_flussonic_user: 'admin',
    remote_flussonic_pass: ''
  });
  const [runningRelaySetup, setRunningRelaySetup] = useState(false);
  const [relayResult, setRelayResult] = useState(null);

  const selectedServer = servers.find((s) => s.id === selectedId) || servers[0] || null;

  const showToast = (msg) => {
    setErrorNotice('');
    setNotice(msg);
    setTimeout(() => setNotice(''), 9000);
  };

  const showError = (msg) => {
    setNotice('');
    setErrorNotice(msg);
  };

  const loadServersAndHosts = async () => {
    try {
      const [srvRes, hostRes] = await Promise.all([
        apiFetch('/api/flussonic-2312/servers'),
        apiFetch('/api/flussonic-2312/panel-hosts-summary')
      ]);
      const list = srvRes.servers || [];
      setServers(list);
      setTotalPanelStreams(srvRes.totalPanelStreams || 0);
      if (list.length > 0 && !selectedId) {
        setSelectedId(list[0].id);
        if (!flussonicOutUrl) setFlussonicOutUrl(list[0].base_url || '');
        if (list[0].username) setFlussonicAuthUser(list[0].username);
        if (list[0].password || list[0].api_token) {
          setFlussonicAuthPass(list[0].password || list[0].api_token);
        }
      }

      setHostsSummary(hostRes || { totalStreams: 0, alreadyOnFlussonicCount: 0, hosts: [] });
      if (!filterHost && Array.isArray(hostRes?.hosts) && hostRes.hosts.length > 0) {
        // Auto-select the top detected Astra IP!
        setFilterHost(hostRes.hosts[0].hostname);
      }
      if ((srvRes.totalPanelStreams || 0) === 0) {
        setGenSourceType('astra_m3u');
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadServersAndHosts();
    apiFetch('/api/flussonic-2312/proliant-relay-defaults')
      .then((res) => {
        if (res?.ok) {
          setRelayForm((prev) => ({
            ...prev,
            proliant_lan_url: res.proliant_lan_url || prev.proliant_lan_url,
            trunk_username: res.trunk_username || prev.trunk_username,
            trunk_password: res.trunk_password || prev.trunk_password,
            audio_preset: res.audio_preset || prev.audio_preset,
            audio_bitrate: res.audio_bitrate || prev.audio_bitrate
          }));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedServer) {
      if (selectedServer.base_url) setFlussonicOutUrl(selectedServer.base_url);
      if (selectedServer.username !== undefined && selectedServer.username !== '') {
        setFlussonicAuthUser(selectedServer.username);
      }
      if (selectedServer.password || selectedServer.api_token) {
        setFlussonicAuthPass(selectedServer.password || selectedServer.api_token);
      }
    }
  }, [selectedServer?.id]);

  // Refresh live preview whenever filterHost, localAstraHost, flussonicOutUrl, or migratePullProto changes
  const refreshIpPreview = async (hostToUse = filterHost) => {
    if (!hostToUse || !String(hostToUse).trim()) {
      setPreviewRows([]);
      setSelectedPreviewIds([]);
      setUntouchedCount(hostsSummary.totalStreams || 0);
      return;
    }
    try {
      const res = await apiFetch('/api/flussonic-2312/preview-by-ip', {
        method: 'POST',
        body: JSON.stringify({
          filter_host: hostToUse,
          local_astra_host: localAstraHost,
          server_id: selectedServer?.id || null,
          flussonic_base_url: flussonicOutUrl,
          pull_protocol: migratePullProto
        })
      });
      const rows = res.preview || [];
      setPreviewRows(rows);
      setUntouchedCount(res.untouchedCount ?? 0);
      setSelectedPreviewIds(rows.map((r) => r.id));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshIpPreview(filterHost);
  }, [filterHost, localAstraHost, flussonicOutUrl, migratePullProto, selectedServer?.id]);

  const handleCreateServer = async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/flussonic-2312/servers', {
        method: 'POST',
        body: JSON.stringify(createForm)
      });
      setCreateOpen(false);
      await loadServersAndHosts();
      if (res.server?.id) {
        setSelectedId(res.server.id);
        setFlussonicOutUrl(res.server.base_url);
        if (res.server.username) setFlussonicAuthUser(res.server.username);
        if (res.server.password || res.server.api_token) {
          setFlussonicAuthPass(res.server.password || res.server.api_token);
        }
      }
      showToast(`✅ Servidor "${res.server.name}" (Flussonic 23.12) registrado.`);
    } catch (err) {
      showError(err.message);
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
    await loadServersAndHosts();
  };

  const handleTestFlussonicConnection = async () => {
    const cleanOut = String(flussonicOutUrl || selectedServer?.base_url || '').trim();
    if (!cleanOut || cleanOut === 'http://') {
      window.alert('Escribe primero la IP:Puerto de tu Flussonic 23.12 en el Paso 3.');
      return;
    }
    setTestingConn(true);
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/flussonic-2312/test-connection', {
        method: 'POST',
        body: JSON.stringify({
          server_id: selectedServer?.id || null,
          base_url: cleanOut,
          username: flussonicAuthUser,
          password: flussonicAuthPass,
          astra_url: `http://${localAstraHost}`
        })
      });
      await loadServersAndHosts();
      if (res.server?.id) setSelectedId(res.server.id);
      if (res.effectiveBase) setFlussonicOutUrl(res.effectiveBase);
      if (Array.isArray(res.streams)) setLiveStreams(res.streams);
      showToast(
        `✅ API v3 Conectada: Flussonic v${res.version} en ${res.effectiveBase}${
          res.usedLanBridge ? ` (vía Puente LAN ${res.bridgeNodeName})` : ''
        } — ${res.streamCount} streams activos.`
      );
    } catch (err) {
      showError(err.message);
    } finally {
      setTestingConn(false);
    }
  };

  // Generate flussonic.conf ONLY for the selected Public Astra IP channels!
  const handleGenerateFilteredConf = async () => {
    if (selectedPreviewIds.length === 0) {
      window.alert('Selecciona al menos un canal de la IP de Astra para generar su flussonic.conf.');
      return;
    }
    try {
      const res = await apiFetch('/api/flussonic-2312/generate-conf', {
        method: 'POST',
        body: JSON.stringify({
          source_type: 'panel_streams',
          filter_host: filterHost,
          selected_stream_ids: selectedPreviewIds,
          astra_override_host: localAstraHost,
          transcode_mode: migrateTranscodeMode,
          video_bitrate_kbps: genVideoKbps,
          audio_bitrate_kbps: genAudioKbps,
          constant_247: true,
          include_global_header: false
        })
      });
      setGeneratedConf(res.confText || '');
      setGeneratedCount(res.channelCount || 0);
      showToast(
        `📄 flussonic.conf v23.12 generado SOLO para tus ${res.channelCount} canales de Astra (con IP local ${localAstraHost}).`
      );
    } catch (err) {
      showError(err.message);
    }
  };

  // Push ONLY the selected Public Astra IP channels to Flussonic 23.12 via OpenAPI v3 (works directly from Paso 3!)
  const handlePushFilteredToFlussonicApi = async () => {
    const cleanOut = String(flussonicOutUrl || selectedServer?.base_url || '').trim();
    if (!cleanOut || cleanOut === 'http://') {
      window.alert(
        'Escribe la IP:Puerto de tu Flussonic 23.12 en el Paso 3 (o usa el botón "1C. Push SSH Local" si tu Flussonic no tiene puerto abierto).'
      );
      return;
    }
    if (selectedPreviewIds.length === 0) {
      window.alert('No hay canales seleccionados para enviar a Flussonic 23.12.');
      return;
    }
    setPushingApi(true);
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/flussonic-2312/push-streams-direct', {
        method: 'POST',
        body: JSON.stringify({
          server_id: selectedServer?.id || null,
          base_url: cleanOut,
          username: flussonicAuthUser,
          password: flussonicAuthPass,
          source_type: 'panel_streams',
          filter_host: filterHost,
          selected_stream_ids: selectedPreviewIds,
          astra_override_host: localAstraHost,
          transcode_mode: migrateTranscodeMode,
          video_bitrate_kbps: genVideoKbps,
          audio_bitrate_kbps: genAudioKbps,
          constant_247: true
        })
      });
      await loadServersAndHosts();
      if (res.server?.id) setSelectedId(res.server.id);
      if (res.effectiveBase) setFlussonicOutUrl(res.effectiveBase);
      const fbNote =
        res.passthroughFallbackCount > 0
          ? ` (${res.passthroughFallbackCount} en Copy/Copy por licencia de transcoder)`
          : '';
      const errNote =
        Array.isArray(res.errors) && res.errors.length > 0 ? ` | Avisos: ${res.errors.slice(0, 2).join('; ')}` : '';
      showToast(
        `🚀 ${res.pushedCount}/${res.totalAttempted} canales creados en Flussonic 23.12 (${res.effectiveBase}) leyendo localmente de ${localAstraHost}${fbNote}${errNote}`
      );
    } catch (err) {
      showError(err.message);
    } finally {
      setPushingApi(false);
    }
  };

  // Generate 1-line SSH command to push via API v3 directly on 127.0.0.1 inside a NATed local Flussonic server
  const handlePrepareLocalSshPush = async (sourceOverride = 'panel_streams') => {
    if (sourceOverride === 'panel_streams' && selectedPreviewIds.length === 0) {
      window.alert('Selecciona al menos un canal de Astra para generar el comando SSH local.');
      return;
    }
    try {
      const res = await apiFetch('/api/flussonic-2312/prepare-local-push-script', {
        method: 'POST',
        body: JSON.stringify({
          source_type: sourceOverride,
          filter_host: filterHost,
          selected_stream_ids: selectedPreviewIds,
          astra_content: genAstraText,
          astra_override_host: sourceOverride === 'astra_m3u' ? genAstraOverrideHost : localAstraHost,
          transcode_mode: sourceOverride === 'astra_m3u' ? genTranscodeMode : migrateTranscodeMode,
          video_bitrate_kbps: genVideoKbps,
          audio_bitrate_kbps: genAudioKbps,
          constant_247: sourceOverride === 'astra_m3u' ? genConstant247 : true,
          username: flussonicAuthUser,
          password: flussonicAuthPass
        })
      });
      setLocalSshCommand(res.sshCommand || '');
      showToast(
        `💻 Comando SSH de 1 línea listo para inyectar ${res.channelCount} canales por API v3 (127.0.0.1) directo dentro de tu Flussonic local.`
      );
    } catch (err) {
      showError(err.message);
    }
  };

  const handlePushM3uToFlussonicApi = async () => {
    const cleanOut = String(flussonicOutUrl || selectedServer?.base_url || '').trim();
    if (!cleanOut || cleanOut === 'http://') {
      window.alert('Primero registra o escribe la IP:Puerto de tu Flussonic 23.12.');
      return;
    }
    if (!genAstraText.trim()) {
      window.alert('Sube o pega primero el archivo playlist.txt / .m3u de Astra.');
      return;
    }
    setPushingApi(true);
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/flussonic-2312/push-streams-direct', {
        method: 'POST',
        body: JSON.stringify({
          server_id: selectedServer?.id || null,
          base_url: cleanOut,
          username: flussonicAuthUser,
          password: flussonicAuthPass,
          source_type: 'astra_m3u',
          astra_content: genAstraText,
          astra_override_host: genAstraOverrideHost,
          transcode_mode: genTranscodeMode,
          video_bitrate_kbps: genVideoKbps,
          audio_bitrate_kbps: genAudioKbps,
          constant_247: genConstant247
        })
      });
      await loadServersAndHosts();
      showToast(`🚀 ${res.pushedCount}/${res.totalAttempted} canales del M3U creados en Flussonic 23.12 por API v3.`);
    } catch (err) {
      showError(err.message);
    } finally {
      setPushingApi(false);
    }
  };

  // Update ONLY the links of the matched Public Astra IP channels in-place (preserving IDs, categories, order, bouquets!)
  const handleMigrateLinksInPlace = async ({ limitCount = 0, alsoPush = false } = {}) => {
    const cleanOut = String(flussonicOutUrl || selectedServer?.base_url || '').trim();
    if (!cleanOut || cleanOut === 'http://') {
      window.alert(
        'Escribe la IP:Puerto de tu Flussonic 23.12 (ej. http://IP_PUBLICA_FLUSSONIC:8080) en el Paso 3 para construir los nuevos links.'
      );
      return;
    }
    if (selectedPreviewIds.length === 0) {
      window.alert('Selecciona al menos un canal de la lista filtrada.');
      return;
    }

    setMigratingLinks(true);
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/flussonic-2312/migrate-links-by-ip', {
        method: 'POST',
        body: JSON.stringify({
          server_id: selectedServer?.id || null,
          flussonic_base_url: cleanOut,
          username: flussonicAuthUser,
          password: flussonicAuthPass,
          filter_host: filterHost,
          selected_stream_ids: selectedPreviewIds,
          local_astra_host: localAstraHost,
          pull_protocol: migratePullProto,
          cloud_mode: migrateCloudMode,
          also_push_to_flussonic: alsoPush,
          transcode_mode: migrateTranscodeMode,
          video_bitrate_kbps: genVideoKbps,
          audio_bitrate_kbps: genAudioKbps,
          constant_247: true,
          limit_count: limitCount
        })
      });
      await loadServersAndHosts();
      if (res.server?.id) setSelectedId(res.server.id);
      await refreshIpPreview(filterHost);
      showToast(
        `✅ ${res.updatedLinksCount} links actualizados a Flussonic 23.12${
          alsoPush ? ` (${res.pushedToFlussonicCount} enviados por API v3)` : ''
        } conservando IDs, nombres, orden y categorías (${res.untouchedCount} canales de otras IPs quedaron intactos).`
      );
    } catch (err) {
      showError(err.message);
    } finally {
      setMigratingLinks(false);
    }
  };

  const handleRevertToOriginalAstra = async () => {
    if (
      !window.confirm(
        '¿Restaurar los canales migrados a Flussonic de vuelta a sus links originales TS/HLS/Astra?'
      )
    ) {
      return;
    }
    try {
      const res = await apiFetch('/api/flussonic-2312/revert-links', {
        method: 'POST',
        body: JSON.stringify({ scope: 'all_flussonic' })
      });
      await loadServersAndHosts();
      await refreshIpPreview(filterHost);
      showToast(`↩️ ${res.revertedCount} canales restaurados intactos a sus links TS/HLS originales.`);
    } catch (err) {
      window.alert(err.message);
    }
  };

  const handleConvertTsHlsToM4f = async (e) => {
    e.preventDefault();
    setConvertingM4f(true);
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/flussonic-2312/convert-ts-hls-to-m4f', {
        method: 'POST',
        body: JSON.stringify({
          server_id: selectedServer?.id || null,
          base_url: flussonicOutUrl || selectedServer?.base_url || '',
          username: flussonicAuthUser || selectedServer?.username || 'admin',
          password: flussonicAuthPass || '',
          scope: m4fScope,
          filter_host: filterHost,
          m4f_format: m4fFormat,
          push_to_flussonic: m4fPushFirst,
          transcode_mode: m4fTranscodeMode,
          astra_override_host: m4fScope === 'by_host' ? localAstraHost : '',
          keep_original_as_backup: true
        })
      });
      await loadServersAndHosts();
      showToast(
        `⚡ ¡Listo! ${res.convertedCount} canales TS/HLS convertidos a ${
          res.m4fFormat === 'm4f_scheme' ? 'm4f:// nativo' : 'CMAF index.fmp4.m3u8'
        } de Flussonic 23.12${
          m4fPushFirst ? ` (${res.pushedCount} creados en Flussonic API v3)` : ''
        }. Ejemplo: ${res.sampleM4fUrl}`
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setConvertingM4f(false);
    }
  };

  const handleSetupProliantLeveledRelay = async (e) => {
    e.preventDefault();
    setRunningRelaySetup(true);
    setErrorNotice('');
    try {
      const res = await apiFetch('/api/flussonic-2312/setup-proliant-leveled-relay', {
        method: 'POST',
        body: JSON.stringify(relayForm)
      });
      setRelayResult(res);
      await loadServersAndHosts();
      showToast(
        `🎚️ ¡Cadena activa! ${res.leveledStreamsCount} canales nivelando audio 24/7 en el ProLiant${
          res.localPushedCount ? `, ${res.localPushedCount} enviados a Flussonic Local` : ''
        }${res.remotePushedCount ? ` y ${res.remotePushedCount} enlazados en Flussonic #2 vía M4F` : ''}.`
      );
    } catch (err) {
      setErrorNotice(err.message);
    } finally {
      setRunningRelaySetup(false);
    }
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
      await loadServersAndHosts();
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
      showToast(
        action === 'delete'
          ? `🗑️ Stream ${streamName} eliminado.`
          : `🔄 Stream ${streamName} reiniciado en Flussonic 23.12.`
      );
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

  const handleGenerateConf = async (sourceOverride = null) => {
    try {
      const effectiveSource = sourceOverride || genSourceType;
      const res = await apiFetch('/api/flussonic-2312/generate-conf', {
        method: 'POST',
        body: JSON.stringify({
          source_type: effectiveSource,
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
      showToast(
        `✅ flussonic.conf v23.12 generado para ${res.channelCount} canales (${genConstant247 ? '24/7 Constante' : 'On-Demand'}).`
      );
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
      await loadServersAndHosts();
      showToast(
        `✅ Flussonic 23.12 vinculado al Panel TVLister: ${res.updatedCount} canales existentes enlazados sin duplicar + ${res.insertedCount} nuevos.`
      );
    } catch (err) {
      window.alert(err.message);
    } finally {
      setLinking(false);
    }
  };

  const visiblePreviewRows = previewRows.filter((r) => {
    if (!previewSearch.trim()) return true;
    const q = previewSearch.toLowerCase();
    return (
      String(r.name || '').toLowerCase().includes(q) ||
      String(r.flussonic_key || '').toLowerCase().includes(q) ||
      String(r.origin_astra_url || '').toLowerCase().includes(q)
    );
  });

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
            FLUSSONIC MEDIA SERVER v23.12 · MIGRACIÓN INTELIGENTE POR IP DE ASTRA (SOLO ACTUALIZAR LINKS)
          </div>
          <h1 className="text-xl font-bold text-white">
            Flussonic 23.12 — Pasar Solo Canales de Astra Público a Flussonic Local sin Perder tu Lista
          </h1>
          <p className="text-xs text-slate-300 max-w-3xl leading-relaxed">
            Filtra de tu lista actual <strong>únicamente los canales con la IP de tu Astra Público</strong>, envíalos a tu{' '}
            <strong>Flussonic 23.12 local</strong> leyendo desde <code className="text-cyan-300">tshttp://192.168.88.10:...</code> y{' '}
            <strong>actualiza solo sus links</strong> conservando IDs, nombres, categorías, logos, EPG, orden y dejando intactos tus demás canales.
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

      {errorNotice && (
        <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/45 text-xs text-rose-100 space-y-2">
          <div className="font-bold text-rose-300">⚠️ Diagnóstico Push API v3 Flussonic 23.12:</div>
          <div className="leading-relaxed">{errorNotice}</div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => handlePrepareLocalSshPush('panel_streams')}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold"
            >
              💻 Generar Comando SSH Local (1 Línea) sin abrir puertos
            </button>
            <button
              type="button"
              onClick={() => setErrorNotice('')}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px]"
            >
              Cerrar aviso
            </button>
          </div>
        </div>
      )}

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveSubTab('migrate_ip')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border transition ${
              activeSubTab === 'migrate_ip'
                ? 'bg-gradient-to-r from-violet-600 to-cyan-600 text-white border-cyan-400 shadow-lg shadow-violet-950/50'
                : 'bg-[#0e1526] text-slate-300 border-slate-800 hover:border-slate-600'
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            1. Migrar Solo IP Astra → Flussonic Local (Solo Actualizar Links)
          </button>
          <button
            onClick={() => setActiveSubTab('live')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border transition ${
              activeSubTab === 'live'
                ? 'bg-violet-600 text-white border-violet-400'
                : 'bg-[#0e1526] text-slate-300 border-slate-800 hover:border-slate-600'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            2. Monitor API v3 en Vivo
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
            3. Generador desde Archivo M3U Externo
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
            4. Pegar flussonic.conf
          </button>
          <button
            onClick={() => setActiveSubTab('ts_hls_to_m4f')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border transition ${
              activeSubTab === 'ts_hls_to_m4f'
                ? 'bg-amber-600 text-white border-amber-400 shadow-lg shadow-amber-950/50'
                : 'bg-[#0e1526] text-amber-300 border-amber-500/40 hover:border-amber-400'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            5. Pasar Streams TS / HLS → M4F Flussonic
          </button>
          <button
            onClick={() => setActiveSubTab('proliant_relay')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border transition ${
              activeSubTab === 'proliant_relay'
                ? 'bg-gradient-to-r from-emerald-600 to-cyan-600 text-white border-emerald-400 shadow-lg shadow-emerald-950/50'
                : 'bg-[#0e1526] text-emerald-300 border-emerald-500/40 hover:border-emerald-400'
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            6. ProLiant (Nivelar Audio) → Flussonic Local → Flussonic #2
          </button>
        </div>

        <div className="flex items-center gap-2">
          {hostsSummary.alreadyOnFlussonicCount > 0 && (
            <button
              onClick={handleRevertToOriginalAstra}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-amber-500/35 text-xs font-bold"
              title="Restaura los links originales del Astra Público en 1 clic"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Revertir Links a Astra Público ({hostsSummary.alreadyOnFlussonicCount})
            </button>
          )}
          {selectedServer && (
            <button
              onClick={() => handleSyncLive()}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Consultando API v3...' : 'Sincronizar API v3'}
            </button>
          )}
        </div>
      </div>

      {/* ==================== TAB 1 (DEFAULT): SMART PUBLIC ASTRA IP -> LOCAL FLUSSONIC LINK UPDATER ==================== */}
      {activeSubTab === 'migrate_ip' && (
        <div className="space-y-4">
          {/* Safety Guarantee Banner */}
          <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              <div className="text-xs text-emerald-100 space-y-0.5">
                <div className="font-bold text-emerald-300">
                  Protección Total de tu Lista Actual Activada (Cero canales borrados · Cero duplicados)
                </div>
                <p className="text-emerald-200/85">
                  De tus <strong>{hostsSummary.totalStreams}</strong> canales actuales, se seleccionaron{' '}
                  <strong className="text-white underline">{selectedPreviewIds.length} canales</strong> con la IP de Astra{' '}
                  <code className="text-cyan-300">{filterHost || '—'}</code>. Tus otros{' '}
                  <strong className="text-emerald-300">{untouchedCount} canales</strong> de otros proveedores{' '}
                  <strong>NO SE TOCAN</strong>, y en estos {selectedPreviewIds.length} canales{' '}
                  <strong>solo se actualiza el link</strong> conservando IDs, orden, categorías, logos, EPG y bouquets.
                </p>
              </div>
            </div>
          </div>

          {/* 3-Step Configuration Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Step 1: Select Public Astra IP from existing list */}
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4 space-y-2.5">
              <div className="text-xs font-bold text-violet-300">
                Paso 1 · Elegir IP de tu Astra Público en tu Lista Actual
              </div>
              <select
                value={filterHost}
                onChange={(e) => setFilterHost(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white font-semibold"
              >
                <option value="">— Selecciona una IP detectada en tu lista —</option>
                {hostsSummary.hosts.map((h) => (
                  <option key={h.hostname} value={h.hostname}>
                    {h.isAstraPattern ? '📡 ' : '🌐 '}
                    {h.hostname} ({h.count} canales — ej: {h.sampleName})
                  </option>
                ))}
              </select>
              <div>
                <span className="text-[11px] text-slate-400 block mb-1">
                  O escribe manualmente la IP / IP:Puerto del Astra Público a filtrar:
                </span>
                <input
                  type="text"
                  value={filterHost}
                  onChange={(e) => setFilterHost(e.target.value)}
                  placeholder="Ej: 190.12.34.56 o 190.12.34.56:8000"
                  className="w-full px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-cyan-300 font-mono"
                />
              </div>
            </div>

            {/* Step 2: Local LAN Astra IP inside Flussonic network */}
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4 space-y-2.5">
              <div className="text-xs font-bold text-cyan-300">
                Paso 2 · IP Local del Astra para tu Flussonic 23.12
              </div>
              <div>
                <span className="text-[11px] text-slate-400 block mb-1">
                  IP LAN del Astra (conserva el puerto :8000/:8001 de cada canal automáticamente):
                </span>
                <input
                  type="text"
                  value={localAstraHost}
                  onChange={(e) => setLocalAstraHost(e.target.value)}
                  placeholder="192.168.88.10"
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-emerald-300 font-mono font-bold"
                />
              </div>
              <div>
                <span className="text-[11px] text-slate-400 block mb-1">
                  Perfil en Flussonic 23.12 (24/7 estático constante):
                </span>
                <select
                  value={migrateTranscodeMode}
                  onChange={(e) => setMigrateTranscodeMode(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white"
                >
                  <option value="copy_pure">
                    ⚡ Copy/Copy Puro Passthrough (Sin Transcoding · 0% CPU en Flussonic)
                  </option>
                  <option value="copy_video_aac">
                    🔊 Copy Video (vb=copy) + Audio AAC 48k Estéreo
                  </option>
                  <option value="copy_deint_aac">
                    🛡️ Anti-Rayas (deinterlace=true) + CPU x264 + Audio AAC 48k
                  </option>
                  <option value="nvenc_deint_aac">
                    🟢 NVIDIA NVENC + Anti-Rayas + Audio AAC 48k
                  </option>
                </select>
              </div>
            </div>

            {/* Step 3: Flussonic Output URL + Inline API v3 Auth */}
            <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-bold text-emerald-300">
                  Paso 3 · URL y Credenciales API v3 de tu Flussonic 23.12
                </div>
                <button
                  type="button"
                  disabled={testingConn}
                  onClick={handleTestFlussonicConnection}
                  className="px-2.5 py-1 rounded-lg bg-violet-600/30 hover:bg-violet-600/50 border border-violet-400/40 text-[11px] font-bold text-violet-100"
                >
                  {testingConn ? 'Probando...' : '🔍 Probar API v3'}
                </button>
              </div>
              <div>
                <span className="text-[11px] text-slate-400 block mb-1">
                  IP:Puerto de Flussonic accesible por el Panel (o LAN si tienes Nodo ProLiant):
                </span>
                <input
                  type="text"
                  value={flussonicOutUrl}
                  onChange={(e) => setFlussonicOutUrl(e.target.value)}
                  placeholder="http://IP_PUBLICA_FLUSSONIC:8080"
                  className="w-full px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={flussonicAuthUser}
                  onChange={(e) => setFlussonicAuthUser(e.target.value)}
                  placeholder="Usuario edit_auth (admin)"
                  className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-[11px] text-white"
                />
                <input
                  type="password"
                  value={flussonicAuthPass}
                  onChange={(e) => setFlussonicAuthPass(e.target.value)}
                  placeholder="Contraseña o cluster_key"
                  className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-[11px] text-white"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={migratePullProto}
                  onChange={(e) => setMigratePullProto(e.target.value)}
                  className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-[11px] text-white"
                >
                  <option value="mpegts">Salida /key/mpegts (24/7 TS)</option>
                  <option value="cmaf">Salida /key/index.fmp4.m3u8 (M4F / CMAF)</option>
                  <option value="m4f_scheme">Esquema m4f://IP:Puerto/key</option>
                  <option value="hls">Salida /key/index.m3u8 (HLS)</option>
                </select>
                <select
                  value={migrateCloudMode}
                  onChange={(e) => setMigrateCloudMode(e.target.value)}
                  className="px-2.5 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-[11px] text-white"
                >
                  <option value="direct">🚀 Nube: Direct Relay (Sin Transcoding · 0% FFmpeg)</option>
                  <option value="constant_copy_247">⚡ Nube: 24/7 Copy/Copy Local</option>
                  <option value="constant_copy_audio_247">🔊 Nube: 24/7 Copy+Audio Igual</option>
                </select>
              </div>
            </div>
          </div>

          {/* Action Bar: Configure Local Flussonic + Update Links Only */}
          <div className="rounded-2xl bg-[#0e1526] border border-violet-500/35 p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleGenerateFilteredConf}
                disabled={selectedPreviewIds.length === 0}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-bold transition"
              >
                <FileCode className="w-4 h-4" />
                1A. Generar flussonic.conf ({selectedPreviewIds.length})
              </button>
              <button
                type="button"
                onClick={handlePushFilteredToFlussonicApi}
                disabled={pushingApi || selectedPreviewIds.length === 0}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-bold transition shadow-md shadow-violet-950/40"
              >
                <Send className="w-3.5 h-3.5" />
                {pushingApi ? 'Enviando API v3...' : `1B. Push API v3 a Flussonic (${selectedPreviewIds.length})`}
              </button>
              <button
                type="button"
                onClick={() => handlePrepareLocalSshPush('panel_streams')}
                disabled={selectedPreviewIds.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-emerald-500/35 disabled:opacity-40 text-emerald-300 text-xs font-bold transition"
                title="Si tu Flussonic 23.12 está detrás de NAT MikroTik sin puerto público de administración, ejecuta 1 línea por SSH dentro de Flussonic"
              >
                💻 1C. Push SSH Local (NAT)
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={migratingLinks || selectedPreviewIds.length === 0}
                onClick={() => handleMigrateLinksInPlace({ limitCount: 3, alsoPush: false })}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 disabled:opacity-40 text-amber-200 text-xs font-bold"
                title="Actualiza solo los primeros 3 canales seleccionados para probar primero sin riesgo"
              >
                🧪 Probar con 3 Canales
              </button>
              <button
                type="button"
                disabled={migratingLinks || selectedPreviewIds.length === 0}
                onClick={() => handleMigrateLinksInPlace({ limitCount: 0, alsoPush: false })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold shadow-lg shadow-emerald-950/50"
              >
                <Link2 className="w-4 h-4" />
                {migratingLinks
                  ? 'Actualizando Links...'
                  : `2. Solo Actualizar Links (${selectedPreviewIds.length})`}
              </button>
              <button
                type="button"
                disabled={migratingLinks || selectedPreviewIds.length === 0}
                onClick={() => handleMigrateLinksInPlace({ limitCount: 0, alsoPush: true })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-xs font-bold"
              >
                <Zap className="w-4 h-4" />
                Todo en 1 Clic (Push API v3 + Actualizar Links)
              </button>
            </div>
          </div>

          {/* 1-Line Local SSH Push Command Box (works behind any MikroTik NAT without opening Flussonic admin port) */}
          {localSshCommand && (
            <div className="rounded-2xl bg-[#071318] border border-emerald-500/45 p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-emerald-300">
                  💻 Push API v3 Local (127.0.0.1) — Pega esta línea en el SSH de tu servidor Flussonic 23.12 (detecta puerto y edit_auth automáticamente):
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(localSshCommand);
                    setCopiedSsh(true);
                    setTimeout(() => setCopiedSsh(false), 2500);
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs text-white font-bold"
                >
                  {copiedSsh ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedSsh ? 'Comando Copiado' : 'Copiar Comando SSH'}
                </button>
              </div>
              <pre className="p-3 rounded-xl bg-[#050b10] border border-slate-800 text-xs font-mono text-emerald-200 overflow-x-auto">
                {localSshCommand}
              </pre>
            </div>
          )}

          {/* Generated Filtered flussonic.conf Box (if user clicked 1A) */}
          {generatedConf && (
            <div className="rounded-2xl bg-[#0b1020] border border-cyan-500/40 p-4 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-cyan-300">
                  ✅ Bloques para pegar en /etc/flussonic/flussonic.conf ({generatedCount} canales locales hacia{' '}
                  {localAstraHost}) — luego ejecuta <code className="text-emerald-300">service flussonic reload</code>:
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
                    {copiedConf ? 'Copiado' : 'Copiar bloques'}
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
              <pre className="p-3.5 rounded-xl bg-[#070b14] border border-slate-800 text-[11px] font-mono text-cyan-200 max-h-72 overflow-auto whitespace-pre">
                {generatedConf}
              </pre>
            </div>
          )}

          {/* Before / Local Flussonic / New Panel Link Preview Table */}
          <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-xs font-bold text-white">
                Vista Previa Exacta de Canales Filtrados ({selectedPreviewIds.length} seleccionados de{' '}
                {previewRows.length} con IP <code className="text-cyan-300">{filterHost || '—'}</code>)
              </div>
              <input
                type="text"
                value={previewSearch}
                onChange={(e) => setPreviewSearch(e.target.value)}
                placeholder="Buscar canal en esta vista previa..."
                className="px-3 py-1.5 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white min-w-[230px]"
              />
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-800 max-h-[460px]">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#090e1a] text-slate-400 uppercase sticky top-0">
                  <tr>
                    <th className="px-3 py-2.5 w-10">
                      <input
                        type="checkbox"
                        checked={
                          visiblePreviewRows.length > 0 &&
                          visiblePreviewRows.every((r) => selectedPreviewIds.includes(r.id))
                        }
                        onChange={() => {
                          const visIds = visiblePreviewRows.map((r) => r.id);
                          const allIn = visIds.every((id) => selectedPreviewIds.includes(id));
                          setSelectedPreviewIds((prev) =>
                            allIn ? prev.filter((id) => !visIds.includes(id)) : Array.from(new Set([...prev, ...visIds]))
                          );
                        }}
                        className="rounded accent-violet-500"
                      />
                    </th>
                    <th className="px-3 py-2.5">ID / Canal (Se conserva)</th>
                    <th className="px-3 py-2.5">Origen Astra Público</th>
                    <th className="px-3 py-2.5">Entrada Local en Flussonic 23.12</th>
                    <th className="px-3 py-2.5">Nuevo Link en Tu Lista TVLister</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {visiblePreviewRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                        Selecciona arriba la IP de tu Astra Público para previsualizar exactamente qué canales actualizarán su link.
                      </td>
                    </tr>
                  ) : (
                    visiblePreviewRows.map((r) => (
                      <tr key={r.id} className="hover:bg-slate-800/30">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedPreviewIds.includes(r.id)}
                            onChange={() =>
                              setSelectedPreviewIds((prev) =>
                                prev.includes(r.id) ? prev.filter((x) => x !== r.id) : [...prev, r.id]
                              )
                            }
                            className="rounded accent-violet-500"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-semibold text-white">
                            <span className="font-mono text-sky-400 mr-1.5">#{r.id}</span>
                            {r.name}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {r.category_name} · key: <code className="text-violet-300">{r.flussonic_key}</code>
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-amber-200/90 max-w-[230px] truncate">
                          {r.origin_astra_url}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-cyan-300 max-w-[240px] truncate">
                          {r.flussonic_local_input}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-emerald-300 max-w-[260px] truncate">
                          {r.new_panel_link}
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

      {/* ==================== TAB 2: LIVE MONITOR API v3 ==================== */}
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
                  Registra la IP/puerto y credenciales <code className="text-violet-300">edit_auth</code> de tu Flussonic 23.12 para monitorear bitrates, clientes y reiniciar canales vía REST API v3.
                </p>
              </div>
              <button
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold"
              >
                <Plus className="w-4 h-4" />
                Registrar Servidor Flussonic 23.12
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="p-4 rounded-2xl bg-[#0e1526] border border-slate-800">
                  <div className="text-[11px] text-slate-400">Servidor Flussonic</div>
                  <div className="text-base font-bold text-white mt-0.5 truncate">{selectedServer.base_url}</div>
                  <div className="text-[11px] text-violet-300 font-mono mt-1">
                    v{selectedServer.version || '23.12'} · {selectedServer.status === 'online' ? '🟢 EN LÍNEA' : '⚪ SIN SONDEAR'}
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
                  <div className="text-[11px] text-slate-400 mt-1">
                    <button onClick={handleDeleteServer} className="text-rose-400 hover:underline">
                      Desvincular servidor
                    </button>
                  </div>
                </div>
                <div className="p-4 rounded-2xl bg-[#0e1526] border border-violet-500/30 space-y-2">
                  <div className="text-[11px] text-violet-200 font-bold">Enlazar Todos de Flussonic:</div>
                  <select
                    value={cloudLinkMode}
                    onChange={(e) => setCloudLinkMode(e.target.value)}
                    className="w-full px-2 py-1 rounded-lg bg-[#090e1a] border border-slate-700 text-[11px] text-white"
                  >
                    <option value="direct">🚀 Direct Relay (Sin Transcoding · 0% FFmpeg)</option>
                    <option value="constant_copy_247">⚡ 24/7 Constante Copy/Copy</option>
                    <option value="constant_copy_audio_247">🔊 24/7 Copy + Nivelador Audio</option>
                    <option value="ondemand">🌱 On-Demand</option>
                  </select>
                  <button
                    onClick={() => handleLinkToPanel(false)}
                    disabled={linking}
                    className="w-full py-1.5 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-bold flex items-center justify-center gap-1"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    {linking ? 'Vinculando...' : 'Vincular al Panel 24/7'}
                  </button>
                </div>
              </div>

              <div className="rounded-2xl bg-[#0e1526] border border-slate-800 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar stream en Flussonic 23.12..."
                    className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-xs text-white min-w-[260px]"
                  />
                  <select
                    value={pullProtocol}
                    onChange={(e) => setPullProtocol(e.target.value)}
                    className="px-2.5 py-1.5 rounded-lg bg-[#090e1a] border border-slate-700 text-white text-xs"
                  >
                    <option value="mpegts">HTTP MPEG-TS (/nombre/mpegts — 24/7)</option>
                    <option value="cmaf">M4F / CMAF fMP4 (/nombre/index.fmp4.m3u8)</option>
                    <option value="m4f_scheme">Esquema m4f:// (/nombre)</option>
                    <option value="hls">HLS (/nombre/index.m3u8)</option>
                  </select>
                </div>

                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#090e1a] text-slate-400 uppercase">
                      <tr>
                        <th className="px-3 py-2.5">Key Flussonic</th>
                        <th className="px-3 py-2.5">Canal</th>
                        <th className="px-3 py-2.5">Entrada (Astra Local)</th>
                        <th className="px-3 py-2.5">Modo</th>
                        <th className="px-3 py-2.5">Bitrate</th>
                        <th className="px-3 py-2.5 text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {filteredLive.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                            Pulsa &laquo;Sincronizar API v3&raquo; arriba para listar tus streams activos de Flussonic 23.12.
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
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/15 text-cyan-300">
                                {st.static ? '24/7 ESTÁTICO' : 'ON-DEMAND'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-emerald-300">
                              {st.alive ? `${st.bitrate_kbps} kbps` : 'OFFLINE'}
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
                              >
                                <Play className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleStreamAction(st.name, 'restart')}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300"
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleStreamAction(st.name, 'delete')}
                                className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
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

      {/* ==================== TAB 3: EXTERNAL M3U FLUSSONIC.CONF GENERATOR ==================== */}
      {activeSubTab === 'generator' && (
        <div className="rounded-2xl bg-[#0e1526] border border-cyan-500/30 p-5 space-y-4">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <FileCode className="w-4 h-4 text-cyan-400" />
            Generador /etc/flussonic/flussonic.conf v23.12 desde Archivo playlist.txt / .m3u
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2">
              <label className="text-xs font-bold text-slate-200 block">IP LAN Astra Destino</label>
              <input
                type="text"
                value={genAstraOverrideHost}
                onChange={(e) => setGenAstraOverrideHost(e.target.value)}
                placeholder="192.168.88.10"
                className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-xs text-cyan-300 font-mono"
              />
            </div>
            <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 space-y-2">
              <label className="text-xs font-bold text-slate-200 block">Modo en Flussonic 23.12</label>
              <select
                value={genTranscodeMode}
                onChange={(e) => setGenTranscodeMode(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-xs text-white"
              >
                <option value="copy_pure">⚡ Copy/Copy Puro Passthrough (Sin Transcoding · 0% CPU)</option>
                <option value="copy_video_aac">🔊 Copy Video (vb=copy) + Audio AAC 48k</option>
                <option value="copy_deint_aac">🛡️ Anti-Rayas + CPU x264 + Audio AAC 48k</option>
                <option value="nvenc_deint_aac">🟢 NVIDIA NVENC + Anti-Rayas + AAC</option>
              </select>
            </div>
            <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800 flex flex-col justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-emerald-300 font-bold cursor-pointer">
                <input
                  type="checkbox"
                  checked={genConstant247}
                  onChange={(e) => setGenConstant247(e.target.checked)}
                  className="rounded accent-emerald-500"
                />
                24/7 Constante (`stream` estático)
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleGenerateConf('astra_m3u')}
                  className="flex-1 py-2 px-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold"
                >
                  Generar .conf
                </button>
                <button
                  type="button"
                  disabled={pushingApi}
                  onClick={handlePushM3uToFlussonicApi}
                  className="flex-1 py-2 px-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-bold"
                >
                  {pushingApi ? 'Enviando...' : 'Push API v3'}
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-300">Sube o pega tu archivo playlist.txt / .m3u de Astra:</span>
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
              rows={5}
              value={genAstraText}
              onChange={(e) => setGenAstraText(e.target.value)}
              className="w-full p-3 rounded-xl bg-[#090e1a] border border-slate-700 text-xs font-mono text-slate-200"
            />
          </div>

          {generatedConf && (
            <pre className="p-4 rounded-xl bg-[#070b14] border border-slate-800 text-[11px] font-mono text-cyan-200 max-h-80 overflow-auto whitespace-pre">
              {generatedConf}
            </pre>
          )}
        </div>
      )}

      {/* ==================== TAB 4: IMPORT EXISTING FLUSSONIC.CONF ==================== */}
      {activeSubTab === 'import_conf' && (
        <div className="rounded-2xl bg-[#0e1526] border border-emerald-500/30 p-5 space-y-4">
          <h2 className="text-sm font-bold text-white">
            Enlazar desde un archivo /etc/flussonic/flussonic.conf existente sin duplicar canales
          </h2>
          <textarea
            rows={8}
            value={pastedFlussConf}
            onChange={(e) => setPastedFlussConf(e.target.value)}
            placeholder={'stream a0ek {\n  title "A&E";\n  input tshttp://192.168.88.10:8000/play/a0ek?ts;\n}'}
            className="w-full p-3 rounded-xl bg-[#090e1a] border border-slate-700 text-xs font-mono text-slate-200"
          />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={linking || !pastedFlussConf.trim()}
              onClick={() => handleLinkToPanel(true)}
              className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold"
            >
              {linking ? 'Vinculando...' : 'Vincular 24/7 sin Duplicar'}
            </button>
          </div>
        </div>
      )}

      {activeSubTab === 'ts_hls_to_m4f' && (
        <form
          onSubmit={handleConvertTsHlsToM4f}
          className="rounded-2xl bg-[#0e1526] border border-amber-500/40 p-5 space-y-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-400" />
                Conversor 1-Clic: Pasar tus Streams MPEG-TS (`.ts`) y HLS (`.m3u8`) a `M4F` de Flussonic 23.12
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Envía tus canales actuales TS o HLS a tu servidor Flussonic 23.12 (en modo <strong>Copy Puro 0% CPU</strong> o con transcodificador), Flussonic los empaqueta en vivo a <strong>M4F (`m4f://` / CMAF)</strong> y este panel actualiza sus links automáticamente conservando el link TS/HLS original como respaldo.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div>
              <label className="text-slate-300 font-semibold block mb-1">
                URL de tu Flussonic 23.12 (donde saldrá el M4F)
              </label>
              <input
                type="text"
                placeholder="http://IP_FLUSSONIC:8080"
                value={flussonicOutUrl || selectedServer?.base_url || ''}
                onChange={(e) => setFlussonicOutUrl(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
              />
            </div>
            <div>
              <label className="text-slate-300 font-semibold block mb-1">Usuario Flussonic (edit_auth)</label>
              <input
                type="text"
                value={flussonicAuthUser}
                onChange={(e) => setFlussonicAuthUser(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
            <div>
              <label className="text-slate-300 font-semibold block mb-1">Contraseña / Cluster Key</label>
              <input
                type="password"
                placeholder="Contraseña edit_auth o cluster_key"
                value={flussonicAuthPass}
                onChange={(e) => setFlussonicAuthPass(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div>
              <label className="text-slate-300 font-semibold block mb-1">¿Qué canales TS/HLS convertir?</label>
              <select
                value={m4fScope}
                onChange={(e) => setM4fScope(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              >
                <option value="all_ts_hls">Todos mis canales TS y HLS del panel ({totalPanelStreams})</option>
                <option value="by_host">Solo canales de una IP específica</option>
              </select>
            </div>
            <div>
              <label className="text-slate-300 font-semibold block mb-1">Formato M4F a guardar en TVLister</label>
              <select
                value={m4fFormat}
                onChange={(e) => setM4fFormat(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-amber-300 font-semibold"
              >
                <option value="m4f_scheme">m4f://IP:PUERTO/canal (Nativo Cluster M4F + Failover)</option>
                <option value="cmaf">http://IP:PUERTO/canal/index.fmp4.m3u8 (CMAF fMP4)</option>
              </select>
            </div>
            <div>
              <label className="text-slate-300 font-semibold block mb-1">Modo de Empaquetado en Flussonic</label>
              <select
                value={m4fTranscodeMode}
                onChange={(e) => setM4fTranscodeMode(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              >
                <option value="copy_pure">⚡ Remux Puro TS/HLS → M4F (0% CPU — Copy directo)</option>
                <option value="copy_video_aac">🔊 Copy Video + Audio AAC 128k</option>
                <option value="copy_deint_aac">📺 CPU x264 Anti-Rayas + AAC</option>
                <option value="nvenc_deint_aac">🚀 GPU NVENC Anti-Rayas + AAC</option>
              </select>
            </div>
          </div>

          {m4fScope === 'by_host' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="text-slate-300 font-semibold block mb-1">IP de Origen TS/HLS a Filtrar</label>
                <input
                  type="text"
                  placeholder="Ej. 181.x.x.x o proveedor.com"
                  value={filterHost}
                  onChange={(e) => setFilterHost(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
              </div>
              <div>
                <label className="text-slate-300 font-semibold block mb-1">
                  Opcional: Reemplazar por IP LAN Local hacia Flussonic (dejar vacío si es internet)
                </label>
                <input
                  type="text"
                  placeholder="Opcional ej. 192.168.88.10"
                  value={localAstraHost}
                  onChange={(e) => setLocalAstraHost(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-cyan-300 font-mono"
                />
              </div>
            </div>
          )}

          <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={m4fPushFirst}
              onChange={(e) => setM4fPushFirst(e.target.checked)}
              className="rounded accent-amber-500"
            />
            Crear/actualizar automáticamente los streams TS y HLS dentro de Flussonic 23.12 vía API v3 (desmarca solo si ya existen en Flussonic y únicamente quieres cambiar los links en el panel a <code>m4f://</code>)
          </label>

          <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
            <button
              type="submit"
              disabled={convertingM4f}
              className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs font-bold shadow-lg shadow-amber-950/50"
            >
              {convertingM4f ? 'Convirtiendo TS/HLS a M4F...' : '⚡ Convertir Streams TS / HLS a M4F Ahora'}
            </button>
          </div>
        </form>
      )}

      {activeSubTab === 'proliant_relay' && (
        <form
          onSubmit={handleSetupProliantLeveledRelay}
          className="rounded-2xl bg-[#0e1526] border border-emerald-500/40 p-5 space-y-5"
        >
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 text-[11px] font-bold">
              ARQUITECTURA MAESTRA DE CABECERA 24/7 · SONIDO NIVELADO PAREJO + ENLACE M4F SIN CORTES
            </div>
            <h2 className="text-base font-bold text-white">
              Cadena en 1 Clic: Panel Local HP ProLiant G9 (Nivelar Audio) → Flussonic Local → Segundo Flussonic (`M4F`)
            </h2>
            <p className="text-xs text-slate-300 leading-relaxed">
              Ejecuta este asistente <strong>dentro del Panel TVLister instalado en tu HP ProLiant Gen9</strong>. El ProLiant nivela el volumen de todos los canales en tiempo real (`dynaudnorm` 48kHz estéreo) entregando flujo continuo <code>MPEG-TS</code> en memoria RAM hacia tu <strong>Flussonic Local (0% CPU)</strong>, y tu Flussonic Local los envía estables por <code>m4f://</code> a tu <strong>Segundo Flussonic</strong>.
            </p>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 text-xs">
            {/* Stage 1: ProLiant Gen9 Audio Leveler */}
            <div className="rounded-xl bg-[#090e1a] border border-emerald-500/35 p-4 space-y-3">
              <div className="font-bold text-emerald-300 uppercase text-[11px]">
                Etapa 1 · Este HP ProLiant G9 (Nivelador 24/7)
              </div>
              <div>
                <label className="text-slate-400 block mb-1">IP:Puerto LAN de este Panel en el ProLiant</label>
                <input
                  type="text"
                  required
                  placeholder="http://192.168.88.50:8095"
                  value={relayForm.proliant_lan_url}
                  onChange={(e) => setRelayForm({ ...relayForm, proliant_lan_url: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-emerald-300 font-mono"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Curva de Nivelación de Audio Broadcast</label>
                <select
                  value={relayForm.audio_preset}
                  onChange={(e) => setRelayForm({ ...relayForm, audio_preset: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                >
                  <option value="ultra_200ch">🚀 Cabecera 200+ Canales (Sin Resample -ar · Estéreo Acoplado · Ultra-Ligero)</option>
                  <option value="standard">🎚️ TV Estándar (-13 dBFS parejo · Con Resample 48 kHz)</option>
                  <option value="voice">🎙️ Deportes & Noticias (Realza voces bajas y frena comerciales)</option>
                  <option value="cinema">🎬 Cine & Películas (Rango dinámico suave)</option>
                </select>
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Modo de Salida en el ProLiant (200+ Canales)</label>
                <select
                  value={relayForm.proliant_video_mode}
                  onChange={(e) => setRelayForm({ ...relayForm, proliant_video_mode: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                >
                  <option value="copy_video_ultralight_200">⚡ Troncal 200+ Canales AAC Fast (0% Video · Sin Resample · Solo RAM 0 Disco)</option>
                  <option value="copy_video_mp2_200">🪶 Troncal 200+ Canales MP2 Broadcast (3x Menos CPU aún · Solo RAM 0 Disco)</option>
                  <option value="copy_video_leveled">🔄 Copy Video + Audio Nivelado Dual (RAM + HLS en Disco)</option>
                  <option value="deint_x264_leveled">📺 Anti-Rayas YADIF x264 + Audio AAC Nivelado</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-slate-400 block mb-1">Línea Troncal</label>
                  <input
                    type="text"
                    value={relayForm.trunk_username}
                    onChange={(e) => setRelayForm({ ...relayForm, trunk_username: e.target.value })}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Clave Troncal</label>
                  <input
                    type="text"
                    value={relayForm.trunk_password}
                    onChange={(e) => setRelayForm({ ...relayForm, trunk_password: e.target.value })}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Stage 2: Local Flussonic #1 */}
            <div className="rounded-xl bg-[#090e1a] border border-cyan-500/35 p-4 space-y-3">
              <div className="font-bold text-cyan-300 uppercase text-[11px]">
                Etapa 2 · Flussonic #1 Local (Recibe del ProLiant)
              </div>
              <div>
                <label className="text-slate-400 block mb-1">URL LAN de tu Flussonic Local</label>
                <input
                  type="text"
                  placeholder="http://192.168.88.20:8080"
                  value={relayForm.local_flussonic_url}
                  onChange={(e) => setRelayForm({ ...relayForm, local_flussonic_url: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-cyan-300 font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-slate-400 block mb-1">Usuario edit_auth</label>
                  <input
                    type="text"
                    value={relayForm.local_flussonic_user}
                    onChange={(e) => setRelayForm({ ...relayForm, local_flussonic_user: e.target.value })}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Contraseña</label>
                  <input
                    type="password"
                    value={relayForm.local_flussonic_pass}
                    onChange={(e) => setRelayForm({ ...relayForm, local_flussonic_pass: e.target.value })}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                  />
                </div>
              </div>
              <label className="inline-flex items-center gap-2 text-slate-200 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={relayForm.push_local_flussonic}
                  onChange={(e) => setRelayForm({ ...relayForm, push_local_flussonic: e.target.checked })}
                  className="rounded accent-cyan-500"
                />
                Inyectar canales automáticamente en Flussonic Local vía API v3 (<code>Copy Puro 0% CPU</code>)
              </label>
            </div>

            {/* Stage 3: Remote Flussonic #2 via M4F */}
            <div className="rounded-xl bg-[#090e1a] border border-violet-500/35 p-4 space-y-3">
              <div className="font-bold text-violet-300 uppercase text-[11px]">
                Etapa 3 · Segundo Flussonic (Recibe M4F Estable)
              </div>
              <div>
                <label className="text-slate-400 block mb-1">
                  IP Pública / VPN de tu Flussonic Local (para que el #2 jale <code>m4f://</code>)
                </label>
                <input
                  type="text"
                  placeholder="http://IP_PUBLICA_O_VPN_CABECERA:8080"
                  value={relayForm.local_flussonic_public_host}
                  onChange={(e) => setRelayForm({ ...relayForm, local_flussonic_public_host: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-amber-300 font-mono"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-1">URL del Segundo Flussonic (Opcional Push API v3)</label>
                <input
                  type="text"
                  placeholder="http://IP_SEGUNDO_FLUSSONIC:8080"
                  value={relayForm.remote_flussonic_url}
                  onChange={(e) => setRelayForm({ ...relayForm, remote_flussonic_url: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#0e1526] border border-slate-700 text-violet-300 font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-slate-400 block mb-1">Usuario #2</label>
                  <input
                    type="text"
                    value={relayForm.remote_flussonic_user}
                    onChange={(e) => setRelayForm({ ...relayForm, remote_flussonic_user: e.target.value })}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Contraseña #2</label>
                  <input
                    type="password"
                    value={relayForm.remote_flussonic_pass}
                    onChange={(e) => setRelayForm({ ...relayForm, remote_flussonic_pass: e.target.value })}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                  />
                </div>
              </div>
              <label className="inline-flex items-center gap-2 text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayForm.push_remote_flussonic}
                  onChange={(e) => setRelayForm({ ...relayForm, push_remote_flussonic: e.target.checked })}
                  className="rounded accent-violet-500"
                />
                Inyectar también en el Segundo Flussonic vía API v3 (<code>m4f://</code> 24/7)
              </label>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={runningRelaySetup}
              className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 disabled:opacity-40 text-white text-xs font-bold shadow-lg shadow-emerald-950/60"
            >
              {runningRelaySetup
                ? 'Activando Nivelación ProLiant y Configurando Flussonic...'
                : '🚀 Activar Nivelación 24/7 en ProLiant y Enlazar Cadena Flussonic'}
            </button>
          </div>

          {relayResult && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2 text-xs">
              <div className="space-y-1.5">
                <div className="font-bold text-cyan-300">
                  📄 Configuración Generada para Flussonic #1 Local (Respaldo <code>flussonic.conf</code>):
                </div>
                <textarea
                  readOnly
                  rows={8}
                  value={relayResult.localFlussonicConf || ''}
                  className="w-full p-3 rounded-xl bg-[#090e1a] border border-slate-700 font-mono text-[11px] text-slate-200"
                />
              </div>
              <div className="space-y-1.5">
                <div className="font-bold text-violet-300">
                  📄 Configuración Generada para Segundo Flussonic vía <code>m4f://</code>:
                </div>
                <textarea
                  readOnly
                  rows={8}
                  value={relayResult.remoteFlussonicConf || ''}
                  className="w-full p-3 rounded-xl bg-[#090e1a] border border-slate-700 font-mono text-[11px] text-slate-200"
                />
              </div>
            </div>
          )}
        </form>
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
                  URL / IP:Puerto de Flussonic 23.12 (accesible desde este panel en la Nube)
                </label>
                <input
                  type="text"
                  required
                  placeholder="http://IP_PUBLICA_FLUSSONIC:8080"
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
                  Opcional: API Bearer Token o cluster_key (si no usas edit_auth)
                </label>
                <input
                  type="password"
                  placeholder="Dejar vacío si usas usuario y contraseña edit_auth"
                  value={createForm.api_token}
                  onChange={(e) => setCreateForm({ ...createForm, api_token: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                />
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
