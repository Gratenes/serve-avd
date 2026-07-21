/**
 * H.264 Annex B → AVCC envelope conversion.
 *
 * `adb exec-out screenrecord --output-format=h264 -` emits a raw Annex B
 * elementary stream: NAL units separated by 00 00 01 / 00 00 00 01 start
 * codes. The browser decodes with WebCodecs `VideoDecoder` in AVCC mode, so we
 * re-frame on the server:
 *
 *   - SPS (NAL 7) + PPS (NAL 8) → an `avcC` decoder-configuration blob,
 *     shipped in a `description` envelope (and replayed to late joiners).
 *   - Each VCL NAL (1 = P slice, 5 = IDR) → one video frame, shipped as a
 *     4-byte-length-prefixed NAL in a `keyframe`/`delta` envelope.
 *
 * Envelope wire format (kept identical to serve-sim's `/stream.avcc`):
 *
 *   [len:u32-be][tag:u8][payload…]   where len === payload.length + 1
 *
 *   0x01 description — avcC blob (SPS/PPS); configures the decoder
 *   0x02 keyframe    — IDR access unit (decodable standalone)
 *   0x03 delta       — non-IDR P-frame
 *   0x04 seed        — PNG/JPEG painted on connect before the first IDR decodes
 */

export const AVCC_TAG_DESCRIPTION = 0x01;
export const AVCC_TAG_KEYFRAME = 0x02;
export const AVCC_TAG_DELTA = 0x03;
export const AVCC_TAG_SEED = 0x04;

/** Wrap a payload in the `[len][tag][payload]` envelope. */
export function wrapEnvelope(tag: number, payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt32BE(payload.length + 1, 0); // length covers the tag byte + payload
  out[4] = tag;
  out.set(payload, 5);
  return out;
}

export const NAL_SLICE = 1;
export const NAL_IDR = 5;
export const NAL_SEI = 6;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

export interface NalUnit {
  /** nal_unit_type (header byte & 0x1f). */
  type: number;
  /** NAL bytes including the header byte, excluding the start code. */
  data: Buffer;
}

/**
 * Incremental Annex B splitter. Feed arbitrary byte chunks; whole NAL units
 * come out. A NAL is complete once the *next* start code arrives, so the final
 * NAL of a stream is only emitted by `flush()`.
 */
export class AnnexBParser {
  private pending: Buffer = Buffer.alloc(0);
  /** Byte offset in `pending` where the current (incomplete) NAL starts, or -1 before the first start code. */
  private nalStart = -1;
  private scanFrom = 0;

  push(chunk: Buffer): NalUnit[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const nals: NalUnit[] = [];
    const buf = this.pending;

    let i = this.scanFrom;
    const end = buf.length - 2;
    while (i < end) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        const startCodeAt = i > 0 && buf[i - 1] === 0 ? i - 1 : i; // tolerate 4-byte start codes
        if (this.nalStart >= 0 && startCodeAt > this.nalStart) {
          const nal = buf.subarray(this.nalStart, startCodeAt);
          if (nal.length > 0) nals.push({ type: nal[0]! & 0x1f, data: Buffer.from(nal) });
        }
        this.nalStart = i + 3;
        i += 3;
      } else {
        i++;
      }
    }

    // Compact: drop everything before the current NAL start (or keep the last
    // few bytes when we haven't seen any start code yet).
    const keepFrom = this.nalStart >= 0 ? this.nalStart : Math.max(0, buf.length - 3);
    const consumedNal = this.nalStart >= 0;
    this.pending = Buffer.from(buf.subarray(keepFrom));
    this.nalStart = consumedNal ? 0 : -1;
    // Resume scanning near the end of retained bytes (a start code may straddle
    // chunk boundaries). Rescanning retained NAL bytes is safe: emulation
    // prevention guarantees 00 00 01 never occurs inside a NAL.
    this.scanFrom = Math.max(0, this.pending.length - 3);
    return nals;
  }

  /** Emit the trailing NAL when the producer (screenrecord) exits. */
  flush(): NalUnit[] {
    const nals: NalUnit[] = [];
    if (this.nalStart >= 0 && this.pending.length > this.nalStart) {
      const nal = this.pending.subarray(this.nalStart);
      if (nal.length > 0) nals.push({ type: nal[0]! & 0x1f, data: Buffer.from(nal) });
    }
    this.pending = Buffer.alloc(0);
    this.nalStart = -1;
    this.scanFrom = 0;
    return nals;
  }
}

/** Build an avcC (AVCDecoderConfigurationRecord) from raw SPS + PPS NALs. */
export function buildAvcC(sps: Buffer, pps: Buffer): Buffer {
  const out = Buffer.allocUnsafe(11 + sps.length + pps.length);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = sps[1]!; // AVCProfileIndication
  out[o++] = sps[2]!; // profile_compatibility
  out[o++] = sps[3]!; // AVCLevelIndication
  out[o++] = 0xff; // lengthSizeMinusOne = 3 (4-byte NAL lengths)
  out[o++] = 0xe1; // numOfSequenceParameterSets = 1
  out.writeUInt16BE(sps.length, o);
  o += 2;
  sps.copy(out, o);
  o += sps.length;
  out[o++] = 1; // numOfPictureParameterSets
  out.writeUInt16BE(pps.length, o);
  o += 2;
  pps.copy(out, o);
  return out;
}

/** Length-prefix a NAL for AVCC framing. */
export function avccFrame(nal: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + nal.length);
  out.writeUInt32BE(nal.length, 0);
  nal.copy(out, 4);
  return out;
}

export interface AvccEvent {
  kind: "description" | "keyframe" | "delta";
  /** Fully-framed `[len][tag][payload]` envelope, ready for the wire. */
  envelope: Buffer;
}

/**
 * Stateful Annex B → AVCC envelope pipeline. Feed screenrecord stdout chunks;
 * emits `description` whenever the parameter sets change (each screenrecord
 * session re-sends SPS/PPS) and one keyframe/delta envelope per video frame.
 */
export class AvccEncoder {
  private readonly parser = new AnnexBParser();
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private lastDescription: Buffer | null = null;

  push(chunk: Buffer): AvccEvent[] {
    return this.handleNals(this.parser.push(chunk));
  }

  flush(): AvccEvent[] {
    return this.handleNals(this.parser.flush());
  }

  private handleNals(nals: NalUnit[]): AvccEvent[] {
    const events: AvccEvent[] = [];
    for (const nal of nals) {
      switch (nal.type) {
        case NAL_SPS:
          this.sps = nal.data;
          break;
        case NAL_PPS:
          this.pps = nal.data;
          break;
        case NAL_IDR:
        case NAL_SLICE: {
          const description = this.descriptionIfChanged();
          if (description) events.push({ kind: "description", envelope: description });
          const isKey = nal.type === NAL_IDR;
          events.push({
            kind: isKey ? "keyframe" : "delta",
            envelope: wrapEnvelope(isKey ? AVCC_TAG_KEYFRAME : AVCC_TAG_DELTA, avccFrame(nal.data)),
          });
          break;
        }
        default:
          break; // SEI/AUD/filler — parameter sets live in the description
      }
    }
    return events;
  }

  private descriptionIfChanged(): Buffer | null {
    if (!this.sps || !this.pps) return null;
    const avcc = buildAvcC(this.sps, this.pps);
    if (this.lastDescription && avcc.equals(this.lastDescription)) return null;
    this.lastDescription = avcc;
    return wrapEnvelope(AVCC_TAG_DESCRIPTION, avcc);
  }
}
