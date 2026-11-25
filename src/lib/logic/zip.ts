const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.set([c >>> 0], n);
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes.at(i) ?? 0;
    c = (CRC_TABLE.at((c ^ b) & 0xff) ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  content: string;
}

/**
 * Pure uncompressed (STORE) PKZIP archive generator for bulk offline lab file exports.
 */
export function buildZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const enc = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const dataBytes = enc.encode(entry.content);
    const crc = crc32(dataBytes);

    const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, 0, true); // compression: STORE
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.length);
    localChunks.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length;
  }

  const centralLen = centralChunks.reduce((acc, c) => acc + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralLen, true);
  ev.setUint32(16, offset, true);

  const total = new Uint8Array(offset + centralLen + end.length);
  let ptr = 0;
  for (const c of localChunks) {
    total.set(c, ptr);
    ptr += c.length;
  }
  for (const c of centralChunks) {
    total.set(c, ptr);
    ptr += c.length;
  }
  total.set(end, ptr);
  return total;
}
