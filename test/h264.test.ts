import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnnexBParser,
  AvccEncoder,
  buildAvcC,
  wrapEnvelope,
  AVCC_TAG_DESCRIPTION,
  AVCC_TAG_KEYFRAME,
  AVCC_TAG_DELTA,
} from "../src/h264";

const START3 = Buffer.from([0, 0, 1]);
const START4 = Buffer.from([0, 0, 0, 1]);

function nal(type: number, payload: number[] = [0xaa, 0xbb]): Buffer {
  return Buffer.from([0x60 | type, ...payload]);
}

test("AnnexBParser splits NALs on 3- and 4-byte start codes", () => {
  const parser = new AnnexBParser();
  const stream = Buffer.concat([START4, nal(7), START3, nal(8), START4, nal(5)]);
  const nals = [...parser.push(stream), ...parser.flush()];
  assert.deepEqual(
    nals.map((n) => n.type),
    [7, 8, 5],
  );
  assert.deepEqual([...nals[2]!.data], [...nal(5)]);
});

test("AnnexBParser handles NALs split across arbitrary chunk boundaries", () => {
  const stream = Buffer.concat([START4, nal(7, [1, 2, 3, 4]), START3, nal(1, [9, 8, 7, 6, 5]), START4, nal(5, [1])]);
  for (let chunkSize = 1; chunkSize <= 7; chunkSize++) {
    const parser = new AnnexBParser();
    const nals = [];
    for (let i = 0; i < stream.length; i += chunkSize) {
      nals.push(...parser.push(Buffer.from(stream.subarray(i, i + chunkSize))));
    }
    nals.push(...parser.flush());
    assert.deepEqual(
      nals.map((n) => n.type),
      [7, 1, 5],
      `chunkSize=${chunkSize}`,
    );
    assert.deepEqual([...nals[1]!.data], [...nal(1, [9, 8, 7, 6, 5])], `chunkSize=${chunkSize}`);
  }
});

test("AvccEncoder emits description then tagged frames", () => {
  const encoder = new AvccEncoder();
  const sps = Buffer.from([0x67, 0x64, 0x00, 0x28, 0x11]);
  const pps = Buffer.from([0x68, 0xee, 0x06]);
  const idr = nal(5, [1, 2, 3]);
  const p = nal(1, [4, 5, 6]);
  const stream = Buffer.concat([START4, sps, START4, pps, START4, idr, START3, p]);
  const events = [...encoder.push(stream), ...encoder.flush()];

  assert.deepEqual(
    events.map((e) => e.kind),
    ["description", "keyframe", "delta"],
  );

  // Description payload is the avcC blob.
  const description = events[0]!.envelope;
  assert.equal(description.readUInt32BE(0), description.length - 4);
  assert.equal(description[4], AVCC_TAG_DESCRIPTION);
  assert.deepEqual(description.subarray(5), buildAvcC(sps, pps));

  // Keyframe payload is a 4-byte-length-prefixed IDR NAL.
  const key = events[1]!.envelope;
  assert.equal(key[4], AVCC_TAG_KEYFRAME);
  assert.equal(key.readUInt32BE(5), idr.length);
  assert.deepEqual(key.subarray(9), idr);

  const delta = events[2]!.envelope;
  assert.equal(delta[4], AVCC_TAG_DELTA);

  // A second screenrecord session with identical SPS/PPS re-emits no description.
  const events2 = [
    ...encoder.push(Buffer.concat([START4, sps, START4, pps, START4, idr])),
    ...encoder.flush(), // the trailing NAL only settles on flush (see VideoCapture)
  ];
  assert.deepEqual(
    events2.map((e) => e.kind),
    ["keyframe"],
  );
});

test("buildAvcC layout", () => {
  const sps = Buffer.from([0x67, 0x64, 0x00, 0x28]);
  const pps = Buffer.from([0x68, 0xee]);
  const avcc = buildAvcC(sps, pps);
  assert.deepEqual(
    [...avcc],
    [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0x00, 0x28, 1, 0, 2, 0x68, 0xee],
  );
});

test("wrapEnvelope length covers tag + payload", () => {
  const env = wrapEnvelope(0x02, Buffer.from([1, 2, 3]));
  assert.equal(env.readUInt32BE(0), 4);
  assert.equal(env[4], 0x02);
  assert.deepEqual([...env.subarray(5)], [1, 2, 3]);
});
