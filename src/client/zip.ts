/** Small, standards-compatible uncompressed ZIP writer for local artifact/repro downloads. */
export interface ZipFile {
  name: string;
  data: Uint8Array;
}
const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data)
    value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function header(size: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}
export function zipFiles(files: ZipFile[]): Blob {
  if (files.length > 65535) throw new Error("ZIP contains too many files");
  if (
    files.reduce(
      (sum, file) => sum + file.data.length + file.name.length * 6 + 80,
      22,
    ) >
    256 * 1024 * 1024
  )
    throw new Error("ZIP exceeds the 256 MB browser download limit");
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  for (const file of files) {
    const safe = file.name
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .join("/");
    const name = new TextEncoder().encode(safe);
    if (!safe || name.length > 65535 || file.data.length > 256 * 1024 * 1024)
      throw new Error("Invalid ZIP entry");
    const checksum = crc(file.data);
    const local = header(30 + name.length);
    const l = local.view;
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x800, true);
    l.setUint32(14, checksum, true);
    l.setUint32(18, file.data.length, true);
    l.setUint32(22, file.data.length, true);
    l.setUint16(26, name.length, true);
    local.bytes.set(name, 30);
    parts.push(
      local.bytes.buffer as ArrayBuffer,
      file.data.slice().buffer as ArrayBuffer,
    );
    const entry = header(46 + name.length);
    const c = entry.view;
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint32(16, checksum, true);
    c.setUint32(20, file.data.length, true);
    c.setUint32(24, file.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    entry.bytes.set(name, 46);
    central.push(entry.bytes);
    offset += local.bytes.length + file.data.length;
    count++;
  }
  const centralSize = central.reduce((total, bytes) => total + bytes.length, 0);
  for (const bytes of central) parts.push(bytes.buffer as ArrayBuffer);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, count, true);
  end.view.setUint16(10, count, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  parts.push(end.bytes.buffer as ArrayBuffer);
  return new Blob(parts, { type: "application/zip" });
}
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function zipText(name: string, value: unknown): ZipFile {
  return {
    name,
    data: new TextEncoder().encode(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    ),
  };
}
