import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { X, Radio, Volume2, VolumeX, RefreshCw, AlertTriangle, Tv } from 'lucide-react';
import { getToken } from '../lib/api.js';

function buildAdminProxiedUrl(rawUrl, item) {
  if (!rawUrl) return '';
  const jwt = getToken();
  if (!jwt) return rawUrl;

  // Already a relative public/proxy endpoint on this server
  if (
    rawUrl.startsWith('/api/admin/preview/') ||
    rawUrl.startsWith('/live/') ||
    rawUrl.startsWith('/movie/') ||
    rawUrl.startsWith('/series/') ||
    rawUrl.startsWith('/hls_out/') ||
    rawUrl.startsWith('/hls_proxy/')
  ) {
    return rawUrl;
  }

  // Proxy local disk paths (/mnt/...), 127.0.0.1 RTMP loopback, m4f://, mnf://, and external HTTP(S) streams
  // through the TVLister server so the Admin browser never hits 127.0.0.1 or CORS blocks!
  const params = new URLSearchParams({
    jwt,
    kind: item?.kind || 'live',
    id: String(item?.id || 0),
    url: rawUrl,
  });
  return `/api/admin/preview/stream?${params.toString()}`;
}

export default function VideoModal({ item, onClose }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const retryTimerRef = useRef(null);
  const [error, setError] = useState('');
  const [waitingIngest, setWaitingIngest] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [muted, setMuted] = useState(false);
  const [resolution, setResolution] = useState('');
  const [live247State, setLive247State] = useState(item?.liveState || null);
  const [diagnosis, setDiagnosis] = useState(null);
  const [diagBusy, setDiagBusy] = useState(false);

  useEffect(() => {
    setLive247State(item?.liveState || null);
  }, [item]);

  // Raw source URL & seek offset
  const rawActiveUrl =
    item?.kind === 'channel247'
      ? live247State?.currentItem?.url || item?.url
      : item?.url;

  const playableUrl = buildAdminProxiedUrl(rawActiveUrl, item);

  const initialSeek =
    item?.kind === 'channel247' ? Number(live247State?.seekOffsetSec || 0) : 0;

  const refresh247State = async () => {
    if (item?.kind !== 'channel247' || !item?.id) return;
    try {
      const res = await fetch(`/api/webtv/channel247/${item.id}/state`);
      if (res.ok) {
        const data = await res.json();
        setLive247State(data.liveState);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!playableUrl || !videoRef.current || !rawActiveUrl) return;
    setError('');
    setWaitingIngest(false);
    const video = videoRef.current;

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const lowerRaw = rawActiveUrl.toLowerCase();
    const isDirectFile = /\.(mp4|mkv|webm|mov|avi)(\?|$)/i.test(lowerRaw) && item?.kind !== 'live';
    const isHls =
      !isDirectFile &&
      (lowerRaw.includes('.m3u8') ||
        lowerRaw.startsWith('m4f') ||
        (item?.kind !== 'vod' && item?.kind !== 'series' && item?.kind !== 'channel247'));

    const onLoadedMeta = () => {
      if (video.videoWidth && video.videoHeight) {
        setResolution(`${video.videoWidth}x${video.videoHeight}`);
      }
      if (initialSeek > 1 && video.duration && initialSeek < video.duration - 2) {
        video.currentTime = initialSeek;
      }
      video.play().catch(() => {
        video.muted = true;
        setMuted(true);
        video.play().catch(() => {});
      });
    };

    const inspectProxyFailure = async (fallbackMsg) => {
      try {
        const r = await fetch(playableUrl);
        if (!r.ok) {
          const data = await r.json().catch(() => null);
          if (data?.code === 'INGEST_WAITING') {
            setWaitingIngest(true);
            setError(data.error);
            retryTimerRef.current = setTimeout(() => {
              setRetryTick((t) => t + 1);
            }, 3000);
            return;
          }
          if (data?.error) {
            const d = data.detail || {};
            const extra =
              d.reason || d.status
                ? ` (${d.status ? `HTTP ${d.status} · ` : ''}${d.reason || ''}${
                    d.url ? ` · ${String(d.url).replace(/([?&](?:token|password|pass)=)([^&]{4})[^&]*/gi, '$1$2***')}` : ''
                  })`
                : '';
            setError(`${data.error}${extra}`);
            return;
          }
        }
      } catch {
        // ignore
      }
      setError(fallbackMsg);
    };

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });
      hlsRef.current = hls;
      hls.loadSource(playableUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setError('');
        setWaitingIngest(false);
        video.play().catch(() => {
          video.muted = true;
          setMuted(true);
          video.play().catch(() => {});
        });
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const lvl = hls.levels[data.level];
        if (lvl?.width && lvl?.height) {
          setResolution(`${lvl.width}x${lvl.height}`);
        }
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          // If stream turns out to be raw MPEG-TS instead of HLS, fall back to direct <video> src
          if (data.details === 'manifestParsingError') {
            hls.destroy();
            hlsRef.current = null;
            video.src = playableUrl;
            video.addEventListener('loadedmetadata', onLoadedMeta);
            return;
          }
          inspectProxyFailure(
            `No se pudo cargar el stream HLS (${data.details}). Verifica que el canal o encoder esté transmitiendo en vivo.`
          );
        }
      });
    } else {
      video.src = playableUrl;
      video.addEventListener('loadedmetadata', onLoadedMeta);
      video.addEventListener('error', () => {
        inspectProxyFailure('No se pudo reproducir el flujo de video desde el origen.');
      });
    }

    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      video.removeEventListener('loadedmetadata', onLoadedMeta);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [playableUrl, retryTick]);

  const runDiagnosis = async () => {
    if (!item?.id || item.kind !== 'live') return;
    setDiagBusy(true);
    try {
      const res = await fetch(`/api/streams/${item.id}/diagnose`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      const data = await res.json();
      setDiagnosis(data);
    } catch (err) {
      setDiagnosis({ error: err?.message || 'No se pudo completar el diagnóstico' });
    } finally {
      setDiagBusy(false);
    }
  };

  if (!item) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl rounded-2xl bg-[#0e1525] border border-slate-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 bg-[#131c31] border-b border-slate-800">
          <div className="flex items-center gap-3 min-w-0">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-400 border border-rose-500/30">
              <Radio className="w-3.5 h-3.5 animate-pulse" />
              {item.kind === 'vod' ? 'VOD PLAYER' : item.kind === 'channel247' ? 'SEÑAL 24/7 EN VIVO' : 'LIVE MONITOR'}
            </span>
            <h3 className="font-semibold text-slate-100 truncate">{item.title}</h3>
            {resolution && (
              <span className="px-2 py-0.5 rounded text-xs font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                {resolution}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {item.kind === 'channel247' && (
              <button
                onClick={refresh247State}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
                title="Sincronizar con el reloj en vivo 24/7"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Sincronizar En Vivo
              </button>
            )}
            <button
              onClick={() => setRetryTick((t) => t + 1)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
              title="Reconectar señal"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reconectar
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="relative bg-black aspect-video flex items-center justify-center">
          <video
            ref={videoRef}
            controls
            playsInline
            muted={muted}
            onEnded={() => {
              if (item.kind === 'channel247') refresh247State();
            }}
            className="w-full h-full object-contain"
          />

          {item.watermark && (
            <div className="pointer-events-none absolute top-4 right-5 px-3 py-1 rounded bg-black/55 border border-white/15 text-xs font-bold tracking-wider text-white/85 uppercase">
              {item.watermark}
            </div>
          )}

          {error && (
            <div className="absolute inset-0 bg-slate-950/92 flex flex-col items-center justify-center p-6 text-center">
              {waitingIngest ? (
                <RefreshCw className="w-10 h-10 text-cyan-400 animate-spin mb-3" />
              ) : (
                <AlertTriangle className="w-10 h-10 text-amber-400 mb-3" />
              )}
              <p className="text-sm text-slate-200 max-w-lg mb-2 leading-relaxed">{error}</p>
              {waitingIngest && (
                <p className="text-xs text-cyan-300 mb-3">
                  Auto-conectando automáticamente cada 3 segundos en cuanto recibamos video...
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                <button
                  onClick={() => setRetryTick((t) => t + 1)}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Reintentar Ahora
                </button>
                {item.kind === 'live' && item.id ? (
                  <button
                    onClick={runDiagnosis}
                    disabled={diagBusy}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-xs font-semibold border border-slate-700"
                  >
                    {diagBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}
                    {diagBusy ? 'Diagnosticando…' : 'Diagnosticar origen'}
                  </button>
                ) : null}
              </div>

              {diagnosis && !diagnosis.error ? (
                <div className="mt-3 w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900/80 p-3 text-left">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Diagnóstico</div>
                  <div className="mt-1 text-xs font-semibold text-slate-100">{diagnosis.verdict?.title}</div>
                  <p className="mt-1 text-[11px] leading-snug text-slate-300">{diagnosis.verdict?.text}</p>
                  <div className="mt-2 space-y-1">
                    {(diagnosis.steps || []).map((st) => (
                      <div key={st.id} className="flex items-start gap-1.5 text-[10.5px]">
                        <span className={st.ok ? 'text-emerald-400' : 'text-rose-400'}>{st.ok ? '✓' : '✗'}</span>
                        <span className="text-slate-400">
                          <b className="text-slate-200">{st.label}:</b> {st.detail}
                        </span>
                      </div>
                    ))}
                  </div>
                  {diagnosis.verdict?.hints?.length ? (
                    <ul className="mt-2 space-y-0.5">
                      {diagnosis.verdict.hints.map((h, i) => (
                        <li key={i} className="text-[10.5px] text-amber-200/90">
                          → {h}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {diagnosis?.error ? (
                <div className="mt-3 text-[11px] text-rose-300">{diagnosis.error}</div>
              ) : null}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-[#0b101d] border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-2 min-w-0">
            <Tv className="w-4 h-4 text-indigo-400 shrink-0" />
            {item.kind === 'channel247' && live247State?.currentItem ? (
              <span className="truncate">
                <strong className="text-slate-200">Ahora al aire:</strong> {live247State.currentItem.title} •{' '}
                <span className="text-indigo-300">
                  Siguiente: {live247State.nextItem?.title || 'Loop continuo'}
                </span>
              </span>
            ) : (
              <span className="font-mono truncate">
                {rawActiveUrl?.includes('127.0.0.1') ? 'Túnel Interno RTMP/HLS -> Proxy Seguro TVLister' : rawActiveUrl}
              </span>
            )}
          </div>
          <button
            onClick={() => {
              if (videoRef.current) {
                videoRef.current.muted = !muted;
                setMuted(!muted);
              }
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            {muted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-400" />}
            {muted ? 'Activar Audio' : 'Audio Activo'}
          </button>
        </div>
      </div>
    </div>
  );
}
