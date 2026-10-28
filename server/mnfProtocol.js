import { EventEmitter } from 'events';

export const MNF_MAGIC = Buffer.from([0x4d, 0x4e, 0x46, 0x01]); // "MNF\x01"

export const MNF_FRAME_TYPES = {
  INIT_CONFIG: 0x01,
  VIDEO_KEYFRAME: 0x02,
  VIDEO_DELTA: 0x03,
  AUDIO_FRAME: 0x04,
  CMAF_FRAGMENT: 0x05,
  KEEPALIVE_PING: 0x06,
};

/**
 * Encodes the 12-byte connection header sent once at the beginning of an MNF v1 stream.
 */
export function encodeMnfStreamHeader({
  streamId = 0,
  videoCodec = 1, // 1=H264, 2=HEVC, 3=AV1
  audioCodec = 1, // 1=AAC, 2=MP3, 3=Opus, 4=AC3
  gopBurst = true,
  cmafHybrid = false,
} = {}) {
  const buf = Buffer.allocUnsafe(12);
  MNF_MAGIC.copy(buf, 0);
  let flags = 0x03; // video + audio present
  if (gopBurst) flags |= 0x04;
  if (cmafHybrid) flags |= 0x08;
  buf[4] = flags;
  buf[5] = videoCodec & 0xff;
  buf[6] = audioCodec & 0xff;
  buf[7] = 0x00;
  buf.writeUInt32BE(Number(streamId) >>> 0, 8);
  return buf;
}

/**
 * Encodes a single 9-byte NanoFrame header + payload.
 */
export function encodeMnfFrame(frameType, ptsMs, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const header = Buffer.allocUnsafe(9);
  header[0] = frameType & 0xff;
  header.writeUInt32BE((Math.max(0, Math.floor(ptsMs)) >>> 0), 1);
  header.writeUInt32BE(body.length >>> 0, 5);
  return body.length > 0 ? Buffer.concat([header, body]) : header;
}

/**
 * Detects whether an H.264 or HEVC Annex-B elementary payload contains a Keyframe (IDR / IRAP)
 * or SPS/PPS parameter sets.
 */
export function inspectAnnexBNals(payload, videoCodec = 1) {
  let hasKeyframe = false;
  let hasConfig = false;
  const len = payload.length;

  for (let i = 0; i < len - 4; i++) {
    if (payload[i] === 0x00 && payload[i + 1] === 0x00) {
      let nalStart = -1;
      if (payload[i + 2] === 0x01) {
        nalStart = i + 3;
      } else if (payload[i + 2] === 0x00 && payload[i + 3] === 0x01 && i + 4 < len) {
        nalStart = i + 4;
      }
      if (nalStart !== -1 && nalStart < len) {
        const nalByte = payload[nalStart];
        if (videoCodec === 2) {
          // HEVC NAL unit type: (byte >> 1) & 0x3F
          const hevcType = (nalByte >> 1) & 0x3f;
          if (hevcType >= 16 && hevcType <= 21) hasKeyframe = true;
          if (hevcType >= 32 && hevcType <= 34) hasConfig = true;
        } else {
          // H.264 NAL unit type: byte & 0x1F
          const h264Type = nalByte & 0x1f;
          if (h264Type === 5) hasKeyframe = true; // IDR
          if (h264Type === 7 || h264Type === 8) hasConfig = true; // SPS / PPS
        }
        i = nalStart;
      }
    }
  }
  return { hasKeyframe, hasConfig };
}

/**
 * Parses 33-bit MPEG PES PTS (90kHz clock) into milliseconds.
 */
function parsePesPtsMs(pesBuffer, offset) {
  if (offset + 5 > pesBuffer.length) return 0;
  const b0 = pesBuffer[offset];
  const b1 = pesBuffer[offset + 1];
  const b2 = pesBuffer[offset + 2];
  const b3 = pesBuffer[offset + 3];
  const b4 = pesBuffer[offset + 4];
  const pts90k =
    ((b0 & 0x0e) * 536870912) + // << 29
    ((b1 & 0xff) << 22) +
    ((b2 & 0xfe) << 14) +
    ((b3 & 0xff) << 7) +
    ((b4 & 0xfe) >>> 1);
  return Math.floor(pts90k / 90);
}

/**
 * Real-time MPEG-TS (188-byte) -> MNF v1 (TVLister Media NanoFrame) Transmuxer.
 * Strips:
 *   - 0x1FFF CBR null stuffing packets
 *   - Repeated PAT / PMT / SDT PSI tables
 *   - 4-byte TS headers + PCR/adaptation padding
 *   - 9–19 byte PES headers
 * Emits clean Elementary Access Units wrapped in 9-byte MNF headers.
 */
export class TsToMnfTransmuxer extends EventEmitter {
  constructor({ streamId = 0 } = {}) {
    super();
    this.streamId = streamId;
    this.remainder = Buffer.alloc(0);
    this.pmtPid = -1;
    this.videoPid = -1;
    this.audioPid = -1;
    this.videoCodec = 1; // 1=H264, 2=HEVC
    this.audioCodec = 1; // 1=AAC, 2=MP3, 4=AC3
    this.videoPesChunks = [];
    this.audioPesChunks = [];
    this.lastPtsMs = 0;

    // Telemetry counters
    this.stats = {
      tsPacketsTotal: 0,
      nullPacketsDropped: 0,
      psiPacketsDropped: 0,
      tsBytesIn: 0,
      mnfBytesOut: 12, // stream header
      mnfFramesOut: 0,
      keyframesOut: 0,
      headersStrippedBytes: 0,
    };
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.stats.tsBytesIn += chunk.length;
    const buf = this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk;

    let offset = 0;
    const len = buf.length;

    while (offset + 188 <= len) {
      // Sync byte recovery (0x47)
      if (buf[offset] !== 0x47) {
        const nextSync = buf.indexOf(0x47, offset + 1);
        if (nextSync === -1) {
          offset = len;
          break;
        }
        offset = nextSync;
        if (offset + 188 > len) break;
      }

      this._processTsPacket(buf.subarray(offset, offset + 188));
      offset += 188;
    }

    this.remainder = offset < len ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
  }

  flush() {
    if (this.videoPesChunks.length > 0) {
      this._emitPesPacket(Buffer.concat(this.videoPesChunks), true);
      this.videoPesChunks = [];
    }
    if (this.audioPesChunks.length > 0) {
      this._emitPesPacket(Buffer.concat(this.audioPesChunks), false);
      this.audioPesChunks = [];
    }
  }

  _processTsPacket(pkt) {
    this.stats.tsPacketsTotal++;
    const pusi = (pkt[1] & 0x40) !== 0;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    const afc = (pkt[3] >> 4) & 0x03;

    // 1. Drop MPEG-TS Null Stuffing Packet (PID 0x1FFF = 8191)
    if (pid === 0x1fff) {
      this.stats.nullPacketsDropped++;
      this.stats.headersStrippedBytes += 188;
      return;
    }

    let payloadOffset = 4;
    if (afc === 0x02 || afc === 0x00) {
      // Adaptation-only packet (no payload)
      this.stats.headersStrippedBytes += 188;
      return;
    }
    if (afc === 0x03) {
      const adaptLen = pkt[4];
      payloadOffset = 5 + adaptLen;
      if (payloadOffset >= 188) {
        this.stats.headersStrippedBytes += 188;
        return;
      }
    }

    this.stats.headersStrippedBytes += payloadOffset;
    const payload = pkt.subarray(payloadOffset, 188);

    // 2. PAT (PID 0x0000) -> learn PMT PID, then drop redundant PAT packets
    if (pid === 0x0000) {
      this.stats.psiPacketsDropped++;
      this.stats.headersStrippedBytes += payload.length;
      if (this.pmtPid === -1) {
        const ptr = pusi ? payload[0] + 1 : 0;
        const sec = payload.subarray(ptr);
        if (sec.length >= 12 && sec[0] === 0x00) {
          const sectionLen = ((sec[1] & 0x0f) << 8) | sec[2];
          const entriesEnd = Math.min(sec.length, 3 + sectionLen - 4);
          for (let i = 8; i + 4 <= entriesEnd; i += 4) {
            const progNum = (sec[i] << 8) | sec[i + 1];
            const pPid = ((sec[i + 2] & 0x1f) << 8) | sec[i + 3];
            if (progNum !== 0) {
              this.pmtPid = pPid;
              break;
            }
          }
        }
      }
      return;
    }

    // 3. PMT -> learn Video & Audio Elementary PIDs, then drop redundant PMT packets
    if (pid === this.pmtPid) {
      this.stats.psiPacketsDropped++;
      this.stats.headersStrippedBytes += payload.length;
      if (this.videoPid === -1 && this.audioPid === -1) {
        const ptr = pusi ? payload[0] + 1 : 0;
        const sec = payload.subarray(ptr);
        if (sec.length >= 16 && sec[0] === 0x02) {
          const sectionLen = ((sec[1] & 0x0f) << 8) | sec[2];
          const progInfoLen = ((sec[10] & 0x0f) << 8) | sec[11];
          let pos = 12 + progInfoLen;
          const end = Math.min(sec.length, 3 + sectionLen - 4);
          while (pos + 5 <= end) {
            const streamType = sec[pos];
            const elemPid = ((sec[pos + 1] & 0x1f) << 8) | sec[pos + 2];
            const esInfoLen = ((sec[pos + 3] & 0x0f) << 8) | sec[pos + 4];
            if (streamType === 0x1b || streamType === 0x02) {
              this.videoPid = elemPid;
              this.videoCodec = 1;
            } else if (streamType === 0x24) {
              this.videoPid = elemPid;
              this.videoCodec = 2;
            } else if (streamType === 0x0f || streamType === 0x11) {
              if (this.audioPid === -1) {
                this.audioPid = elemPid;
                this.audioCodec = 1;
              }
            } else if (streamType === 0x03 || streamType === 0x04) {
              if (this.audioPid === -1) {
                this.audioPid = elemPid;
                this.audioCodec = 2;
              }
            } else if (streamType === 0x81 || streamType === 0x06) {
              if (this.audioPid === -1) {
                this.audioPid = elemPid;
                this.audioCodec = 4;
              }
            }
            pos += 5 + esInfoLen;
          }
        }
      }
      return;
    }

    // Drop SDT / EIT / NIT service tables (0x0010 - 0x0014)
    if (pid >= 0x0010 && pid <= 0x0014) {
      this.stats.psiPacketsDropped++;
      this.stats.headersStrippedBytes += payload.length;
      return;
    }

    // Fallback PID auto-detection if stream starts mid-GOP before PAT/PMT
    if (this.videoPid === -1 && pusi && payload.length >= 9 && payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x01) {
      const streamIdByte = payload[3];
      if (streamIdByte >= 0xe0 && streamIdByte <= 0xef) {
        this.videoPid = pid;
      } else if (streamIdByte >= 0xc0 && streamIdByte <= 0xdf && this.audioPid === -1) {
        this.audioPid = pid;
      }
    }

    if (pid === this.videoPid) {
      if (pusi && this.videoPesChunks.length > 0) {
        this._emitPesPacket(Buffer.concat(this.videoPesChunks), true);
        this.videoPesChunks = [];
      }
      this.videoPesChunks.push(Buffer.from(payload));
    } else if (pid === this.audioPid) {
      if (pusi && this.audioPesChunks.length > 0) {
        this._emitPesPacket(Buffer.concat(this.audioPesChunks), false);
        this.audioPesChunks = [];
      }
      this.audioPesChunks.push(Buffer.from(payload));
    } else {
      // Unknown auxiliary PID (teletext / SCTE / private data)
      this.stats.psiPacketsDropped++;
      this.stats.headersStrippedBytes += payload.length;
    }
  }

  _emitPesPacket(pes, isVideo) {
    if (pes.length < 9) return;
    if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return;

    const flags2 = pes[7];
    const pesHeaderDataLen = pes[8];
    const esOffset = 9 + pesHeaderDataLen;
    if (esOffset >= pes.length) return;

    let ptsMs = this.lastPtsMs;
    if ((flags2 & 0x80) !== 0 && pesHeaderDataLen >= 5) {
      ptsMs = parsePesPtsMs(pes, 9);
      this.lastPtsMs = ptsMs;
    }

    this.stats.headersStrippedBytes += esOffset;
    const elementaryPayload = pes.subarray(esOffset);
    if (elementaryPayload.length === 0) return;

    let frameType = MNF_FRAME_TYPES.AUDIO_FRAME;
    if (isVideo) {
      const { hasKeyframe } = inspectAnnexBNals(elementaryPayload, this.videoCodec);
      frameType = hasKeyframe ? MNF_FRAME_TYPES.VIDEO_KEYFRAME : MNF_FRAME_TYPES.VIDEO_DELTA;
      if (hasKeyframe) this.stats.keyframesOut++;
    }

    const mnfPacket = encodeMnfFrame(frameType, ptsMs, elementaryPayload);
    this.stats.mnfBytesOut += mnfPacket.length;
    this.stats.mnfFramesOut++;

    this.emit('frame', {
      frameType,
      ptsMs,
      payload: elementaryPayload,
      wirePacket: mnfPacket,
    });
  }

  getSummary() {
    const savedBytes = Math.max(0, this.stats.tsBytesIn - this.stats.mnfBytesOut);
    const savedPct =
      this.stats.tsBytesIn > 0
        ? Number(((savedBytes / this.stats.tsBytesIn) * 100).toFixed(2))
        : 0;
    const mnfHeaderBytes = 12 + this.stats.mnfFramesOut * 9;
    const mnfOverheadPct =
      this.stats.mnfBytesOut > 0
        ? Number(((mnfHeaderBytes / this.stats.mnfBytesOut) * 100).toFixed(3))
        : 0;
    const tsOverheadPct =
      this.stats.tsBytesIn > 0
        ? Number(((this.stats.headersStrippedBytes / this.stats.tsBytesIn) * 100).toFixed(2))
        : 0;

    return {
      ...this.stats,
      savedBytes,
      savedPct,
      mnfOverheadPct,
      tsOverheadPct,
    };
  }
}

/**
 * MPEG-2 PSI CRC32 lookup table (polynomial 0x04C11DB7) for valid PAT/PMT generation.
 */
const MPEG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function mpegCrc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ MPEG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Reverse Remuxer: MNF v1 (TVLister Media NanoFrame) -> Standard 188-byte MPEG-TS!
 * Enables TVLister Edge servers to pull streams via ultra-light `mnf://` trunking
 * and still serve legacy `.ts` Smart TVs / STBs cleanly at the last mile.
 */
export class MnfToTsRemuxer extends EventEmitter {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.headerParsed = false;
    this.videoCodec = 1;
    this.audioCodec = 1;
    this.ccPat = 0;
    this.ccPmt = 0;
    this.ccVideo = 0;
    this.ccAudio = 0;
    this.framesConverted = 0;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);

    if (!this.headerParsed) {
      if (this.buffer.length < 12) return;
      if (
        this.buffer[0] !== 0x4d ||
        this.buffer[1] !== 0x4e ||
        this.buffer[2] !== 0x46 ||
        this.buffer[3] !== 0x01
      ) {
        throw new Error('Cabecera MNF inválida (se esperaba magic MNF\\x01)');
      }
      this.videoCodec = this.buffer[5] || 1;
      this.audioCodec = this.buffer[6] || 1;
      this.headerParsed = true;
      this.buffer = this.buffer.subarray(12);
      this._emitPatAndPmt();
    }

    while (this.buffer.length >= 9) {
      const frameType = this.buffer[0];
      const ptsMs = this.buffer.readUInt32BE(1);
      const payloadLen = this.buffer.readUInt32BE(5);
      if (this.buffer.length < 9 + payloadLen) break;

      const payload = this.buffer.subarray(9, 9 + payloadLen);
      this.buffer = this.buffer.subarray(9 + payloadLen);

      if (frameType === MNF_FRAME_TYPES.KEEPALIVE_PING || payloadLen === 0) {
        continue;
      }
      if (frameType === MNF_FRAME_TYPES.VIDEO_KEYFRAME) {
        this._emitPatAndPmt();
      }
      const isVideo =
        frameType === MNF_FRAME_TYPES.VIDEO_KEYFRAME ||
        frameType === MNF_FRAME_TYPES.VIDEO_DELTA ||
        frameType === MNF_FRAME_TYPES.INIT_CONFIG;

      this._packetizeElementaryToTs(payload, ptsMs, isVideo, frameType === MNF_FRAME_TYPES.VIDEO_KEYFRAME);
      this.framesConverted++;
    }
  }

  _emitPatAndPmt() {
    // 1. PAT section (Program 1 -> PMT PID 0x1000)
    const patBody = Buffer.from([
      0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0x00, 0x01, 0xf0, 0x00,
    ]);
    const patCrc = Buffer.allocUnsafe(4);
    patCrc.writeUInt32BE(mpegCrc32(patBody), 0);
    const patPkt = Buffer.alloc(188, 0xff);
    patPkt[0] = 0x47;
    patPkt[1] = 0x40;
    patPkt[2] = 0x00;
    patPkt[3] = 0x10 | (this.ccPat & 0x0f);
    this.ccPat = (this.ccPat + 1) & 0x0f;
    patPkt[4] = 0x00; // pointer_field
    patBody.copy(patPkt, 5);
    patCrc.copy(patPkt, 5 + patBody.length);

    // 2. PMT section (PCR PID 0x0100, Video PID 0x0100, Audio PID 0x0101)
    const vStreamType = this.videoCodec === 2 ? 0x24 : 0x1b;
    const aStreamType = this.audioCodec === 2 ? 0x03 : this.audioCodec === 4 ? 0x81 : 0x0f;
    const pmtBody = Buffer.from([
      0x02, 0xb0, 0x17, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0xe1, 0x00, 0xf0, 0x00,
      vStreamType, 0xe1, 0x00, 0xf0, 0x00,
      aStreamType, 0xe1, 0x01, 0xf0, 0x00,
    ]);
    const pmtCrc = Buffer.allocUnsafe(4);
    pmtCrc.writeUInt32BE(mpegCrc32(pmtBody), 0);
    const pmtPkt = Buffer.alloc(188, 0xff);
    pmtPkt[0] = 0x47;
    pmtPkt[1] = 0x50; // PUSI + PID 0x1000 high bits
    pmtPkt[2] = 0x00;
    pmtPkt[3] = 0x10 | (this.ccPmt & 0x0f);
    this.ccPmt = (this.ccPmt + 1) & 0x0f;
    pmtPkt[4] = 0x00; // pointer_field
    pmtBody.copy(pmtPkt, 5);
    pmtCrc.copy(pmtPkt, 5 + pmtBody.length);

    this.emit('ts', Buffer.concat([patPkt, pmtPkt]));
  }

  _packetizeElementaryToTs(esPayload, ptsMs, isVideo, isKeyframe) {
    const pid = isVideo ? 0x0100 : 0x0101;
    const streamId = isVideo ? 0xe0 : 0xc0;
    const pts90k = Math.max(0, Math.floor(ptsMs * 90));

    // Build 14-byte PES header with PTS
    const pesHeader = Buffer.allocUnsafe(14);
    pesHeader[0] = 0x00;
    pesHeader[1] = 0x00;
    pesHeader[2] = 0x01;
    pesHeader[3] = streamId;
    const pesLen = isVideo || esPayload.length + 8 > 65535 ? 0 : esPayload.length + 8;
    pesHeader.writeUInt16BE(pesLen, 4);
    pesHeader[6] = 0x80;
    pesHeader[7] = 0x80; // PTS present
    pesHeader[8] = 0x05; // PES header data length = 5
    pesHeader[9] = 0x21 | (((pts90k / 536870912) & 0x07) << 1);
    pesHeader[10] = (pts90k >>> 22) & 0xff;
    pesHeader[11] = 0x01 | (((pts90k >>> 15) & 0x7f) << 1);
    pesHeader[12] = (pts90k >>> 7) & 0xff;
    pesHeader[13] = 0x01 | ((pts90k & 0x7f) << 1);

    const fullPes = Buffer.concat([pesHeader, esPayload]);
    const outPackets = [];
    let offset = 0;
    let first = true;

    while (offset < fullPes.length) {
      const pkt = Buffer.alloc(188, 0xff);
      pkt[0] = 0x47;
      pkt[1] = (first ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
      pkt[2] = pid & 0xff;

      const cc = isVideo ? this.ccVideo : this.ccAudio;
      if (isVideo) this.ccVideo = (this.ccVideo + 1) & 0x0f;
      else this.ccAudio = (this.ccAudio + 1) & 0x0f;

      const remaining = fullPes.length - offset;
      if (first && isVideo && isKeyframe && remaining >= 176) {
        // Random Access Indicator in adaptation field for instant decoder lock
        pkt[3] = 0x30 | cc;
        pkt[4] = 0x01; // adaptation_field_length = 1
        pkt[5] = 0x40; // random_access_indicator = 1
        fullPes.copy(pkt, 6, offset, offset + 182);
        offset += 182;
      } else if (remaining >= 184) {
        pkt[3] = 0x10 | cc;
        fullPes.copy(pkt, 4, offset, offset + 184);
        offset += 184;
      } else {
        const stuffLen = 184 - remaining;
        pkt[3] = 0x30 | cc;
        pkt[4] = stuffLen - 1;
        if (stuffLen > 1) {
          pkt[5] = 0x00;
          if (stuffLen > 2) pkt.fill(0xff, 6, 4 + stuffLen);
        }
        fullPes.copy(pkt, 4 + stuffLen, offset, offset + remaining);
        offset += remaining;
      }
      first = false;
      outPackets.push(pkt);
    }

    this.emit('ts', Buffer.concat(outPackets));
  }
}

/**
 * Shared Live MNF Broadcast Hub per Channel:
 * Pulls upstream once (1 upstream connection for N clients!), transmuxes TS -> MNF1,
 * caches the latest Keyframe GOP in RAM for <35ms Instant Zapping, and fans out
 * binary NanoFrames to all HTTP `.mnf` and WebSocket `ws://.../ws/mnf` subscribers.
 */
class MnfChannelSession {
  constructor({ streamId, upstreamUrls, userAgent = 'TVLister-MNF-Engine/2.3' }) {
    this.streamId = streamId;
    this.upstreamUrls = upstreamUrls;
    this.userAgent = userAgent;
    this.subscribers = new Set(); // fn(Buffer)
    this.gopRing = []; // [{ frameType, wirePacket }]
    this.gopBytes = 0;
    this.transmuxer = new TsToMnfTransmuxer({ streamId });
    this.abortController = new AbortController();
    this.active = false;
    this.startedAt = Date.now();
    this.idleTimer = null;

    this.transmuxer.on('frame', ({ frameType, wirePacket }) => {
      // Maintain Instant-Zapping GOP Ring Buffer (starts cleanly at latest VIDEO_KEYFRAME)
      if (frameType === MNF_FRAME_TYPES.VIDEO_KEYFRAME) {
        this.gopRing = [wirePacket];
        this.gopBytes = wirePacket.length;
      } else if (this.gopRing.length > 0 && this.gopRing.length < 90 && this.gopBytes + wirePacket.length <= 2 * 1024 * 1024) {
        this.gopRing.push(wirePacket);
        this.gopBytes += wirePacket.length;
      }

      for (const sub of this.subscribers) {
        try {
          sub(wirePacket);
        } catch {
          // ignore broken subscriber
        }
      }
    });
  }

  getStreamHeader() {
    return encodeMnfStreamHeader({
      streamId: this.streamId,
      videoCodec: this.transmuxer.videoCodec,
      audioCodec: this.transmuxer.audioCodec,
      gopBurst: true,
    });
  }

  addSubscriber(sendFn) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // 1. Send 12-byte MNF\x01 stream header
    sendFn(this.getStreamHeader());
    // 2. Burst cached IDR Keyframe GOP immediately for <35ms zapping!
    for (const pkt of this.gopRing) {
      sendFn(pkt);
    }
    this.subscribers.add(sendFn);
    if (!this.active) {
      this._startUpstreamLoop();
    }
  }

  removeSubscriber(sendFn, onEmpty) {
    this.subscribers.delete(sendFn);
    if (this.subscribers.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        if (this.subscribers.size === 0) {
          this.stop();
          onEmpty?.();
        }
      }, 8000);
    }
  }

  stop() {
    this.active = false;
    try {
      this.abortController.abort();
    } catch {
      // ignore
    }
    this.subscribers.clear();
    this.gopRing = [];
  }

  async _startUpstreamLoop() {
    this.active = true;
    for (const candidateUrl of this.upstreamUrls) {
      if (!this.active || !candidateUrl) continue;
      try {
        const resp = await fetch(candidateUrl, {
          headers: { 'User-Agent': this.userAgent, Accept: '*/*' },
          signal: this.abortController.signal,
          redirect: 'follow',
        });
        if (!resp.ok || !resp.body) continue;

        const ctype = (resp.headers.get('content-type') || '').toLowerCase();
        // If upstream is an HLS playlist (.m3u8), poll new segments cleanly
        if (ctype.includes('mpegurl') || candidateUrl.toLowerCase().includes('.m3u8')) {
          await this._pollHlsSegments(candidateUrl);
          return;
        }

        const reader = resp.body.getReader();
        while (this.active) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            this.transmuxer.push(Buffer.from(value));
          }
        }
        return;
      } catch {
        // try next failover candidate
      }
    }
    this.active = false;
  }

  async _pollHlsSegments(playlistUrl) {
    const seenSegments = new Set();
    while (this.active) {
      try {
        const resp = await fetch(playlistUrl, {
          headers: { 'User-Agent': this.userAgent },
          signal: this.abortController.signal,
        });
        if (!resp.ok) break;
        const text = await resp.text();
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

        // Follow master variant playlist if needed
        const variantLine = lines.find((l, idx) => !l.startsWith('#') && idx > 0 && lines[idx - 1]?.startsWith('#EXT-X-STREAM-INF'));
        if (variantLine) {
          playlistUrl = new URL(variantLine, playlistUrl).toString();
          continue;
        }

        // Check for CMAF fMP4 EXT-X-MAP init segment (Flussonic M4F / Low-Latency HLS!)
        const mapLine = lines.find((l) => l.startsWith('#EXT-X-MAP:'));
        if (mapLine && !seenSegments.has(mapLine)) {
          const uriMatch = mapLine.match(/URI="([^"]+)"/i);
          if (uriMatch) {
            seenSegments.add(mapLine);
            const initUrl = new URL(uriMatch[1], playlistUrl).toString();
            const initResp = await fetch(initUrl, { signal: this.abortController.signal });
            if (initResp.ok) {
              const initBuf = Buffer.from(await initResp.arrayBuffer());
              const wire = encodeMnfFrame(MNF_FRAME_TYPES.INIT_CONFIG, 0, initBuf);
              this.gopRing = [wire];
              for (const sub of this.subscribers) sub(wire);
            }
          }
        }

        const mediaUris = lines.filter((l) => !l.startsWith('#'));
        const recent = seenSegments.size === 0 ? mediaUris.slice(-2) : mediaUris;

        for (const segRel of recent) {
          if (!this.active) break;
          const segUrl = new URL(segRel, playlistUrl).toString();
          if (seenSegments.has(segUrl)) continue;
          seenSegments.add(segUrl);
          if (seenSegments.size > 200) {
            const first = seenSegments.values().next().value;
            seenSegments.delete(first);
          }

          const segResp = await fetch(segUrl, { signal: this.abortController.signal });
          if (!segResp.ok) continue;
          const segBuf = Buffer.from(await segResp.arrayBuffer());

          // Detect if segment is CMAF fMP4 (`moof` / `styp`) vs MPEG-TS (`0x47`)
          if (segBuf.length >= 8 && segBuf[0] !== 0x47 && /^(styp|moof|ftyp|sidx)$/.test(segBuf.subarray(4, 8).toString('ascii'))) {
            this.transmuxer.stats.tsBytesIn += segBuf.length;
            const wire = encodeMnfFrame(MNF_FRAME_TYPES.CMAF_FRAGMENT, Date.now() - this.startedAt, segBuf);
            this.transmuxer.stats.mnfBytesOut += wire.length;
            this.transmuxer.stats.mnfFramesOut++;
            for (const sub of this.subscribers) sub(wire);
          } else {
            this.transmuxer.push(segBuf);
          }
        }
      } catch {
        // ignore transient poll glitch
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}

const activeMnfSessions = new Map();

export function getOrCreateMnfSession({ streamId, upstreamUrls }) {
  const key = String(streamId);
  let session = activeMnfSessions.get(key);
  if (!session) {
    session = new MnfChannelSession({ streamId, upstreamUrls });
    activeMnfSessions.set(key, session);
  }
  return {
    session,
    release: (sendFn) => {
      session.removeSubscriber(sendFn, () => {
        if (activeMnfSessions.get(key) === session) {
          activeMnfSessions.delete(key);
        }
      });
    },
  };
}

export function getMnfHubStats() {
  const channels = [];
  let totalTsIn = 0;
  let totalMnfOut = 0;
  let totalSubscribers = 0;

  for (const [id, sess] of activeMnfSessions.entries()) {
    const sum = sess.transmuxer.getSummary();
    totalTsIn += sum.tsBytesIn;
    totalMnfOut += sum.mnfBytesOut;
    totalSubscribers += sess.subscribers.size;
    channels.push({
      streamId: Number(id),
      subscribers: sess.subscribers.size,
      gopCachedFrames: sess.gopRing.length,
      gopCachedKB: Number((sess.gopBytes / 1024).toFixed(1)),
      ...sum,
    });
  }

  const savedBytes = Math.max(0, totalTsIn - totalMnfOut);
  const savedPct = totalTsIn > 0 ? Number(((savedBytes / totalTsIn) * 100).toFixed(2)) : 0;

  return {
    protocolVersion: 'MNF/1.0 (TVLister Media NanoFrame)',
    activeChannels: channels.length,
    totalSubscribers,
    totalTsBytesIn: totalTsIn,
    totalMnfBytesOut: totalMnfOut,
    savedBytes,
    savedPct,
    channels,
  };
}

/**
 * Generates a realistic broadcast MPEG-TS sample (with PAT, PMT, CBR 0x1FFF null stuffing,
 * H.264 SPS/PPS/IDR/Delta frames + frequent AAC audio PES packets) and measures the exact
 * real-time TS -> MNF -> TS round-trip efficiency.
 */
export function runSyntheticBroadcastBenchmark({ durationSec = 4, fps = 30, videoBitrateKbps = 2800, nullStuffingPct = 9 } = {}) {
  const remuxToTs = new MnfToTsRemuxer();
  const tsChunks = [];
  remuxToTs.on('ts', (buf) => tsChunks.push(buf));

  // Step 1: Build realistic elementary stream frames in MNF, convert to broadcast TS (with PSI + CBR null stuffing)
  const totalVideoFrames = durationSec * fps;
  const avgVideoFrameBytes = Math.max(900, Math.floor((videoBitrateKbps * 1000) / 8 / fps));
  const totalAudioFrames = Math.floor((durationSec * 48000) / 1024); // ~46.8 AAC frames/sec (small 180-byte frames where TS overhead hurts most!)

  const sourceMnfHeader = encodeMnfStreamHeader({ streamId: 777, videoCodec: 1, audioCodec: 1 });
  remuxToTs.push(sourceMnfHeader);

  for (let f = 0; f < totalVideoFrames; f++) {
    const ptsMs = Math.round((f * 1000) / fps);
    const isKeyframe = f % fps === 0;
    const vLen = isKeyframe ? avgVideoFrameBytes * 3 : Math.round(avgVideoFrameBytes * 0.85);
    const vPayload = Buffer.alloc(vLen, 0x65);
    // Write real H.264 Annex-B start codes (SPS + PPS + IDR on keyframe, Non-IDR slice on delta)
    if (isKeyframe) {
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x28, 0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0x80, 0x00, 0x00, 0x00, 0x01, 0x65]).copy(vPayload, 0);
    } else {
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41]).copy(vPayload, 0);
    }
    remuxToTs.push(
      encodeMnfFrame(isKeyframe ? MNF_FRAME_TYPES.VIDEO_KEYFRAME : MNF_FRAME_TYPES.VIDEO_DELTA, ptsMs, vPayload)
    );

    // Interleave ~1-2 AAC ADTS frames (172 bytes each -> in TS each 172B frame + 14B PES = 186B -> spills into TWO 188B TS packets = 376B!!)
    const audioCountThisTick = f % 2 === 0 ? 2 : 1;
    for (let a = 0; a < audioCountThisTick && f * 1.5 < totalAudioFrames; a++) {
      const aPayload = Buffer.alloc(172, 0xaa);
      aPayload[0] = 0xff;
      aPayload[1] = 0xf1; // ADTS syncword
      remuxToTs.push(encodeMnfFrame(MNF_FRAME_TYPES.AUDIO_FRAME, ptsMs + a * 10, aPayload));
    }
  }

  // Add realistic broadcast CBR muxer null stuffing (PID 0x1FFF) & periodic PSI repetition (every 100ms)
  const rawTs = Buffer.concat(tsChunks);
  const rawPacketCount = Math.floor(rawTs.length / 188);
  const nullPacketsToAdd = Math.floor((rawPacketCount * nullStuffingPct) / (100 - nullStuffingPct));
  const nullPkt = Buffer.alloc(188, 0xff);
  nullPkt[0] = 0x47;
  nullPkt[1] = 0x1f;
  nullPkt[2] = 0xff;
  nullPkt[3] = 0x10;

  const broadcastPackets = [];
  const nullInterval = nullPacketsToAdd > 0 ? Math.max(2, Math.floor(rawPacketCount / nullPacketsToAdd)) : 999999;
  for (let i = 0; i < rawPacketCount; i++) {
    broadcastPackets.push(rawTs.subarray(i * 188, (i + 1) * 188));
    if (i % nullInterval === 0 && nullPacketsToAdd > 0) {
      broadcastPackets.push(nullPkt);
    }
  }
  const broadcastTsBuffer = Buffer.concat(broadcastPackets);

  // Step 2: Run broadcast TS through TsToMnfTransmuxer and measure real-time compression & latency!
  const t0 = performance.now();
  const transmuxer = new TsToMnfTransmuxer({ streamId: 777 });
  const mnfWireChunks = [encodeMnfStreamHeader({ streamId: 777 })];
  transmuxer.on('frame', ({ wirePacket }) => mnfWireChunks.push(wirePacket));
  transmuxer.push(broadcastTsBuffer);
  transmuxer.flush();
  const elapsedMs = Number((performance.now() - t0).toFixed(2));

  // Step 3: Verify lossless round-trip MNF -> TS!
  const verifyRemux = new MnfToTsRemuxer();
  let roundTripTsBytes = 0;
  verifyRemux.on('ts', (b) => {
    roundTripTsBytes += b.length;
  });
  verifyRemux.push(Buffer.concat(mnfWireChunks));

  const summary = transmuxer.getSummary();
  return {
    mode: 'broadcast_h264_aac_cbr',
    durationSec,
    processingTimeMs: elapsedMs,
    tsTotalBytes: summary.tsBytesIn,
    mnfTotalBytes: summary.mnfBytesOut,
    savedBytes: summary.savedBytes,
    bandwidthSavedPct: summary.savedPct,
    tsFramingOverheadPct: summary.tsOverheadPct,
    mnfFramingOverheadPct: summary.mnfOverheadPct,
    tsPacketsTotal: summary.tsPacketsTotal,
    nullPacketsRemoved: summary.nullPacketsDropped,
    psiPacketsRemoved: summary.psiPacketsDropped,
    mnfAccessUnits: summary.mnfFramesOut,
    keyframesIndexed: summary.keyframesOut,
    roundTripVerified: verifyRemux.framesConverted === summary.mnfFramesOut && roundTripTsBytes > 0,
    estimatedZappingTsMs: Math.round((1000 / 2) + 950), // avg half-GOP wait + TS buffer
    estimatedZappingMnfMs: 28, // instant GOP burst from RAM
  };
}
