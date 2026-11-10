import React, { useEffect, useRef, useState } from 'react';
import {
  Tv2,
  Plus,
  Play,
  Square,
  RotateCw,
  Edit3,
  Trash2,
  ArrowUp,
  ArrowDown,
  Terminal,
  Calendar,
  X,
  Film,
  Youtube,
  Radio,
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  Loader2,
  ShieldAlert
} from 'lucide-react';
import { apiFetch } from '../lib/api.js';

// Tamaños legibles: «3,4 GB», «250 MB». Se usa en los avisos de disco.
const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (v >= 1024 ** 2) return `${Math.round(v / 1024 ** 2)} MB`;
  if (v > 0) return `${Math.round(v / 1024)} KB`;
  return '0';
};

export default function Channels247Page({ onPreview }) {
  const [channels, setChannels] = useState([]);
  const [vodList, setVodList] = useState([]);
  const [categories, setCategories] = useState([]);
  const [profiles, setProfiles] = useState([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({
    name: '',
    category_id: 4,
    logo_url: '',
    epg_channel_id: '',
    loop_mode: 'loop',
    engine_mode: 'virtual',
    transcode_profile_id: 2,
    watermark_text: 'TVLISTER 24/7',
    source_kind: 'playlist',
    live_source_url: '',
    playlist: []
  });

  // Señal en vivo (YouTube): estado de yt-dlp y resultado de «Comprobar».
  const [ytStatus, setYtStatus] = useState(null);
  const [probe, setProbe] = useState(null);
  const [liveBusy, setLiveBusy] = useState('');
  const [cookiesPath, setCookiesPath] = useState('');
  const [cookiesBusy, setCookiesBusy] = useState(false);
  const [cookiesMsg, setCookiesMsg] = useState(null);
  const [fmtDiag, setFmtDiag] = useState(null); // { busy, ok, text, error }
  const [prepareLimit, setPrepareLimit] = useState(10); // vídeos a descargar de una lista
  // Preparación de una lista desde la propia tarjeta del canal (sin abrir Editar).
  const [cardLimit, setCardLimit] = useState(10);
  const [cardPrep, setCardPrep] = useState(null); // { id, busy, msg, error }
  const [prepJob, setPrepJob] = useState(null); // estado del trabajo en el servidor
  const [diskBusy, setDiskBusy] = useState(false);
  const [diskMsg, setDiskMsg] = useState(null); // { ok, text }
  const cookiesFileRef = useRef(null);

  const [customTitle, setCustomTitle] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customDur, setCustomDur] = useState(600);

  // watch?v=…&list=… (lo que copia el navegador al ver un vídeo dentro de una
  // lista): se avisa de que se emitirá la lista y se ofrece quitar la lista.
  const watchListHint = (() => {
    const u = String(form.live_source_url || '');
    return /[?&]v=[^&]+/.test(u) && /[?&]list=/.test(u);
  })();

  const [epgModal, setEpgModal] = useState(null);
  const [ffmpegModal, setFfmpegModal] = useState(null);

  const loadAll = async () => {
    const [chs, vods, cats, sys] = await Promise.all([
      apiFetch('/api/channels247'),
      apiFetch('/api/vod'),
      apiFetch('/api/categories'),
      apiFetch('/api/system')
    ]);
    setChannels(chs);
    setVodList(vods);
    setCategories(cats.filter((c) => c.type === 'channel247' || c.type === 'live'));
    setProfiles(sys.profiles || []);
  };

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 10000);
    return () => clearInterval(t);
  }, []);

  // El disco también se refresca solo: la tarjeta de un canal de YouTube avisa
  // de lo que ocuparían los vídeos que faltan y de lo que queda libre sin
  // tener que abrir Editar. Cada 30 s basta (y no machaca a yt-dlp).
  useEffect(() => {
    loadYtStatus();
    const t = setInterval(loadYtStatus, 30000);
    return () => clearInterval(t);
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({
      name: '',
      category_id: categories[0]?.id || 4,
      logo_url: '',
      epg_channel_id: `canal247.${Math.floor(Math.random() * 900 + 100)}.tv`,
      loop_mode: 'loop',
      engine_mode: 'virtual',
      transcode_profile_id: 2,
      watermark_text: 'TVLISTER 24/7',
      source_kind: 'playlist',
      live_source_url: '',
      playlist: vodList.slice(0, 2).map((v, idx) => ({
        id: `clip-${Date.now()}-${idx}`,
        vod_id: v.id,
        title: v.title,
        url: v.source_url,
        duration_sec: v.duration_sec
      }))
    });
    setProbe(null);
    loadYtStatus();
    setModalOpen(true);
  };

  const openEdit = (ch) => {
    setEditingId(ch.id);
    setForm({
      name: ch.name,
      category_id: ch.category_id || 4,
      logo_url: ch.logo_url || '',
      epg_channel_id: ch.epg_channel_id || '',
      loop_mode: ch.loop_mode || 'loop',
      engine_mode: ch.engine_mode || 'virtual',
      transcode_profile_id: ch.transcode_profile_id || 2,
      watermark_text: ch.watermark_text || '',
      source_kind: ch.source_kind || 'playlist',
      live_source_url: ch.live_source_url || '',
      playlist: Array.isArray(ch.playlist) ? ch.playlist : []
    });
    setProbe(null);
    if ((ch.source_kind || 'playlist') === 'youtube') loadYtStatus();
    setModalOpen(true);
  };

  // ── Señal de YouTube: directo, vídeo en bucle o lista completa ─────────
  // Etiquetas cortas para que se entienda de un vistazo de qué va el canal.
  const modeBadge = (ls) => {
    const mode = ls?.mode || 'live';
    // ▶ = se está emitiendo desde YouTube ahora mismo (sin copia en el disco).
    if (mode === 'playlist') return `${ls?.entries ? '▶' : '≡'} LISTA · ${ls?.entries || 0}`;
    if (mode === 'video') return '▶ VÍDEO EN BUCLE';
    if (mode === 'hls') return '◎ HLS EXTERNO';
    return ls?.live ? '● YOUTUBE EN VIVO' : 'SIN SEÑAL';
  };
  const modeTitle = (ls) => {
    const mode = ls?.mode || 'live';
    if (mode === 'playlist') return `${ls?.entries || 0} vídeos · ${Math.round((ls?.total_duration_sec || 0) / 60)} min`;
    if (mode === 'video') return `Bucle · ${Math.floor((ls?.duration_sec || 0) / 60)}m ${Math.round((ls?.duration_sec || 0) % 60)}s`;
    if (mode === 'hls') return 'Manifiesto HLS';
    return ls?.live ? 'EN VIVO' : 'SIN SEÑAL';
  };

  const loadYtStatus = async () => {
    try {
      const st = await apiFetch('/api/youtube/status');
      setYtStatus(st);
      if (st?.cookies) setCookiesPath((prev) => prev || st.cookies.path || '');
    } catch {
      setYtStatus({ installed: false, hint: 'No se pudo consultar el estado de yt-dlp.' });
    }
  };

  // Calidad de descarga: 720p ocupa la mitad que 1080p (en un VPS el disco es
  // lo primero que se llena). Se guarda en el panel y vale para las próximas.
  const handleSetHeight = async (h) => {
    try {
      await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ youtube_video_height: String(h) }) });
      await loadYtStatus();
    } catch (err) {
      window.alert(err.message || 'No se pudo guardar la calidad.');
    }
  };

  // «Liberar espacio»: borra los vídeos que ya no emite ningún canal. Nunca
  // toca los que un canal está usando (dejaría ese canal sin señal).
  const handleFreeSpace = async (allUnused = true) => {
    setDiskBusy(true);
    setDiskMsg(null);
    try {
      const r = await apiFetch('/api/youtube/videos/cleanup', {
        method: 'POST',
        body: JSON.stringify({ all_unused: allUnused })
      });
      const removed = Array.isArray(r.removed) ? r.removed.length : 0;
      setDiskMsg({
        ok: true,
        text: removed
          ? `Liberados ${fmtBytes(r.freed_bytes)} (${removed} vídeo${removed === 1 ? '' : 's'}). Disco libre: ${fmtBytes(r.stats?.free_bytes)}.`
          : `No había nada que borrar: los archivos están emitiendo en algún canal. Disco libre: ${fmtBytes(r.stats?.free_bytes)}.`
      });
      await loadYtStatus();
      loadAll();
    } catch (err) {
      setDiskMsg({ ok: false, text: err.message || 'No se pudo liberar espacio.' });
    } finally {
      setDiskBusy(false);
    }
  };

  const handleProbe = async () => {
    const url = String(form.live_source_url || '').trim();
    if (!url) {
      setProbe({ ok: false, live: false, error: 'Pega primero el enlace de YouTube (directo, vídeo o lista).' });
      return;
    }
    setProbe({ busy: true });
    try {
      const r = await apiFetch('/api/youtube/probe', { method: 'POST', body: JSON.stringify({ url }) });
      setProbe({ ...r, busy: false });
      // Se fusiona (no se reemplaza): el probe no tiene por qué traer todo.
      if (r.yt_dlp) setYtStatus((prev) => ({ ...(prev || {}), ...r.yt_dlp }));
      if (r.ready && r.title && !String(form.name || '').trim()) {
        setForm((prev) => ({ ...prev, name: r.title }));
      }
    } catch (err) {
      setProbe({ busy: false, ok: false, live: false, error: err.message });
    }
  };

  // La instalación corre en el servidor (el binario autónomo pesa ~39 MB y un
  // proxy cortaría la petición). Aquí sólo se lanza y se pregunta cómo va.
  const handleInstallYtdlp = async () => {
    // Si se estaba actualizando por «Requested format is not available», al
    // terminar se vuelve a comprobar el enlace sin que el operador haga nada.
    const wasFormatFix = Boolean(probe?.needs_format_fix);
    setProbe({ busy: true, installing: true, step: 'empezando…' });
    try {
      await apiFetch('/api/youtube/install', { method: 'POST', body: JSON.stringify({}) });
      let state = null;
      for (let i = 0; i < 180; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        state = await apiFetch('/api/youtube/install-status');
        if (state?.running) {
          setProbe({ busy: true, installing: true, step: state.step || 'instalando…' });
          continue;
        }
        break;
      }
      await loadYtStatus();
      const r = state?.result || null;
      setProbe(
        r?.ok
          ? {
              busy: false,
              ok: true,
              live: false,
              error: '',
              installed:
                `yt-dlp ${r.version || ''} instalado en ${r.path}` +
                (r.variant === 'standalone' ? ' · binario autónomo, sin depender de Python' : '')
            }
          : {
              busy: false,
              ok: false,
              live: false,
              error: r?.error || 'La instalación no terminó. Vuelve a intentarlo en unos segundos.'
            }
      );
      if (wasFormatFix && r?.ok && String(form.live_source_url || '').trim()) {
        setTimeout(() => {
          handleProbe();
        }, 50);
      }
    } catch (err) {
      setProbe({ busy: false, ok: false, live: false, error: err.message });
    }
  };

  // Sube el cookies.txt exportado del navegador: el panel lo valida, lo guarda
  // con permisos 0600 y lo usa solo en la próxima lectura de YouTube.
  const handleUploadCookies = async (file) => {
    if (!file) return;
    setCookiesBusy(true);
    setCookiesMsg(null);
    try {
      const text = await file.text();
      const r = await apiFetch('/api/youtube/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text
      });
      await loadYtStatus();
      setCookiesMsg({ ok: true, text: r.message || 'Cookies guardadas.' });
      // Si el fallo era el control anti-robots, se vuelve a comprobar solo.
      if (probe?.needs_cookies && String(form.live_source_url || '').trim()) {
        setTimeout(() => {
          handleProbe();
        }, 50);
      }
    } catch (err) {
      setCookiesMsg({ ok: false, text: err.message || 'No se pudieron guardar las cookies.' });
    } finally {
      setCookiesBusy(false);
    }
  };

  // Descarga el vídeo al servidor (una vez) para repetirlo desde el disco.
  // Igual que la instalación de yt-dlp: se lanza y se pregunta por el avance.
  const handleDownloadVideo = async () => {
    const url = String(form.live_source_url || '').trim();
    if (!url) {
      setProbe({ ok: false, live: false, error: 'Pega primero el enlace del vídeo.' });
      return;
    }
    setProbe({ ...(probe || {}), busy: true, downloading: true, step: 'empezando la descarga…' });
    try {
      const first = await apiFetch('/api/youtube/download', { method: 'POST', body: JSON.stringify({ url }) });
      let state = first;
      for (let i = 0; i < 3600; i += 1) {
        if (!state?.running) break;
        await new Promise((r) => setTimeout(r, 2000));
        state = await apiFetch('/api/youtube/download-status');
        if (state?.running) {
          setProbe({ ...(probe || {}), busy: true, downloading: true, step: state.step || 'descargando…' });
        }
      }
      const r = state?.result || null;
      if (r?.ok) {
        // Ya está en el disco: se vuelve a comprobar el enlace, que ahora sale del archivo.
        await handleProbe();
        setProbe((prev) => ({
          ...(prev || {}),
          busy: false,
          downloading: false,
          downloaded:
            `Vídeo descargado (${Math.round((r.bytes || 0) / (1024 * 1024))} MB` +
            `${r.duration_sec ? ` · ${Math.floor(r.duration_sec / 60)}m ${Math.round(r.duration_sec % 60)}s` : ''}). ` +
            'Se repite desde el disco: no caduca y no vuelve a depender de YouTube.'
        }));
      } else {
        setProbe({
          ...(probe || {}),
          busy: false,
          downloading: false,
          error: r?.error || 'La descarga no terminó. Vuelve a intentarlo.'
        });
      }
    } catch (err) {
      setProbe({ ...(probe || {}), busy: false, downloading: false, error: err.message });
    }
  };

  // Prepara una LISTA completa en el disco: descarga sus vídeos (uno a uno) y
  // después se emiten desde ahí, en orden y en bucle, sin caducidades.
  const handlePreparePlaylist = async () => {
    const url = String(form.live_source_url || '').trim();
    if (!url) return;
    setProbe({ ...(probe || {}), busy: true, preparing: true, step: 'leyendo la lista…' });
    try {
      const first = await apiFetch('/api/youtube/prepare-playlist', {
        method: 'POST',
        body: JSON.stringify({ url, limit: Number(prepareLimit) || 10 })
      });
      let state = first;
      for (let i = 0; i < 9000; i += 1) {
        if (!state?.running) break;
        await new Promise((r) => setTimeout(r, 2000));
        state = await apiFetch('/api/youtube/prepare-playlist/status');
        if (state?.running) {
          const pct = state.total ? ` (${state.done}/${state.total})` : '';
          setProbe({
            ...(probe || {}),
            busy: true,
            preparing: true,
            step: `${state.step || 'descargando…'}${state.total ? '' : pct}`
          });
        }
      }
      const r = state?.result || null;
      if (r?.ok) {
        await handleProbe();
        setProbe((prev) => ({
          ...(prev || {}),
          busy: false,
          preparing: false,
          prepared:
            `Lista preparada: ${r.downloaded + (r.already || 0)} de ${r.total} vídeos en el disco` +
            `${r.failed ? ` (${r.failed} no se pudieron bajar)` : ''}. Se emiten en orden desde el disco: no caducan.` +
            `${r.skipped_for_space ? ` No se prepararon ${r.skipped_for_space} más: no caben en el disco (libre ${fmtBytes(r.free_bytes)}).` : ''}`
        }));
      } else {
        setProbe({
          ...(probe || {}),
          busy: false,
          preparing: false,
          error: r?.error || 'No se pudo preparar la lista.'
        });
      }
    } catch (err) {
      setProbe({ ...(probe || {}), busy: false, preparing: false, error: err.message });
    }
  };

  // Prueba REAL de las cookies: se le pasan a yt-dlp contra un vídeo público.
  // Una sesión caducada sigue teniendo SID, pero no abre nada.
  const handleTestCookies = async () => {
    setCookiesBusy(true);
    setCookiesMsg({ ok: true, text: 'Probando las cookies con YouTube…' });
    try {
      const r = await apiFetch('/api/youtube/cookies/test', { method: 'POST', body: JSON.stringify({}) });
      setCookiesMsg({ ok: Boolean(r.ok), text: r.ok ? r.message : r.error || 'Las cookies no han funcionado.' });
      await loadYtStatus();
    } catch (err) {
      setCookiesMsg({ ok: false, text: err.message });
    } finally {
      setCookiesBusy(false);
    }
  };

  // Lo que yt-dlp ve de verdad para este enlace (`-F`): formatos o el motivo.
  const handleShowFormats = async () => {
    const url = String(form.live_source_url || '').trim();
    if (!url) return;
    setFmtDiag({ busy: true });
    try {
      const r = await apiFetch('/api/youtube/formats', { method: 'POST', body: JSON.stringify({ url }) });
      setFmtDiag({
        busy: false,
        ok: Boolean(r.ok),
        text: r.text || '',
        client: r.client || '',
        botCheck: Boolean(r.bot_check),
        error: r.error || ''
      });
    } catch (err) {
      setFmtDiag({ busy: false, ok: false, text: '', error: err.message });
    }
  };

  const handleSaveCookies = async () => {
    try {
      const r = await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ youtube_cookies_file: String(cookiesPath || '').trim() })
      });
      await loadYtStatus();
      const warn = Array.isArray(r?.warnings) && r.warnings.length ? r.warnings[0] : '';
      window.alert(
        String(cookiesPath || '').trim()
          ? warn
            ? `Ruta guardada, pero ojo: ${warn}`
            : 'Ruta de cookies guardada y comprobada. Se usará la próxima vez que el panel lea YouTube.'
          : 'Cookies borradas: el panel leerá YouTube sin sesión.'
      );
    } catch (err) {
      window.alert(err.message || 'No se pudo guardar la ruta de cookies.');
    }
  };

  // Preparar la lista DIRECTAMENTE desde la tarjeta: es lo que la propia
  // tarjeta pide («botón Preparar lista en el disco») y antes sólo existía
  // dentro de Editar, así que el canal se quedaba a 0 vídeos sin salida visible.
  const handleCardPrepare = async (ch) => {
    const url = String(ch.liveSource?.live_source_url || ch.live_source_url || '').trim();
    if (!url) return;
    setCardPrep({ id: ch.id, busy: true });
    try {
      let state = await apiFetch('/api/youtube/prepare-playlist', {
        method: 'POST',
        body: JSON.stringify({ url, limit: Number(cardLimit) || 10, channel_id: ch.id })
      });
      setPrepJob(state);
      for (let i = 0; i < 9000; i += 1) {
        if (!state?.running) break;
        await new Promise((r) => setTimeout(r, 2000));
        state = await apiFetch('/api/youtube/prepare-playlist/status');
        if (state?.running) setPrepJob(state);
      }
      setPrepJob(state);
      const r = state?.result || null;
      if (r?.ok) {
        // La lista ya se puede emitir desde el disco: se recompone sin red.
        await apiFetch(`/api/channels247/${ch.id}/live-source/refresh`, {
          method: 'POST',
          body: JSON.stringify({ disk_only: true })
        });
        setCardPrep({
          id: ch.id,
          busy: false,
          msg:
            `⛁ ${r.downloaded + (r.already || 0)} de ${r.total} en el disco. ` +
            'El canal se emite desde ahí, en orden y sin caducar.' +
            (r.skipped_for_space
              ? ` Faltan ${r.skipped_for_space} que no caben: quedan ${fmtBytes(r.free_bytes)} libres.`
              : '')
        });
      } else {
        setCardPrep({
          id: ch.id,
          busy: false,
          error: r?.error || 'No se pudo preparar la lista. Vuelve a intentarlo.'
        });
      }
      loadAll();
    } catch (err) {
      setCardPrep({ id: ch.id, busy: false, error: err.message || 'No se pudo preparar la lista.' });
    }
  };

  // Con vídeos por descargar (los pida la tarjeta o los arranque la
  // auto-preparación del servidor) se sigue el avance y se refresca la tarjeta
  // al terminar. La descarga vive en el servidor: cerrar el navegador no la para.
  const prepWasRunning = useRef(false);
  useEffect(() => {
    const anyPending = channels.some((c) => Number(c.liveSource?.pending_count) > 0);
    if (!anyPending) return undefined;
    let alive = true;
    const tick = async () => {
      let st = null;
      try {
        st = await apiFetch('/api/youtube/prepare-playlist/status');
      } catch {
        return;
      }
      if (!alive || !st) return;
      setPrepJob(st);
      const running = Boolean(st.running);
      if (prepWasRunning.current && !running) loadAll();
      prepWasRunning.current = running;
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [channels]);

  const handleRefreshLive = async (id) => {
    setLiveBusy(`refresh:${id}`);
    try {
      const r = await apiFetch(`/api/channels247/${id}/live-source/refresh`, { method: 'POST', body: JSON.stringify({}) });
      if (!r.ok) window.alert(r.state?.error || 'La señal no está disponible ahora mismo.');
    } catch (err) {
      window.alert(err.message);
    } finally {
      setLiveBusy('');
      loadAll();
    }
  };

  const addVodToPlaylist = (vodId) => {
    const v = vodList.find((x) => String(x.id) === String(vodId));
    if (!v) return;
    setForm((prev) => ({
      ...prev,
      playlist: [
        ...prev.playlist,
        {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          vod_id: v.id,
          title: v.title,
          url: v.source_url,
          duration_sec: v.duration_sec || 600
        }
      ]
    }));
  };

  const addCustomClip = () => {
    if (!customTitle.trim() || !customUrl.trim()) return;
    setForm((prev) => ({
      ...prev,
      playlist: [
        ...prev.playlist,
        {
          id: `clip-${Date.now()}`,
          vod_id: null,
          title: customTitle.trim(),
          url: customUrl.trim(),
          duration_sec: Math.max(15, Number(customDur) || 600)
        }
      ]
    }));
    setCustomTitle('');
    setCustomUrl('');
    setCustomDur(600);
  };

  const moveClip = (idx, dir) => {
    const next = [...form.playlist];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setForm({ ...form, playlist: next });
  };

  const removeClip = (idx) => {
    setForm({
      ...form,
      playlist: form.playlist.filter((_, i) => i !== idx)
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (form.source_kind === 'youtube' && !String(form.live_source_url || '').trim()) {
      setProbe({ ok: false, live: false, error: 'Pega el enlace de YouTube (directo, vídeo o lista) antes de guardar.' });
      return;
    }
    try {
      if (editingId) {
        await apiFetch(`/api/channels247/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(form)
        });
      } else {
        await apiFetch('/api/channels247', {
          method: 'POST',
          body: JSON.stringify(form)
        });
      }
      setModalOpen(false);
      loadAll();
    } catch (err) {
      setProbe({ ok: false, live: false, error: err.message || 'No se pudo guardar el canal.' });
    }
  };

  const handleAction = async (id, action) => {
    await apiFetch(`/api/channels247/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    loadAll();
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar este Canal 24/7?')) return;
    await apiFetch(`/api/channels247/${id}`, { method: 'DELETE' });
    loadAll();
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600/20 via-violet-600/15 to-cyan-600/15 border border-indigo-500/30 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Tv2 className="w-5 h-5 text-indigo-400" />
            Estudio de Canales Personalizados 24/7 (Playout Dinámico)
          </h2>
          <p className="text-xs text-slate-300 mt-1 max-w-2xl">
            Crea canales lineales 24/7 combinando tu catálogo VOD y flujos externos con cambios de parrilla en caliente,
            marca de agua en pantalla (Watermark) y generación automática de guía EPG XMLTV.
          </p>
        </div>

        <button
          onClick={openCreate}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/25 transition"
        >
          <Plus className="w-4 h-4" />
          Crear Canal 24/7
        </button>
      </div>

      {/* Channels Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {channels.map((ch) => {
          const st = ch.liveState || {};
          return (
            <div
              key={ch.id}
              className="rounded-2xl bg-[#0e1526] border border-slate-800/80 p-5 flex flex-col justify-between gap-4 shadow-lg"
            >
              <div>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 overflow-hidden flex items-center justify-center shrink-0">
                      {ch.logo_url ? (
                        <img src={ch.logo_url} alt={ch.name} className="w-full h-full object-cover" />
                      ) : (
                        <Tv2 className="w-6 h-6 text-violet-400" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-bold text-white text-sm truncate">{ch.name}</h3>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            ch.status === 'running'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          }`}
                        >
                          {ch.status === 'running' ? 'AL AIRE 24/7' : 'DETENIDO'}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                            ch.engine_mode === 'ffmpeg'
                              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                              : 'bg-slate-800 text-slate-300 border-slate-700'
                          }`}
                        >
                          {ch.source_kind === 'youtube'
                            ? ch.engine_mode === 'ffmpeg'
                              ? `MOTOR 24/7${ch.workerPid ? ` (PID ${ch.workerPid})` : ''}`
                              : 'SIN MOTOR'
                            : ch.engine_mode === 'ffmpeg'
                              ? `FFMPEG AUTO${ch.workerPid ? ` (PID ${ch.workerPid})` : ''}`
                              : 'RELOJ VIRTUAL'}
                        </span>
                        {ch.source_kind === 'youtube' && (
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                              ch.liveSource?.mode === 'video' || ch.liveSource?.mode === 'playlist'
                                ? 'bg-violet-500/20 text-violet-200 border-violet-500/40'
                                : ch.liveSource?.live
                                  ? 'bg-red-500/20 text-red-300 border-red-500/40'
                                  : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                            }`}
                          >
                            {modeBadge(ch.liveSource)}
                          </span>
                        )}
                        {ch.source_kind === 'youtube' && Number(ch.liveSource?.pending_count) > 0 && (
                          <span
                            className="px-2 py-0.5 rounded-full text-[10px] font-bold border bg-teal-500/15 text-teal-200 border-teal-500/40"
                            title="Todavía faltan vídeos por descargar: el canal emite con los que ya están en el disco y suma el resto solo (botón «Preparar la lista en el disco» en la tarjeta)."
                          >
                            ⛁ {ch.liveSource.pending_count || 0} SIN DESCARGAR
                          </span>
                        )}
                        {ch.source_kind === 'youtube' && ch.liveSource?.local && (
                          <span
                            className="px-2 py-0.5 rounded-full text-[10px] font-bold border bg-teal-500/15 text-teal-200 border-teal-500/40"
                            title="El vídeo está descargado en el servidor: se repite desde el disco, sin caducidad ni volver a YouTube."
                          >
                            ⛁ DESDE EL DISCO
                          </span>
                        )}
                        {ch.source_kind === 'youtube' && ch.liveSource?.ready && (
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                              ch.copyExact
                                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                                : ch.copyVideo
                                  ? 'bg-sky-500/15 text-sky-300 border-sky-500/40'
                                  : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                            }`}
                            title={
                              ch.copyExact
                                ? 'Se emite copiando el original: ni el vídeo ni el audio se recodifican (0 % de CPU de vídeo).'
                                : ch.copyVideo
                                  ? 'El vídeo se copia tal cual; el audio pasa a AAC por el nivelador global.'
                                  : 'Se recodifica a H.264 2500k porque el original no es H.264/AAC uniforme.'
                            }
                          >
                            {ch.copyExact ? '⧉ COPIA EXACTA' : ch.copyVideo ? '⧉ COPIA · AUDIO AAC' : '↻ RECODIFICA'}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {ch.category_name || '24/7'} •{' '}
                        {ch.source_kind === 'youtube'
                          ? `${ch.liveSource?.title || 'Señal de YouTube'}${
                              ch.liveSource?.mode === 'playlist'
                                ? ` · ${ch.liveSource?.entries || 0} vídeos`
                                : ch.liveSource?.mode === 'video'
                                  ? ` · repetido en bucle${ch.liveSource?.local ? ' (descargado)' : ''}`
                                  : ''
                            }`
                          : `${ch.playlist?.length || 0} programas`}{' '}
                        • EPG: <span className="font-mono text-slate-300">{ch.epg_channel_id}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Live Now Playing Box */}
                {ch.source_kind === 'youtube' ? (
                  <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800/90 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400 font-medium flex items-center gap-1.5">
                        <Youtube className="w-3.5 h-3.5 text-red-400" />
                        {ch.liveSource?.mode === 'playlist'
                          ? 'Lista de YouTube:'
                          : ch.liveSource?.mode === 'video'
                            ? 'Vídeo de YouTube en bucle:'
                            : 'Señal tomada de YouTube:'}
                      </span>
                      <span
                        className={`font-mono text-[11px] ${
                          ch.liveSource?.ready || ch.liveSource?.live ? 'text-emerald-300' : 'text-amber-300'
                        }`}
                      >
                        {modeTitle(ch.liveSource)}
                      </span>
                    </div>
                    <div className="text-xs font-semibold text-white truncate">
                      {ch.liveSource?.title || 'Sin título'}
                      {ch.liveSource?.uploader ? (
                        <span className="text-slate-400 font-normal"> · {ch.liveSource.uploader}</span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="truncate max-w-[55%]">{ch.liveSource?.live_source_url}</span>
                      {ch.liveSource?.expires_in_min !== null && ch.liveSource?.expires_in_min !== undefined && (
                        <span className={ch.liveSource.expires_in_min < 15 ? 'text-amber-300' : ''}>
                          URL renovable · {ch.liveSource.expires_in_min} min
                        </span>
                      )}
                      {ch.liveSource?.resolved_at && (
                        <span>Actualizada {String(ch.liveSource.resolved_at).slice(11, 19)}</span>
                      )}
                    </div>
                    {ch.liveSource?.mode === 'playlist' && (ch.liveSource?.entry_titles || []).length > 0 && (
                      <div className="text-[11px] text-slate-400 space-y-0.5">
                        {(ch.liveSource.entry_titles || []).slice(0, 3).map((t, i) => (
                          <div key={i} className="truncate flex items-center gap-1">
                            <span className="text-violet-300 font-mono">{i + 1}.</span>
                            <span className="truncate">{t}</span>
                          </div>
                        ))}
                        {(ch.liveSource?.entries || 0) > 3 && (
                          <div className="text-slate-500">… y {ch.liveSource.entries - 3} más, en bucle.</div>
                        )}
                      </div>
                    )}
                    {ch.liveSource?.mode === 'video' && (
                      <div className="text-[11px] text-slate-400">
                        Se repite sin fin{ch.liveSource?.needs_transcode ? ' · recodificado a H.264 1080p' : ' · sin recodificar'}.
                      </div>
                    )}
                    {ch.liveSource?.mode === 'playlist' && ch.liveSource?.ready && !Number(ch.liveSource?.pending_count) && (
                      <div className="text-[11px] text-slate-400">
                        Se emite desde YouTube, capítulo a capítulo y en bucle
                        {ch.liveSource?.separated_audio ? ' (con sus dos pistas unidas al vuelo)' : ''}:{' '}
                        <b className="text-slate-300">no ocupa disco</b>.
                      </div>
                    )}
                    {ch.liveSource?.ready && (
                      <div className="text-[11px] text-slate-400 flex items-center gap-1">
                        <span className={ch.copyExact ? 'text-emerald-300' : 'text-amber-300'}>⧉</span>
                        {ch.copyExact ? (
                          <span>
                            Copia exacta (copy/copy): el vídeo y el audio salen tal como llegan
                            {ch.liveSource?.separated_audio ? ', uniendo sus dos pistas' : ''}, sin recodificar.
                          </span>
                        ) : ch.copyVideo ? (
                          <span>El vídeo se copia sin tocar; el audio pasa a AAC por el nivelador global.</span>
                        ) : (
                          <span>Recodificando a H.264 2500k + AAC: el original no es H.264/AAC uniforme.</span>
                        )}
                      </div>
                    )}
                    {ch.liveSource?.error && (
                      <div className="text-[11px] text-amber-300 flex items-start gap-1">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{ch.liveSource.error}</span>
                      </div>
                    )}
                    {/* La lista sólo da DASH/HLS: se descarga desde aquí mismo. */}
                    {(Number(ch.liveSource?.pending_count) > 0 ||
                      ch.liveSource?.can_prepare_playlist ||
                      (cardPrep?.id === ch.id && Boolean(cardPrep?.msg || cardPrep?.error))) && (
                      <div className="space-y-1.5 pt-0.5">
                        {prepJob?.running && String(prepJob.url || '') === String(ch.liveSource?.live_source_url || '') ? (
                          <div className="text-[11px] text-teal-200 flex items-start gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 shrink-0 mt-0.5 animate-spin" />
                            <span>
                              Guardando la lista en el disco
                              {prepJob.total ? ` (${prepJob.done}/${prepJob.total})` : ''}: {prepJob.step || 'descargando…'}
                              <span className="text-slate-400">
                                {' '}
                                — el canal ya emite con los que hay; el resto se añade solo.
                              </span>
                            </span>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleCardPrepare(ch)}
                              disabled={Boolean(prepJob?.running) || cardPrep?.busy}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-bold disabled:opacity-50"
                            >
                              {cardPrep?.busy ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Download className="w-3.5 h-3.5" />
                              )}
                              {cardPrep?.busy ? 'Guardando…' : 'Guardar copia en el disco'}
                            </button>
                            <label className="inline-flex items-center gap-1 text-slate-300 text-[11px]">
                              Vídeos:
                              <input
                                type="number"
                                min={1}
                                max={30}
                                value={cardLimit}
                                onChange={(e) => setCardLimit(Math.max(1, Math.min(30, Number(e.target.value) || 10)))}
                                className="w-14 px-1.5 py-0.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                              />
                            </label>
                            <select
                              value={String(ytStatus?.videos?.height || 1080)}
                              onChange={(e) => handleSetHeight(Number(e.target.value))}
                              className="px-1.5 py-0.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white text-[11px]"
                              title="Cuanto más baja la calidad, menos disco: 720p ocupa la mitad que 1080p."
                            >
                              <option value="1080">1080p</option>
                              <option value="720">720p (ocupa la mitad)</option>
                              <option value="480">480p (ocupa un tercio)</option>
                            </select>
                          </div>
                        )}
                        <div className="text-[11px] text-slate-400">
                          Opcional: guardar los capítulos en el disco (H.264 + AAC) para que no dependan de YouTube. El
                          canal emite igual sin esto; sólo hace falta si YouTube no da ni una pista.
                          {Number(ch.liveSource?.pending_count) > 0 && (
                            <span className="text-slate-300">
                              {' '}
                              Quedan {ch.liveSource.pending_count} ≈ {fmtBytes(ch.liveSource.pending_bytes)} · disco libre{' '}
                              <b>{fmtBytes(ytStatus?.videos?.free_bytes)}</b>.
                            </span>
                          )}
                        </div>
                        {cardPrep?.id === ch.id && cardPrep?.msg && (
                          <div className="text-[11px] text-emerald-300">{cardPrep.msg}</div>
                        )}
                        {cardPrep?.id === ch.id && cardPrep?.error && (
                          <div className="text-[11px] text-rose-300 flex items-start gap-1">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>{cardPrep.error}</span>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <button
                            type="button"
                            onClick={() => handleFreeSpace(true)}
                            disabled={diskBusy}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 font-semibold disabled:opacity-50"
                            title="Borra los vídeos descargados que ya no emite ningún canal. Nunca toca los que están al aire."
                          >
                            {diskBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            Liberar espacio
                          </button>
                          <span className="text-slate-400">
                            Vídeos en el disco: {fmtBytes(ytStatus?.videos?.bytes)}
                            {ytStatus?.videos?.count ? ` (${ytStatus.videos.count})` : ''}
                          </span>
                        </div>
                        {diskMsg && (
                          <div className={`text-[11px] ${diskMsg.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                            {diskMsg.text}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-3.5 rounded-xl bg-[#090e1a] border border-slate-800/90 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400 font-medium">Emitiendo ahora mismo:</span>
                      <span className="font-mono text-indigo-300 text-[11px]">{st.progressPct || 0}%</span>
                    </div>
                    <div className="text-xs font-semibold text-white truncate">
                      {st.currentItem ? `▶ ${st.currentItem.title}` : 'Parrilla vacía'}
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-400"
                        style={{ width: `${st.progressPct || 0}%` }}
                      />
                    </div>
                    {st.nextItem && (
                      <div className="text-[11px] text-slate-400 flex items-center justify-between">
                        <span>
                          Posición: {Math.floor((st.seekOffsetSec || 0) / 60)}m {(st.seekOffsetSec || 0) % 60}s
                        </span>
                        <span className="truncate max-w-[240px]">A continuación: {st.nextItem.title}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
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
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Sintonizar
                  </button>

                  <button
                    onClick={() => setEpgModal(ch)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition"
                  >
                    <Calendar className="w-3.5 h-3.5 text-cyan-400" />
                    Parrilla EPG
                  </button>

                  {ch.source_kind === 'youtube' && (
                    <button
                      onClick={() => handleRefreshLive(ch.id)}
                      disabled={liveBusy === `refresh:${ch.id}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition disabled:opacity-50"
                      title="Volver a resolver el directo de YouTube ahora"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 text-emerald-400 ${liveBusy === `refresh:${ch.id}` ? 'animate-spin' : ''}`} />
                      Renovar señal
                    </button>
                  )}

                  <button
                    onClick={() => setFfmpegModal(ch)}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                    title="Ver motor FFmpeg 24/7"
                  >
                    <Terminal className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  {ch.status === 'running' ? (
                    <button
                      onClick={() => handleAction(ch.id, 'stop')}
                      className="p-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 text-amber-300"
                      title="Detener"
                    >
                      <Square className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleAction(ch.id, 'start')}
                      className="p-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300"
                      title="Iniciar"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    onClick={() => openEdit(ch)}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                    title="Editar programación"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => handleDelete(ch.id)}
                    className="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                    title="Eliminar"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create / Edit 24/7 Channel Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-3xl rounded-2xl bg-[#0e1526] border border-slate-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-semibold text-white text-sm">
                {editingId ? 'Editar Programación Canal 24/7' : 'Nuevo Canal Dinámico 24/7'}
              </h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4 max-h-[82vh] overflow-y-auto text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Nombre del Canal 24/7 *</label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    placeholder="Ej. Cine Acción 24/7"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Categoría</label>
                  <select
                    value={form.category_id}
                    onChange={(e) => setForm({ ...form, category_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Marca de Agua (Watermark OSD)</label>
                  <input
                    type="text"
                    value={form.watermark_text}
                    onChange={(e) => setForm({ ...form, watermark_text: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                    placeholder="Ej. CINE 24/7 HD"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Motor Playout 24/7</label>
                  <select
                    value={form.engine_mode || 'virtual'}
                    onChange={(e) => setForm({ ...form, engine_mode: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    <option value="virtual">Reloj Virtual (0% CPU)</option>
                    <option value="ffmpeg">FFmpeg HLS Continuo (Auto-Start)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">ID EPG Automático</label>
                  <input
                    type="text"
                    value={form.epg_channel_id}
                    onChange={(e) => setForm({ ...form, epg_channel_id: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Perfil Transcodificador</label>
                  <select
                    value={form.transcode_profile_id}
                    onChange={(e) => setForm({ ...form, transcode_profile_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">Logo URL</label>
                  <input
                    type="text"
                    value={form.logo_url}
                    onChange={(e) => setForm({ ...form, logo_url: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono"
                    placeholder="https://..."
                  />
                </div>
              </div>

              {/* Tipo de fuente del canal */}
              <div className="p-4 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3">
                <div className="font-semibold text-white flex items-center gap-2">
                  <Radio className="w-4 h-4 text-cyan-400" />
                  ¿De dónde sale la señal de este canal?
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, source_kind: 'playlist' })}
                    className={`text-left px-3 py-2.5 rounded-xl border transition ${
                      form.source_kind !== 'youtube'
                        ? 'bg-indigo-600/20 border-indigo-500/60 text-white'
                        : 'bg-[#0e1526] border-slate-700 text-slate-300 hover:border-slate-500'
                    }`}
                  >
                    <div className="font-semibold flex items-center gap-1.5">
                      <Film className="w-3.5 h-3.5" /> Parrilla 24/7
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Películas del catálogo o enlaces MP4/HLS en bucle continuo.
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setForm({ ...form, source_kind: 'youtube', engine_mode: 'ffmpeg' });
                      if (!ytStatus) loadYtStatus();
                    }}
                    className={`text-left px-3 py-2.5 rounded-xl border transition ${
                      form.source_kind === 'youtube'
                        ? 'bg-red-600/20 border-red-500/60 text-white'
                        : 'bg-[#0e1526] border-slate-700 text-slate-300 hover:border-slate-500'
                    }`}
                  >
                    <div className="font-semibold flex items-center gap-1.5">
                      <Youtube className="w-3.5 h-3.5 text-red-400" /> Señal de YouTube (directo, vídeo o lista)
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Directo tal cual, un vídeo repetido en bucle o una lista completa que da la vuelta sola.
                    </div>
                  </button>
                </div>
              </div>

              {/* Señal en vivo de YouTube */}
              {form.source_kind === 'youtube' && (
                <div className="p-4 rounded-xl bg-[#090e1a] border border-red-500/30 space-y-3">
                  <div className="font-semibold text-red-300 flex items-center gap-2">
                    <Youtube className="w-4 h-4" />
                    Enlace de YouTube
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Vale cualquiera de estos tres: el <span className="text-slate-200">directo</span> (…/live/… o
                    /@canal/live), un <span className="text-slate-200">vídeo suelto</span> (watch?v=…, youtu.be/…,
                    /shorts/…) que se repite sin fin, o una <span className="text-slate-200">lista completa</span>
                    (playlist?list=…) que emite sus vídeos en orden y vuelve a empezar.
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={form.live_source_url}
                      onChange={(e) => {
                        setForm({ ...form, live_source_url: e.target.value });
                        setFmtDiag(null);
                      }}
                      placeholder="…/@canal/live · …/watch?v=… · …/playlist?list=…"
                      className="flex-1 px-3 py-2 rounded-xl bg-[#0e1526] border border-slate-700 text-white font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleProbe}
                      disabled={probe?.busy}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold disabled:opacity-50"
                    >
                      {probe?.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                      {probe?.installing
                        ? 'Instalando yt-dlp…'
                        : probe?.preparing
                          ? 'Preparando lista…'
                          : probe?.downloading
                            ? 'Descargando…'
                            : 'Comprobar señal'}
                    </button>
                  </div>

                  {watchListHint && (
                    <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2">
                      <span>
                        Ese enlace trae <b className="text-slate-200">vídeo + lista</b>: se emitirá la{' '}
                        <b className="text-slate-200">lista completa</b> (hasta 30 vídeos, en orden). Si quieres
                        sólo ese vídeo repetido en bucle, quita la lista.
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const u = String(form.live_source_url || '');
                          const clean = u
                            .replace(/([?&])list=[^&]*&?/g, '$1')
                            .replace(/[?&]$/, '')
                            .replace(/([?&])index=\d+&?/g, '$1')
                            .replace(/[?&]$/, '');
                          setForm((prev) => ({ ...prev, live_source_url: clean }));
                          setProbe(null);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 font-semibold"
                      >
                        <X className="w-3 h-3" /> Sólo ese vídeo
                      </button>
                    </div>
                  )}

                  {probe?.preparing && (
                    <div className="text-[11px] text-teal-300 flex items-start gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin shrink-0 mt-0.5" />
                      <span>
                        {probe.step || 'preparando la lista…'}
                        <span className="text-slate-500">
                          {' '}
                          — se descargan una vez y luego se emiten desde el disco; puedes seguir usando el panel.
                        </span>
                      </span>
                    </div>
                  )}

                  {probe?.prepared && (
                    <div className="text-[11px] text-teal-300 flex items-start gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{probe.prepared}</span>
                    </div>
                  )}

                  {probe?.downloaded && (
                    <div className="text-[11px] text-teal-300 flex items-start gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{probe.downloaded}</span>
                    </div>
                  )}

                  {probe?.installing && (
                    <div className="text-[11px] text-cyan-300 flex items-start gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin shrink-0 mt-0.5" />
                      <span>
                        {probe.step || 'instalando…'}
                        <span className="text-slate-500">
                          {' '}
                          — si baja el binario autónomo son ~39 MB; puedes seguir usando el panel.
                        </span>
                      </span>
                    </div>
                  )}

                  {probe && !probe.busy && (
                    <div
                      className={`rounded-xl px-3 py-2 text-[11px] border ${
                        probe.ready || probe.live
                          ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
                          : 'bg-amber-500/10 border-amber-500/40 text-amber-200'
                      }`}
                    >
                      {probe.ready && probe.mode === 'playlist' ? (
                        <div className="space-y-1">
                          <div className="font-bold flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" /> LISTA · {probe.entries} vídeos
                            {probe.title ? ` — ${probe.title}` : ''}
                          </div>
                          <div>
                            {Math.floor((probe.total_duration_sec || 0) / 3600)}h{' '}
                            {Math.round(((probe.total_duration_sec || 0) % 3600) / 60)}m en total ·
                            se emiten en orden y vuelven a empezar
                            {probe.needs_transcode ? ' · se recodifican a H.264 1080p' : ' · sin recodificar'}
                          </div>
                          <div className="text-emerald-100/80">
                            ▶ Se emite tal cual desde YouTube{probe.separated_audio ? ' (uniendo vídeo y audio)' : ''}:{' '}
                            <b>no ocupa disco</b>.
                          </div>
                          {(probe.entry_titles || []).length > 0 && (
                            <div className="text-emerald-100/80 space-y-0.5">
                              {probe.entry_titles.slice(0, 5).map((t, i) => (
                                <div key={i} className="truncate">
                                  {i + 1}. {t}
                                </div>
                              ))}
                              {probe.entries > 5 ? <div>… y {probe.entries - 5} más</div> : null}
                            </div>
                          )}
                          {probe.skipped_live > 0 && (
                            <div className="text-amber-300">
                              {probe.skipped_live} directo(s) de la lista se omiten: un directo no se puede encolar.
                            </div>
                          )}
                          {probe.skipped_no_format > 0 && (
                            <div className="text-amber-300">
                              {probe.skipped_no_format} vídeo(s) sin MP4 utilizable se omiten.
                            </div>
                          )}
                        </div>
                      ) : probe.ready && probe.mode === 'video' ? (
                        <div className="space-y-0.5">
                          <div className="font-bold flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" /> VÍDEO EN BUCLE
                            {probe.title ? ` — ${probe.title}` : ''}
                          </div>
                          <div>
                            {Math.floor((probe.duration_sec || 0) / 60)}m{' '}
                            {Math.round((probe.duration_sec || 0) % 60)}s · se repite sin fin desde YouTube
                            {probe.needs_transcode ? ' · se recodifica a H.264 1080p' : ' · sin recodificar'}
                            {probe.expires_in_min !== null && probe.expires_in_min !== undefined
                              ? ` · la URL se renovará en ${probe.expires_in_min} min`
                              : ''}
                          </div>
                        </div>
                      ) : probe.live ? (
                        <div className="space-y-0.5">
                          <div className="font-bold flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" /> EN VIVO
                            {probe.title ? ` — ${probe.title}` : ''}
                          </div>
                          <div>
                            {probe.uploader ? `${probe.uploader} · ` : ''}
                            HLS listo para copiar
                            {probe.separated_audio ? ' · vídeo y audio en pistas separadas (se unen al copiar)' : ''}
                            {probe.expires_in_min !== null && probe.expires_in_min !== undefined
                              ? ` · la URL se renovará en ${probe.expires_in_min} min`
                              : ''}
                          </div>
                          <div className="text-emerald-100/80">
                            ⧉ Copy/copy: no se recodifica nada (0 % de CPU de vídeo).
                          </div>
                        </div>
                      ) : probe.installed ? (
                        <div className="font-bold flex items-center gap-1.5 text-emerald-200">
                          <CheckCircle2 className="w-3.5 h-3.5" /> {probe.installed}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {probe.blocked_bot && (
                            <div className="flex items-center gap-1.5 font-bold text-amber-200">
                              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                              Verificación anti-robots de YouTube (no es la lista ni el vídeo)
                            </div>
                          )}
                          <div className="flex items-start gap-1.5">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>{probe.error || 'No hay directo disponible en ese enlace.'}</span>
                          </div>
                          {Array.isArray(probe.reasons) && probe.reasons.length > 0 && (
                            <div className="text-emerald-100/80">
                              Motivo: {probe.reasons.join(' · ')}
                            </div>
                          )}
                          {probe.skip_summary && (
                            <div className="text-slate-400">
                              En esta lista: {probe.skip_summary}
                            </div>
                          )}
                          {probe.needs_ytdlp && (
                            <button
                              type="button"
                              onClick={handleInstallYtdlp}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white font-bold"
                            >
                              <Download className="w-3.5 h-3.5" /> Instalar yt-dlp
                            </button>
                          )}
                          {probe.can_prepare_playlist && (
                            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                              <button
                                type="button"
                                onClick={handlePreparePlaylist}
                                disabled={probe?.busy}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-bold disabled:opacity-50"
                              >
                                {probe.preparing ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Download className="w-3.5 h-3.5" />
                                )}
                                {probe.preparing ? 'Guardando…' : 'Guardar copia en el disco'}
                              </button>
                              <label className="inline-flex items-center gap-1 text-slate-300">
                                Vídeos:
                                <input
                                  type="number"
                                  min={1}
                                  max={30}
                                  value={prepareLimit}
                                  onChange={(e) => setPrepareLimit(Math.max(1, Math.min(30, Number(e.target.value) || 10)))}
                                  className="w-14 px-1.5 py-0.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                                />
                              </label>
                              <span className="text-emerald-100/80">
                                Opcional: guarda los capítulos en el disco. La lista se emite igual sin descargar.
                                {probe.pending_count ? ` Hay ${probe.pending_count} disponibles.` : ''}
                              </span>
                              {probe.pending_count ? (
                                <span className="text-[11px] text-slate-300">
                                  Ocuparían ≈ <b>{fmtBytes(probe.pending_bytes || 0)}</b> · disco libre{' '}
                                  <b>{fmtBytes(probe.disk?.free_bytes || ytStatus?.videos?.free_bytes)}</b>. Si no caben,
                                  se preparan sólo los que quepan.
                                </span>
                              ) : null}
                            </div>
                          )}
                          {probe.needs_download && (
                            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                              <button
                                type="button"
                                onClick={handleDownloadVideo}
                                disabled={probe?.busy}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-bold disabled:opacity-50"
                              >
                                {probe.downloading ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Download className="w-3.5 h-3.5" />
                                )}
                                {probe.downloading ? 'Descargando…' : 'Descargar vídeo (una vez)'}
                              </button>
                              <span className="text-emerald-100/80">
                                Se guarda en el servidor y se repite desde el disco: sin caducidad ni volver a YouTube.
                              </span>
                            </div>
                          )}
                          {probe.needs_format_fix && (
                            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                              <button
                                type="button"
                                onClick={handleInstallYtdlp}
                                disabled={probe?.busy}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white font-bold disabled:opacity-50"
                              >
                                <Download className="w-3.5 h-3.5" /> Actualizar yt-dlp
                              </button>
                              <span className="text-emerald-100/80">
                                YouTube cambia cada pocas semanas; al terminar se vuelve a comprobar el enlace solo.
                                {probe.clients_tried ? ` (probado con: ${probe.clients_tried})` : ''}
                              </span>
                            </div>
                          )}
                          {probe.needs_cookies && (
                            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setCookiesMsg(null);
                                  cookiesFileRef.current?.click();
                                }}
                                disabled={cookiesBusy}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white font-bold disabled:opacity-50"
                              >
                                {cookiesBusy ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Download className="w-3.5 h-3.5" />
                                )}
                                Subir cookies
                              </button>
                              <span className="text-emerald-100/80">
                                Es un .txt exportado de youtube.com («Get cookies.txt LOCALLY»). Al subirlo se vuelve a
                                comprobar el enlace solo.
                              </span>
                            </div>
                          )}
                          <div className="pt-0.5">
                            <button
                              type="button"
                              onClick={handleShowFormats}
                              disabled={fmtDiag?.busy}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 font-semibold disabled:opacity-50"
                            >
                              {fmtDiag?.busy ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Terminal className="w-3 h-3" />
                              )}
                              Ver qué formatos ve yt-dlp
                            </button>
                          </div>
                          {fmtDiag?.text && (
                            <div className="mt-1 rounded-lg bg-black/40 border border-slate-700 p-2">
                              <div className="text-[10px] text-slate-400 mb-1">
                                Salida de <code>yt-dlp -F</code> para este enlace
                                {fmtDiag.client ? ` · cliente ${fmtDiag.client}` : ''}:
                              </div>
                              <pre className="text-[10px] leading-tight text-slate-300 overflow-x-auto whitespace-pre">
                                {fmtDiag.text}
                              </pre>
                            </div>
                          )}
                          {fmtDiag?.error && !fmtDiag?.busy && (
                            <div className="text-[10px] text-rose-300">{fmtDiag.error}</div>
                          )}
                          {probe.detail && (
                            <details className="text-[10px] text-slate-500">
                              <summary className="cursor-pointer">detalle técnico</summary>
                              <div className="mt-1 font-mono break-all text-slate-500">{probe.detail}</div>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {ytStatus?.installed ? (
                      <span className="text-emerald-300">
                        yt-dlp {ytStatus.version || ''} listo ({ytStatus.bin})
                      </span>
                    ) : (
                      <>
                        <span className="text-amber-300">
                          {ytStatus?.bin && ytStatus?.error
                            ? 'yt-dlp está descargado pero no arranca.'
                            : 'yt-dlp no está instalado.'}
                        </span>
                        <button
                          type="button"
                          onClick={handleInstallYtdlp}
                          disabled={probe?.busy}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 font-bold disabled:opacity-50"
                        >
                          <Download className="w-3 h-3" /> Instalar yt-dlp
                        </button>
                      </>
                    )}
                    {ytStatus?.installed && ytStatus.update_available && (
                      <>
                        <span className="text-amber-300">
                          Hay una versión nueva de yt-dlp ({ytStatus.latest_version}): si YouTube falla con algún
                          enlace, actualízalo.
                        </span>
                        <button
                          type="button"
                          onClick={handleInstallYtdlp}
                          disabled={probe?.busy}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 font-bold disabled:opacity-50"
                        >
                          <RefreshCw className="w-3 h-3" /> Actualizar yt-dlp
                        </button>
                      </>
                    )}
                    {probe?.using_cookies && (
                      <span className="text-emerald-300" title="Se está usando el archivo de cookies de youtube.com">
                        · con cookies de YouTube
                      </span>
                    )}
                    <span className="text-slate-500">
                      El panel renueva el enlace antes de que caduque: el canal no se corta.
                    </span>
                  </div>

                  {!ytStatus?.installed && ytStatus?.hint && (
                    <div className="text-[11px] text-amber-300/90 flex items-start gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{ytStatus.hint}</span>
                    </div>
                  )}

                  {/* Cookies: la única salida limpia al «no eres un robot» de YouTube */}
                  <details
                    open={Boolean(probe?.needs_cookies)}
                    className="rounded-xl bg-[#0e1526] border border-slate-800 px-3 py-2"
                  >
                    <summary className="cursor-pointer text-[11px] text-slate-400">
                      ¿YouTube dice «Sign in to confirm you’re not a bot»? Usa cookies
                      {ytStatus?.cookies?.usable ? (
                        <span
                          className={
                            ytStatus.cookies.auth ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'
                          }
                        >
                          {' '}
                          · {ytStatus.cookies.auth ? 'activas' : 'SIN sesión'} ({ytStatus.cookies.count} de youtube.com
                          {ytStatus.cookies.expired_auth
                            ? ', caducadas'
                            : ytStatus.cookies.auth
                              ? `, con sesión${ytStatus.cookies.auth_expires_iso ? ` hasta ${ytStatus.cookies.auth_expires_iso}` : ''}`
                              : ''})
                        </span>
                      ) : (
                        ''
                      )}
                    </summary>
                    <div className="mt-2 space-y-2">
                      <input
                        ref={cookiesFileRef}
                        type="file"
                        accept=".txt,text/plain"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) handleUploadCookies(f);
                        }}
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => cookiesFileRef.current?.click()}
                          disabled={cookiesBusy}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold disabled:opacity-50"
                        >
                          {cookiesBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                          {cookiesBusy ? 'Comprobando…' : 'Subir cookies (.txt)'}
                        </button>
                        {ytStatus?.cookies?.usable && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch('/api/youtube/cookies', { method: 'DELETE' });
                                await loadYtStatus();
                                setCookiesMsg({ ok: true, text: 'Cookies borradas: el panel leerá YouTube sin sesión.' });
                              } catch (err) {
                                setCookiesMsg({ ok: false, text: err.message });
                              }
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 font-semibold"
                          >
                            <Trash2 className="w-3 h-3" /> Quitar
                          </button>
                        )}
                        {ytStatus?.cookies?.usable && (
                          <button
                            type="button"
                            onClick={handleTestCookies}
                            disabled={cookiesBusy}
                            className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 font-semibold disabled:opacity-50"
                          >
                            {cookiesBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Probar cookies
                          </button>
                        )}
                      </div>

                      {cookiesMsg && (
                        <div className={`text-[11px] flex items-start gap-1 ${cookiesMsg.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {cookiesMsg.ok ? (
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          )}
                          <span>{cookiesMsg.text}</span>
                        </div>
                      )}

                      {ytStatus?.cookies?.usable && (
                        <div
                          className={`text-[10px] ${
                            ytStatus.cookies.expired_auth
                              ? 'text-rose-300'
                              : ytStatus.cookies.auth
                                ? ytStatus.cookies.auth_days_left !== null && ytStatus.cookies.auth_days_left <= 3
                                  ? 'text-amber-300'
                                  : 'text-emerald-300'
                                : 'text-amber-300'
                          }`}
                        >
                          {ytStatus.cookies.expired_auth
                            ? 'La sesión de este archivo ha caducado: vuelve a exportarlo.'
                            : ytStatus.cookies.auth
                              ? `Sesión iniciada con estas cookies${
                                  ytStatus.cookies.auth_expires_iso
                                    ? ` (válida hasta el ${ytStatus.cookies.auth_expires_iso}${
                                        ytStatus.cookies.auth_days_left !== null
                                          ? `, quedan ${ytStatus.cookies.auth_days_left} días`
                                          : ''
                                      })`
                                    : ''
                                }.`
                              : 'El archivo no trae la sesión (falta SID): YouTube seguirá tratando al panel como visitante.'}
                        </div>
                      )}

                      <div className="text-[10px] text-slate-500 space-y-1">
                        <div>
                          <b className="text-slate-300">Por qué un archivo y no usuario/contraseña:</b> YouTube (Google)
                          no permite que un programa inicie sesión con la contraseña; yt-dlp lo rechaza
                          explícitamente. La sesión se le da con este <code className="text-slate-400">.txt</code>,
                          que son las cookies de tu navegador ya con la sesión iniciada: es lo mismo que haber
                          iniciado sesión, pero sin darle la contraseña al servidor.
                        </div>
                        <div>
                          <b className="text-slate-300">Cómo:</b> abre <b>youtube.com</b> en tu PC con la sesión
                          iniciada → extensión «<b>Get cookies.txt LOCALLY</b>» → Export → sube aquí el{' '}
                          <code className="text-slate-400">.txt</code>. Se guarda en el servidor con permisos 600 y se
                          usa solo, sin reiniciar nada.
                        </div>
                        <div>
                          El archivo debe ser el <b>formato Netscape</b> (columnas separadas por tabuladores). Las
                          cookies caducan en días: si vuelve el aviso, expórtalas otra vez.
                        </div>
                      </div>

                      <details className="pt-1">
                        <summary className="cursor-pointer text-[10px] text-slate-500">
                          Ya tengo el archivo en el servidor: indicar ruta
                        </summary>
                        <div className="mt-2 flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={cookiesPath}
                            onChange={(e) => setCookiesPath(e.target.value)}
                            placeholder="/opt/tvlister24-7/.runtime/youtube-cookies.txt"
                            className="flex-1 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white font-mono text-[11px]"
                          />
                          <button
                            type="button"
                            onClick={handleSaveCookies}
                            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-white font-semibold"
                          >
                            Guardar ruta
                          </button>
                        </div>
                        {ytStatus?.cookies?.path && (
                          <div className="mt-1 text-[10px] text-slate-500">
                            {ytStatus.cookies.path}
                            {ytStatus.cookies.exists
                              ? ytStatus.cookies.ok
                                ? ` · ${ytStatus.cookies.count} cookies (${ytStatus.cookies.youtube} de youtube.com)${ytStatus.cookies.auth ? ' · con sesión' : ' · SIN sesión'}`
                                : ` · no sirve: ${ytStatus.cookies.error}`
                              : ' · no existe'}
                          </div>
                        )}
                      </details>
                    </div>
                  </details>
                </div>
              )}

              {/* Add from VOD Library */}
              <div
                className={`p-4 rounded-xl bg-[#090e1a] border border-slate-800 space-y-3 ${
                  form.source_kind === 'youtube' ? 'hidden' : ''
                }`}
              >
                <div className="font-semibold text-indigo-300 flex items-center gap-2">
                  <Film className="w-4 h-4" />
                  1. Agregar Película desde Biblioteca VOD
                </div>
                <div className="flex flex-wrap gap-2">
                  {vodList.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => addVodToPlaylist(v.id)}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-indigo-600/30 border border-slate-700 hover:border-indigo-500/50 text-slate-200 transition"
                    >
                      + {v.title} ({Math.round(v.duration_sec / 60)}m)
                    </button>
                  ))}
                </div>

                <div className="pt-2 border-t border-slate-800/80">
                  <div className="text-slate-400 mb-2 font-medium">O agregar URL MP4 / HLS externa directa:</div>
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                    <input
                      type="text"
                      value={customTitle}
                      onChange={(e) => setCustomTitle(e.target.value)}
                      placeholder="Título del programa"
                      className="sm:col-span-4 px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                    />
                    <input
                      type="text"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      placeholder="https://.../video.mp4"
                      className="sm:col-span-5 px-3 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white font-mono"
                    />
                    <input
                      type="number"
                      value={customDur}
                      onChange={(e) => setCustomDur(Number(e.target.value))}
                      placeholder="Segs"
                      className="sm:col-span-2 px-2 py-1.5 rounded-lg bg-[#0e1526] border border-slate-700 text-white"
                    />
                    <button
                      type="button"
                      onClick={addCustomClip}
                      className="sm:col-span-1 px-2 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              {/* Playlist Sequence */}
              <div className={form.source_kind === 'youtube' ? 'hidden' : ''}>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-white">
                    Secuencia de Emisión Continua ({form.playlist.length} bloques)
                  </span>
                  <span className="text-slate-400">
                    Duración ciclo:{' '}
                    {Math.round(form.playlist.reduce((a, b) => a + (Number(b.duration_sec) || 0), 0) / 60)} min
                  </span>
                </div>

                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                  {form.playlist.map((clip, idx) => (
                    <div
                      key={clip.id || idx}
                      className="px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-800 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <span className="font-mono text-indigo-400 mr-2">#{idx + 1}</span>
                        <span className="font-medium text-white">{clip.title}</span>
                        <span className="text-slate-500 ml-2">({Math.round(clip.duration_sec / 60)} min)</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => moveClip(idx, -1)}
                          className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveClip(idx, 1)}
                          className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeClip(idx)}
                          className="p-1 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-300"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                >
                  {form.source_kind === 'youtube' ? 'Guardar Canal en Vivo 24/7' : 'Guardar Parrilla 24/7'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EPG Schedule Modal */}
      {epgModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-[#0e1526] border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 bg-[#131c31] border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                Guía EPG Generada Automáticamente — {epgModal.name}
              </h3>
              <button onClick={() => setEpgModal(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 max-h-96 overflow-y-auto space-y-2 text-xs">
              {(epgModal.liveState?.schedule || []).map((slot) => (
                <div
                  key={slot.slot}
                  className={`p-3 rounded-xl border flex items-center justify-between ${
                    slot.is_current
                      ? 'bg-indigo-600/20 border-indigo-500/40 text-white'
                      : 'bg-[#090e1a] border-slate-800 text-slate-300'
                  }`}
                >
                  <div>
                    <div className="font-semibold">{slot.title}</div>
                    <div className="text-[11px] text-slate-400 font-mono">
                      {new Date(slot.start_iso).toLocaleTimeString()} — {new Date(slot.end_iso).toLocaleTimeString()}
                    </div>
                  </div>
                  {slot.is_current && (
                    <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                      EN VIVO
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* FFmpeg 24/7 Playout Command Modal */}
      {ffmpegModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#0e1526] border border-slate-800 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                Motor Playout FFmpeg 24/7 — {ffmpegModal.name}
              </h3>
              <button onClick={() => setFfmpegModal(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <pre className="p-4 rounded-xl bg-[#070b13] border border-slate-800 text-xs font-mono text-emerald-300 whitespace-pre-wrap break-all">
              {ffmpegModal.ffmpegCommand}
            </pre>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-slate-400">
                En tu VPS con FFmpeg genera segmentos HLS continuos propios sin depender de redirección.
              </span>
              <button
                onClick={async () => {
                  await handleAction(ffmpegModal.id, 'start_ffmpeg');
                  setFfmpegModal(null);
                }}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
              >
                Iniciar Worker FFmpeg 24/7 en Servidor
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
