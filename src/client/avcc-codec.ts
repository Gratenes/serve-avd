/**
 * Wire parser for the serve-avd `/stream.avcc` H.264 stream (format shared
 * with serve-sim).
 *
 * Each chunk is a 4-byte big-endian length (covering the tag byte + payload)
 * followed by a one-byte tag and the payload:
 *
 *   [len:u32-be][tag:u8][payload…]   where len === payload.length + 1
 *
 *   0x01 description — avcC parameter-set blob (SPS/PPS); configures decoder
 *   0x02 keyframe    — IDR (decodable standalone)
 *   0x03 delta       — non-IDR P-frame
 *   0x04 seed        — PNG/JPEG painted before the first IDR decodes
 *
 * Chunks arrive split across `fetch()` reads; the demuxer buffers partial
 * bytes and yields whole chunks. Pure: no DOM, no WebCodecs, no network.
 */

export type AvccChunkType = "description" | "keyframe" | "delta" | "seed";

export interface AvccChunk {
  type: AvccChunkType;
  /** Payload bytes (tag stripped). */
  payload: Uint8Array;
}

const TAG_TO_TYPE: Record<number, AvccChunkType | undefined> = {
  0x01: "description",
  0x02: "keyframe",
  0x03: "delta",
  0x04: "seed",
};

/** Stateful demuxer: feed each network read, get back fully-buffered chunks. */
export class AvccDemuxer {
  // Growable accumulation buffer; `len` is the logical end of valid bytes.
  private buffer = new Uint8Array(64 * 1024);
  private len = 0;

  push(bytes: Uint8Array): AvccChunk[] {
    if (bytes.length > 0) {
      if (this.len + bytes.length > this.buffer.length) {
        let cap = this.buffer.length;
        while (cap < this.len + bytes.length) cap *= 2;
        const grown = new Uint8Array(cap);
        grown.set(this.buffer.subarray(0, this.len));
        this.buffer = grown;
      }
      this.buffer.set(bytes, this.len);
      this.len += bytes.length;
    }

    const chunks: AvccChunk[] = [];
    const buf = this.buffer;
    let start = 0;
    while (this.len - start >= 4) {
      const length =
        ((buf[start]! << 24) | (buf[start + 1]! << 16) | (buf[start + 2]! << 8) | buf[start + 3]!) >>> 0;
      if (this.len - start - 4 < length) break;
      if (length < 1) {
        start += 4; // malformed — resync rather than spin
        continue;
      }
      const type = TAG_TO_TYPE[buf[start + 4]!];
      if (type) chunks.push({ type, payload: buf.slice(start + 5, start + 4 + length) });
      start += 4 + length;
    }
    if (start > 0) {
      this.buffer.copyWithin(0, start, this.len);
      this.len -= start;
    }
    return chunks;
  }

  reset(): void {
    this.len = 0;
  }
}

/**
 * WebCodecs codec string from an avcC blob: bytes 1–3 are profile /
 * constraint flags / level, e.g. `avc1.640028`.
 */
export function avcCodecString(description: Uint8Array): string {
  if (description.length < 4) return "avc1.42E01E";
  const hex2 = (b: number) => b.toString(16).padStart(2, "0");
  return "avc1." + hex2(description[1]!) + hex2(description[2]!) + hex2(description[3]!);
}

/** True when the runtime can decode the AVCC stream (WebCodecs available). */
export function isAvccSupported(): boolean {
  return typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== "undefined";
}
