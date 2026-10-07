/**
 * OLE2 / CFB（Compound File Binary）容器读取器。
 *
 * 为什么需要它：.doc / .xls / .ppt 这些 97-2003 老格式，
 * 以及 WPS 的 .wps / .wpt / .et / .dps 都可能落在这个容器里。
 * 它们共享同一个 magic bytes（D0CF11E0A1B11AE1），
 * 必须读内部流名才能区分到底是 Word、Excel 还是 PPT。
 */

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
/** 小于该阈值的流存在 mini stream 里（按 64 字节小扇区切分） */
const DEFAULT_MINI_CUTOFF = 4096;

export function isOle2(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

export class Ole2File {
  constructor(buf) {
    this.buf = buf;
    const header = buf;

    this.sectorShift = header.readUInt16LE(0x1e);
    this.miniSectorShift = header.readUInt16LE(0x20);
    this.sectorSize = 1 << this.sectorShift;
    this.miniSectorSize = 1 << this.miniSectorShift;
    this.miniCutoff = header.readUInt32LE(0x38) || DEFAULT_MINI_CUTOFF;

    if (this.sectorShift < 7 || this.sectorShift > 20) {
      throw new Error('OLE2 扇区大小异常，文件可能已损坏');
    }

    // CFB 头部字段顺序（注意 0x28 是「目录扇区数」而非 FAT 数，
    // v3 文档该值恒为 0，极易与 0x2C 混淆；实测读错会导致整份文件解析失败）
    this.numFatSectors = header.readUInt32LE(0x2c);
    this.firstDirSector = header.readUInt32LE(0x30);
    this.firstMiniFatSector = header.readUInt32LE(0x3c);
    this.numMiniFatSectors = header.readUInt32LE(0x40);
    this.firstDifatSector = header.readUInt32LE(0x44);
    this.numDifatSectors = header.readUInt32LE(0x48);

    this._readDifat(header);
    this._readFat();
    this._readMiniFat();
    this._readDirectory();
  }

  /** 扇区号 → 字节偏移（扇区 0 紧跟在 512 字节头之后） */
  _sectorOffset(sector) {
    return (sector + 1) * this.sectorSize;
  }

  _readSector(sector) {
    const off = this._sectorOffset(sector);
    return this.buf.subarray(off, off + this.sectorSize);
  }

  /** DIFAT = FAT 扇区号列表，前 109 个在头部，其余在 DIFAT 链里 */
  _readDifat(header) {
    this.difat = [];
    for (let i = 0; i < 109; i++) {
      const s = header.readUInt32LE(0x4c + i * 4);
      if (s === FREESECT || s === ENDOFCHAIN) continue;
      this.difat.push(s);
    }
    let next = this.firstDifatSector;
    let guard = 0;
    const perSector = this.sectorSize / 4 - 1; // 末项是下一 DIFAT 扇区号
    while (next !== ENDOFCHAIN && next !== FREESECT && guard++ < 10000) {
      const sec = this._readSector(next);
      for (let i = 0; i < perSector; i++) {
        const s = sec.readUInt32LE(i * 4);
        if (s === FREESECT || s === ENDOFCHAIN) continue;
        this.difat.push(s);
      }
      next = sec.readUInt32LE(perSector * 4);
    }
  }

  _readFat() {
    this.fat = [];
    for (let i = 0; i < this.numFatSectors; i++) {
      const sector = this.difat[i];
      if (sector === undefined) break;
      const sec = this._readSector(sector);
      for (let j = 0; j < this.sectorSize / 4; j++) {
        this.fat.push(sec.readUInt32LE(j * 4));
      }
    }
  }

  _readMiniFat() {
    this.miniFat = [];
    let sector = this.firstMiniFatSector;
    let guard = 0;
    while (sector !== ENDOFCHAIN && sector !== FREESECT && guard++ < 100000) {
      const sec = this._readSector(sector);
      for (let j = 0; j < this.sectorSize / 4; j++) {
        this.miniFat.push(sec.readUInt32LE(j * 4));
      }
      sector = this.fat[sector];
      if (sector === undefined) break;
    }
  }

  /**
   * 按 FAT 链把扇区拼成完整数据。
   * @param {number} startSector 起始扇区号
   * @param {number} size 期望字节数；传 -1 表示读到链尾（目录流用）
   * @param {'fat'|'mini'} table 使用哪张分配表
   */
  _readChain(startSector, size, table = 'fat') {
    if (table === 'mini') {
      // mini stream 本体是 root entry 的常规扇区链；先整体取出再按下标切，
      // 直接按 (root起始 + 下标*64) 定位只在 mini stream 恰好连续时才成立
      const mini = this._getMiniStream();
      const step = this.miniSectorSize;
      const chunks = [];
      let sector = startSector;
      let remaining = size;
      let guard = 0;
      while (sector !== ENDOFCHAIN && sector !== FREESECT && guard++ < 1e6) {
        if (size >= 0 && remaining <= 0) break;
        const off = sector * step;
        if (off >= mini.length) break;
        const data = mini.subarray(off, off + step);
        chunks.push(data);
        remaining -= data.length;
        const next = this.miniFat[sector];
        if (next === undefined) break;
        sector = next;
      }
      const out = Buffer.concat(chunks);
      return size >= 0 ? out.subarray(0, size) : out;
    }

    const chunks = [];
    let sector = startSector;
    let remaining = size;
    let guard = 0;
    while (sector !== ENDOFCHAIN && sector !== FREESECT && guard++ < 1e6) {
      if (size >= 0 && remaining <= 0) break;
      const off = this._sectorOffset(sector);
      const data = this.buf.subarray(off, off + this.sectorSize);
      chunks.push(data);
      remaining -= data.length;
      const next = this.fat[sector];
      if (next === undefined) break;
      sector = next;
    }
    const out = Buffer.concat(chunks);
    return size >= 0 ? out.subarray(0, size) : out;
  }

  /** 取出 mini stream 全量内容（仅 root entry 存在时） */
  _getMiniStream() {
    if (this._miniStream) return this._miniStream;
    if (this.miniStreamStart === undefined) return Buffer.alloc(0);
    this._miniStream = this._readChain(this.miniStreamStart, -1, 'fat');
    return this._miniStream;
  }

  _readDirectory() {
    // 目录流本身是一条常规扇区链，读到链尾再按 128 字节切
    const dirData = this._readChain(this.firstDirSector, -1);
    this.entries = [];
    for (let off = 0; off + 128 <= dirData.length; off += 128) {
      const nameLen = dirData.readUInt16LE(off + 0x40);
      const objType = dirData[off + 0x42];
      if (objType === 0) continue; // 未使用项
      let name = '';
      if (nameLen > 2) {
        name = dirData
          .subarray(off, off + nameLen - 2)
          .toString('utf16le');
      }
      const startSector = dirData.readUInt32LE(off + 0x74);
      // CFB v3 用 32 位长度；v4 才用 64 位，低 32 位已足够覆盖常见文档
      const size = dirData.readUInt32LE(off + 0x78);
      const entry = { name, objType, startSector, size, isRoot: objType === 5 };
      this.entries.push(entry);
      if (entry.isRoot) this.miniStreamStart = startSector;
    }
  }

  /** 列出全部流名（用于判断 Word / Excel / PPT） */
  listStreams() {
    return this.entries.filter((e) => e.objType === 2).map((e) => e.name);
  }

  hasStream(name) {
    return this.entries.some((e) => e.objType === 2 && e.name === name);
  }

  /** 读取指定流的完整内容 */
  readStream(name) {
    const entry = this.entries.find((e) => e.objType === 2 && e.name === name);
    if (!entry) return null;
    const useMini = entry.size < this.miniCutoff;
    return this._readChain(entry.startSector, entry.size, useMini ? 'mini' : 'fat');
  }
}
