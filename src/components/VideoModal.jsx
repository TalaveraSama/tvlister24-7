import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { X, Radio, Volume2, VolumeX, RefreshCw, AlertTriangle, Tv } from 'lucide-react';

export default function VideoModal({ item, onClose }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [resolution, setResolution] = useState('');
  const [live247State, setLive247State] = useState(item?.liveState || null);

  // Determine active stream URL & seek offset
  const activeUrl =
    item?.kind === 'channel247'
      ? live247State?.currentItem?.url || item?.url
      : item?.url;

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
    if (!activeUrl || !videoRef.current) return;
    setError('');
    const video = videoRef.current;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isHls = activeUrl.toLowerCase().includes('.m3u8');

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

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true
      });
      hlsRef.current = hls;
      hls.loadSource(activeUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
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
          setError(`No se pudo cargar el stream HLS (${data.details}). Verifica CORS o disponibilidad de la fuente.`);
        }
      });
    } else {
      video.src = activeUrl;
      video.addEventListener('loadedmetadata', onLoadedMeta);
    }

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMeta);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [activeUrl]);

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

          {/* Optional Watermark Overlay (MidnightStreamer style) */}
          {item.watermark && (
            <div className="pointer-events-none absolute top-4 right-5 px-3 py-1 rounded bg-black/55 border border-white/15 text-xs font-bold tracking-wider text-white/85 uppercase">
              {item.watermark}
            </div>
          )}

          {error && (
            <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center p-6 text-center">
              <AlertTriangle className="w-10 h-10 text-amber-400 mb-3" />
              <p className="text-sm text-slate-200 max-w-md mb-2">{error}</p>
              <p className="text-xs text-slate-400 font-mono break-all max-w-lg">{activeUrl}</p>
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
              <span className="font-mono truncate">{activeUrl}</span>
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
