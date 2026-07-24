// zipStore.ts — 零依赖的 ZIP「存储模式」(method=0, 不压缩) 写入器。
// 用于把 AI 会话（成稿 + 来源截图 + 原始对话）打包成便携归档包。
// 选型理由：引入 JSZip 类库体积大且需处理压缩；会话归档本身不需要压缩，
// 直接用 store 模式 + CRC32 即可生成兼容所有解压软件的 zip（macOS/Windows/7z 均可打开）。
// 全部使用标准的 Uint8Array / DataView，浏览器与 Node 22 一致。

const crcTable: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/** 标准 CRC32（IEEE 802.3），返回无符号 32 位整数 */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 把多个 Uint8Array 顺序拼接成一个 */
function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface ZipEntry {
  /** 文件名（支持中文，已用 UTF-8 标志位声明） */
  name: string;
  /** 文件原始字节 */
  data: Uint8Array;
}

/**
 * 构建一个 store 模式的 ZIP 归档（返回完整字节）。
 * @param files 文件列表，顺序即归档内顺序
 */
export function buildZip(files: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate =
    (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const u16 = (v: number): Uint8Array => {
    const a = new Uint8Array(2);
    new DataView(a.buffer).setUint16(0, v, true);
    return a;
  };
  const u32 = (v: number): Uint8Array => {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setUint32(0, v >>> 0, true);
    return a;
  };

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const localHeader = concat([
      u32(0x04034b50), // 本地文件头签名
      u16(20), // version needed
      u16(0x0800), // general purpose flag：bit11 = UTF-8 文件名
      u16(0), // compression method = 0 (store)
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(f.data.length), // compressed size
      u32(f.data.length), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
      f.data,
    ]);
    chunks.push(localHeader);
    const localOffset = offset;
    offset += localHeader.length;

    central.push(
      concat([
        u32(0x02014b50), // 中央目录头签名
        u16(20), // version made by
        u16(20), // version needed
        u16(0x0800),
        u16(0), // method
        u16(dosTime),
        u16(dosDate),
        u32(crc),
        u32(f.data.length),
        u32(f.data.length),
        u16(nameBytes.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(localOffset),
        nameBytes,
      ]),
    );
  }

  const centralData = concat(central);
  const centralOffset = offset;
  const end = concat([
    u32(0x06054b50), // EOCD 签名
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralData.length),
    u32(centralOffset),
    u16(0), // comment length
  ]);

  return concat([...chunks, centralData, end]);
}

/** dataURL (base64) → Uint8Array（用于把缩略图塞进 zip） */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:[\w\/\-\.]+;base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
