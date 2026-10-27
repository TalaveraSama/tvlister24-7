import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  ArrowLeft,
  Radio,
  Tv2,
  Film,
  Heart,
  Gauge,
  AlertTriangle,
  Search,
  Send,
  Bell,
  Play
} from 'lucide-react';

export default function WebTvPortal({ onBackToAdmin }) {
  const [creds, setCreds] = useState({ username: 'demo', password: 'demo123' });
  const [loggedLine, setLoggedLine] = useState(null);
  const [loginError, setLoginError] = useState('');

  const [catalog, setCatalog] = useState({
    streams: [],
    channels247: [],
    vodItems: [],
    osdMessages: []
  });
  const [section, setSection] = useState('all'); // all | live | ch247 | vod | favs
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('tvlister_favs') || '[]');
    } catch {
      return [];
    }
  });

  const [selected, setSelected] = useState(null);
  const [speedResult, setSpeedResult] = useState(null);
  const [testingSpeed, setTestingSpeed] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimMsg, setClaimMsg] = useState('');
  const [claimSent, setClaimSent] = useState('');

  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  const handleLogin = async (e) => {
    if (e) e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('/api/webtv/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error de acceso');
      setLoggedLine(data.line);
      loadCatalog(creds.username, creds.password, true);
    } catch (err) {
      setLoginError(err.message);
    }
  };

  const loadCatalog = async (u, p, autoPlayFirst = false) => {
    const res = await fetch(
      `/api/webtv/catalog?username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}`
    );
    if (!res.ok) return;
    const data = await res.json();
    setCatalog(data);
    if (autoPlayFirst && !selected) {
      if (data.channels247?.length > 0) {
        const ch = data.channels247[0];
        setSelected({
          uid: `ch247-${ch.id}`,
          kind: 'channel247',
          id: ch.id,
          name: ch.name,
          url: ch.liveState?.currentItem?.url,
          seekOffsetSec: ch.liveState?.seekOffsetSec || 0,
          watermark: ch.watermark_text,
          subtitle: ch.liveState?.currentItem?.title || 'Señal 24/7'
        });
      } else if (data.streams?.length > 0) {
        const s = data.streams[0];
        setSelected({
          uid: `live-${s.id}`,
          kind: 'live',
          id: s.id,
          name: s.name,
          url: s.source_url,
          seekOffsetSec: 0,
          subtitle: s.epg?.[0]?.title || s.category_name
        });
      }
    }
  };

  // Heartbeat & OSD polling
  useEffect(() => {
    if (!loggedLine || !selected) return;
    const sendPing = async () => {
      try {
        const res = await fetch('/api/webtv/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: creds.username,
            password: creds.password,
            target_type: selected.kind,
            target_id: selected.id,
            target_name: selected.name
          })
        });
        if (res.ok) {
          const d = await res.json();
          if (d.osdMessages) {
            setCatalog((prev) => ({ ...prev, osdMessages: d.osdMessages }));
          }
        }
      } catch {
        // ignore
      }
    };
    sendPing();
    const timer = setInterval(sendPing, 10000);
    return () => clearInterval(timer);
  }, [loggedLine, selected]);

  // Attach Video / HLS
  useEffect(() => {
    if (!selected?.url || !videoRef.current) return;
    const video = videoRef.current;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isHls = selected.url.toLowerCase().includes('.m3u8');
    const onMeta = () => {
      if (selected.seekOffsetSec > 1 && video.duration && selected.seekOffsetSec < video.duration - 2) {
        video.currentTime = selected.seekOffsetSec;
      }
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });
    };

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true });
      hlsRef.current = hls;
      hls.loadSource(selected.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {
          video.muted = true;
          video.play().catch(() => {});
        });
      });
    } else {
      video.src = selected.url;
      video.addEventListener('loadedmetadata', onMeta);
    }

    return () => {
      video.removeEventListener('loadedmetadata', onMeta);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [selected?.url, selected?.uid]);

  const toggleFav = (uid) => {
    const next = favorites.includes(uid) ? favorites.filter((x) => x !== uid) : [...favorites, uid];
    setFavorites(next);
    localStorage.setItem('tvlister_favs', JSON.stringify(next));
  };

  const runSpeedTest = async () => {
    setTestingSpeed(true);
    try {
      const t0 = performance.now();
      const res = await fetch('/api/webtv/speedtest?kb=384');
      const buf = await res.arrayBuffer();
      const elapsedSec = Math.max(0.01, (performance.now() - t0) / 1000);
      const mbps = ((buf.byteLength * 8) / (elapsedSec * 1_000_000)).toFixed(1);
      const pingMs = Math.round(elapsedSec * 180);
      setSpeedResult({ mbps, pingMs });
    } finally {
      setTestingSpeed(false);
    }
  };

  const submitClaim = async (e) => {
    e.preventDefault();
    if (!selected) return;
    await fetch('/api/webtv/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: creds.username,
        password: creds.password,
        stream_name: selected.name,
        issue_type: 'cliente_webtv',
        message: claimMsg || 'Revisión solicitada desde WebTV'
      })
    });
    setClaimSent('Reporte enviado al equipo técnico.');
    setClaimMsg('');
    setTimeout(() => {
      setClaimSent('');
      setClaimOpen(false);
    }, 1800);
  };

  if (!loggedLine) {
    return (
      <div className="min-h-screen bg-[#070b13] flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl bg-[#0e1526] border border-slate-800 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Midnight WebTV Client Player</h2>
            <button
              onClick={onBackToAdmin}
              className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Panel Admin
            </button>
          </div>
          <p className="text-xs text-slate-400">
            Ingresa los datos de tu línea de suscriptor para ver Canales en Vivo, Canales 24/7 y Películas VOD en HTML5.
          </p>
          {loginError && (
            <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-xs text-rose-300">
              {loginError}
            </div>
          )}
          <form onSubmit={handleLogin} className="space-y-3 text-xs">
            <div>
              <label className="block text-slate-300 mb-1">Usuario de Línea</label>
              <input
                type="text"
                value={creds.username}
                onChange={(e) => setCreds({ ...creds, username: e.target.value })}
                className="w-full px-3 py-2.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-300 mb-1">Contraseña</label>
              <input
                type="password"
                value={creds.password}
                onChange={(e) => setCreds({ ...creds, password: e.target.value })}
                className="w-full px-3 py-2.5 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
            >
              Entrar a WebTV (demo / demo123)
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Unified items list
  const unifiedItems = [
    ...catalog.channels247.map((c) => ({
      uid: `ch247-${c.id}`,
      kind: 'channel247',
      id: c.id,
      name: c.name,
      logo: c.logo_url,
      badge: '24/7',
      url: c.liveState?.currentItem?.url,
      seekOffsetSec: c.liveState?.seekOffsetSec || 0,
      watermark: c.watermark_text,
      subtitle: c.liveState?.currentItem ? `Ahora: ${c.liveState.currentItem.title}` : 'Programación 24/7'
    })),
    ...catalog.streams.map((s) => ({
      uid: `live-${s.id}`,
      kind: 'live',
      id: s.id,
      name: s.name,
      logo: s.logo_url,
      badge: 'LIVE',
      url: s.source_url,
      seekOffsetSec: 0,
      subtitle: s.epg?.[0]?.title || s.category_name
    })),
    ...catalog.vodItems.map((v) => ({
      uid: `vod-${v.id}`,
      kind: 'vod',
      id: v.id,
      name: v.title,
      logo: v.poster_url,
      badge: 'VOD',
      url: v.source_url,
      seekOffsetSec: 0,
      subtitle: `${v.genre} • ${v.release_year}`
    }))
  ].filter((it) => {
    if (section === 'live' && it.kind !== 'live') return false;
    if (section === 'ch247' && it.kind !== 'channel247') return false;
    if (section === 'vod' && it.kind !== 'vod') return false;
    if (section === 'favs' && !favorites.includes(it.uid)) return false;
    if (search && !it.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-[#070b13] text-slate-100 flex flex-col">
      {/* Topbar */}
      <header className="px-5 py-3 bg-[#0d1322] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBackToAdmin}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Volver al Panel
          </button>
          <span className="font-bold text-sm text-white">
            TVLister <span className="text-emerald-400">WebTV</span> • {loggedLine.username}
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={runSpeedTest}
            disabled={testingSpeed}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300"
          >
            <Gauge className="w-3.5 h-3.5" />
            {testingSpeed
              ? 'Midiendo...'
              : speedResult
              ? `${speedResult.mbps} Mbps`
              : 'Test Velocidad'}
          </button>

          <button
            onClick={() => setClaimOpen(!claimOpen)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Reportar Canal
          </button>
        </div>
      </header>

      {/* Main Split View */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12">
        {/* Left Channel List */}
        <div className="lg:col-span-4 xl:col-span-3 border-r border-slate-800 bg-[#0b101d] flex flex-col max-h-[calc(100vh-57px)]">
          <div className="p-3 space-y-2.5 border-b border-slate-800">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar canal, 24/7 o película..."
                className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#070b13] border border-slate-800 text-xs text-white"
              />
            </div>

            <div className="grid grid-cols-5 gap-1 text-[11px] font-semibold">
              {[
                { id: 'all', label: 'Todo' },
                { id: 'ch247', label: '24/7' },
                { id: 'live', label: 'En Vivo' },
                { id: 'vod', label: 'VOD' },
                { id: 'favs', label: '★ Fav' }
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSection(t.id)}
                  className={`py-1.5 rounded-lg transition ${
                    section === t.id ? 'bg-indigo-600 text-white' : 'bg-slate-800/70 text-slate-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/50">
            {unifiedItems.map((it) => {
              const active = selected?.uid === it.uid;
              const isFav = favorites.includes(it.uid);
              return (
                <div
                  key={it.uid}
                  onClick={() => setSelected(it)}
                  className={`p-3 flex items-center justify-between gap-2.5 cursor-pointer transition ${
                    active ? 'bg-indigo-600/20 border-l-4 border-indigo-500' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-slate-800 overflow-hidden flex items-center justify-center shrink-0">
                      {it.logo ? (
                        <img src={it.logo} alt={it.name} className="w-full h-full object-cover" />
                      ) : it.kind === 'channel247' ? (
                        <Tv2 className="w-4 h-4 text-violet-400" />
                      ) : it.kind === 'vod' ? (
                        <Film className="w-4 h-4 text-cyan-400" />
                      ) : (
                        <Radio className="w-4 h-4 text-emerald-400" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white truncate flex items-center gap-1.5">
                        <span className="px-1.5 py-0.2 rounded bg-slate-800 text-[9px] text-indigo-300 font-bold">
                          {it.badge}
                        </span>
                        {it.name}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate">{it.subtitle}</div>
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFav(it.uid);
                    }}
                    className="p-1.5 text-slate-500 hover:text-rose-400"
                  >
                    <Heart className={`w-4 h-4 ${isFav ? 'fill-rose-500 text-rose-500' : ''}`} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Video Player Stage */}
        <div className="lg:col-span-8 xl:col-span-9 p-5 flex flex-col justify-between bg-[#070b13]">
          <div className="space-y-4">
            {/* Active OSD Messages from Admin */}
            {catalog.osdMessages?.map((m) => (
              <div
                key={m.id}
                className="px-4 py-2.5 rounded-xl bg-indigo-600/25 border border-indigo-500/40 text-xs text-indigo-100 flex items-center gap-2 animate-pulse"
              >
                <Bell className="w-4 h-4 text-indigo-300 shrink-0" />
                <span>{m.message}</span>
              </div>
            ))}

            {/* Video Container */}
            <div className="relative rounded-2xl overflow-hidden bg-black border border-slate-800 aspect-video shadow-2xl">
              {selected ? (
                <>
                  <video ref={videoRef} controls playsInline className="w-full h-full object-contain" />
                  {selected.watermark && (
                    <div className="pointer-events-none absolute top-4 right-5 px-3 py-1 rounded bg-black/55 border border-white/15 text-xs font-bold tracking-wider text-white/85">
                      {selected.watermark}
                    </div>
                  )}
                </>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 text-sm">
                  <Play className="w-10 h-10 mb-2 opacity-50" />
                  Selecciona un canal o película a la izquierda
                </div>
              )}
            </div>

            {selected && (
              <div className="p-4 rounded-2xl bg-[#0e1526] border border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-white">{selected.name}</h2>
                  <p className="text-xs text-indigo-300 mt-0.5">{selected.subtitle}</p>
                </div>
                <span className="px-3 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-xs font-semibold">
                  Señal Directa HTML5 Activa
                </span>
              </div>
            )}

            {claimOpen && (
              <form
                onSubmit={submitClaim}
                className="p-4 rounded-2xl bg-[#0e1526] border border-amber-500/30 flex items-center gap-3 text-xs"
              >
                <input
                  type="text"
                  value={claimMsg}
                  onChange={(e) => setClaimMsg(e.target.value)}
                  placeholder={`Describe el problema con ${selected?.name || 'el canal'}...`}
                  className="flex-1 px-3 py-2 rounded-xl bg-[#090e1a] border border-slate-700 text-white"
                />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 text-slate-950 font-bold"
                >
                  <Send className="w-3.5 h-3.5" /> Enviar Reporte
                </button>
                {claimSent && <span className="text-emerald-400 font-semibold">{claimSent}</span>}
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
