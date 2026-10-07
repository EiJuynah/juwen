/**
 * 文档存储层：上传落盘、目录文件夹、解析结果与批注的持久化。
 *
 * 目录结构（owner 维度已预留，日后接入账号只需换 ownerId，不必迁移数据）：
 *   data/users/<ownerId>/
 *     index.json              目录树 + 文档元数据索引
 *     docs/<docId>/
 *       source.bin            原始文件字节
 *       parsed.json           解析 + 条文结构化结果
 *       comments.ydoc         Yjs 增量更新（划词批注 + AI 解释记录）
 *       meta.json             文件名 / 密级 / 归属文件夹等
 *
 * docId 取文件内容哈希前 16 位，因此同一文件重复上传会命中同一条记录，
 * 既天然去重，也让批注不会因为重复上传而丢掉。
 *
 * 安全：docId 固定为十六进制，文件夹名一律清洗（禁路径分隔符与 ..），
 * 落盘路径永不拼接用户原始输入，从根上避免路径穿越。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 密级字段（历史遗留）。
 * 前端已整体取消密级：上传不再选、列表不再打标记。
 * 服务端保留该字段只为兼容已有 meta.json，不参与任何逻辑判断。
 */
export const LEVEL = { PUBLIC: 'public', INTERNAL: 'internal' };

export const LIMITS = {
  /** 单文件上限 50MB */
  maxFileBytes: 50 * 1024 * 1024,
  /** 单次请求最多文件数 */
  maxFilesPerUpload: 20,
  /** 文件夹名最大长度 */
  maxFolderNameLen: 60,
  /** 文件夹嵌套深度 */
  maxFolderDepth: 6,
};

const DEFAULT_OWNER = 'local';

const now = () => Date.now();

/** 文件名清洗：去掉路径成分与危险字符，保留中文 */
export function sanitizeName(raw, fallback = '未命名') {
  let name = String(raw ?? '').replace(/\\/g, '/');
  name = name.split('/').pop() ?? '';
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/\.+$/, '').trim();
  if (!name || name === '.' || name === '..') name = fallback;
  return name.slice(0, 200);
}

/** 文件夹名清洗：额外禁掉 . 与 ..，并限制长度 */
export function sanitizeFolderName(raw) {
  const name = sanitizeName(raw, '')
    .replace(/^\.+/, '')
    .trim();
  if (!name) throw new Error('文件夹名不能为空');
  if (name.length > LIMITS.maxFolderNameLen) {
    throw new Error(`文件夹名过长（最多 ${LIMITS.maxFolderNameLen} 字）`);
  }
  return name;
}

export class FileStore {
  constructor(rootDir, ownerId = DEFAULT_OWNER) {
    this.ownerId = ownerId;
    this.root = path.join(rootDir, 'users', ownerId);
    this.docsDir = path.join(this.root, 'docs');
    this.indexPath = path.join(this.root, 'index.json');
    this._index = null;
  }

  async init() {
    await fsp.mkdir(this.docsDir, { recursive: true });
    try {
      await fsp.access(this.indexPath);
    } catch {
      await this._writeIndex({ version: 1, ownerId: this.ownerId, folders: [], docs: [] });
    }
    await this._loadIndex();
  }

  async _loadIndex() {
    const raw = await fsp.readFile(this.indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    this._index = {
      version: parsed.version ?? 1,
      ownerId: parsed.ownerId ?? this.ownerId,
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      docs: Array.isArray(parsed.docs) ? parsed.docs : [],
    };
    return this._index;
  }

  async _writeIndex(next) {
    const data = next ?? this._index;
    // 先写临时文件再改名：避免进程中断留下半截 JSON 导致整个库读不出来
    const tmp = `${this.indexPath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, this.indexPath);
    this._index = data;
  }

  get index() {
    if (!this._index) throw new Error('FileStore 未初始化，请先调用 init()');
    return this._index;
  }

  _docDir(docId) {
    if (!/^[0-9a-f]{16}$/.test(docId)) throw new Error('docId 非法');
    return path.join(this.docsDir, docId);
  }

  // ---------- 目录 ----------

  /** 完整目录树：文件夹（含层级）与文档 */
  tree() {
    return {
      folders: this.index.folders.map((f) => ({ ...f })),
      docs: this.index.docs.map((d) => ({ ...d })),
    };
  }

  _folderDepth(folderId) {
    let depth = 0;
    let cur = this.index.folders.find((f) => f.id === folderId);
    while (cur?.parentId) {
      depth += 1;
      if (depth > LIMITS.maxFolderDepth + 2) break; // 防环
      cur = this.index.folders.find((f) => f.id === cur.parentId);
    }
    return depth;
  }

  async createFolder(rawName, parentId = null) {
    const name = sanitizeFolderName(rawName);
    if (parentId && !this.index.folders.some((f) => f.id === parentId)) {
      throw new Error('上级文件夹不存在');
    }
    if (parentId && this._folderDepth(parentId) + 1 > LIMITS.maxFolderDepth) {
      throw new Error(`文件夹层级过深（最多 ${LIMITS.maxFolderDepth} 层）`);
    }
    const dup = this.index.folders.find((f) => f.name === name && f.parentId === parentId);
    if (dup) throw new Error(`同级下已存在同名文件夹「${name}」`);

    const folder = {
      id: crypto.randomBytes(6).toString('hex'),
      name,
      parentId: parentId ?? null,
      createdAt: now(),
    };
    this.index.folders.push(folder);
    await this._writeIndex();
    return folder;
  }

  async renameFolder(folderId, rawName) {
    const name = sanitizeFolderName(rawName);
    const folder = this.index.folders.find((f) => f.id === folderId);
    if (!folder) throw new Error('文件夹不存在');
    const dup = this.index.folders.find(
      (f) => f.id !== folderId && f.name === name && f.parentId === folder.parentId,
    );
    if (dup) throw new Error(`同级下已存在同名文件夹「${name}」`);
    folder.name = name;
    await this._writeIndex();
    return folder;
  }

  /** 删除文件夹：仅允许删空文件夹，避免误删整棵子树里的文档 */
  async deleteFolder(folderId) {
    const folder = this.index.folders.find((f) => f.id === folderId);
    if (!folder) throw new Error('文件夹不存在');
    const hasChildFolder = this.index.folders.some((f) => f.parentId === folderId);
    const hasDocs = this.index.docs.some((d) => d.folderId === folderId);
    if (hasChildFolder || hasDocs) {
      throw new Error('文件夹非空，请先移走其中的文档与子文件夹');
    }
    this.index.folders = this.index.folders.filter((f) => f.id !== folderId);
    await this._writeIndex();
  }

  // ---------- 文档 ----------

  async saveUpload(buffer, originalName, { folderId = null, level = LEVEL.PUBLIC, parsed = null } = {}) {
    if (buffer.length > LIMITS.maxFileBytes) {
      throw new Error(`文件超过 ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)}MB 上限`);
    }
    if (folderId && !this.index.folders.some((f) => f.id === folderId)) {
      throw new Error('目标文件夹不存在');
    }
    if (!Object.values(LEVEL).includes(level)) {
      throw new Error('密级取值非法');
    }

    const docId = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const dir = this._docDir(docId);
    const name = sanitizeName(originalName);
    const ext = (name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();

    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'source.bin'), buffer);

    const existing = this.index.docs.find((d) => d.id === docId);
    const meta = {
      id: docId,
      name,
      ext,
      size: buffer.length,
      folderId: folderId ?? null,
      level,
      format: parsed?.format ?? null,
      formatLabel: parsed?.formatLabel ?? null,
      supported: parsed?.supported ?? false,
      reason: parsed?.reason ?? '',
      stats: parsed?.stats ?? null,
      title: parsed?.policy?.title ?? name,
      deduped: Boolean(existing),
      uploadedAt: existing?.uploadedAt ?? now(),
      updatedAt: now(),
    };
    await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    if (parsed) {
      await fsp.writeFile(path.join(dir, 'parsed.json'), JSON.stringify(parsed, null, 2), 'utf8');
    }

    if (existing) {
      Object.assign(existing, meta);
    } else {
      this.index.docs.push(meta);
    }
    await this._writeIndex();
    return meta;
  }

  findDoc(docId) {
    return this.index.docs.find((d) => d.id === docId) ?? null;
  }

  async readSource(docId) {
    return fsp.readFile(path.join(this._docDir(docId), 'source.bin'));
  }

  async readParsed(docId) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this._docDir(docId), 'parsed.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async updateDoc(docId, patch = {}) {
    const doc = this.findDoc(docId);
    if (!doc) throw new Error('文档不存在');

    if (patch.name !== undefined) doc.name = sanitizeName(patch.name, doc.name);
    if (patch.folderId !== undefined) {
      if (patch.folderId && !this.index.folders.some((f) => f.id === patch.folderId)) {
        throw new Error('目标文件夹不存在');
      }
      doc.folderId = patch.folderId ?? null;
    }
    if (patch.level !== undefined) {
      if (!Object.values(LEVEL).includes(patch.level)) throw new Error('密级取值非法');
      doc.level = patch.level;
    }
    doc.updatedAt = now();

    await fsp.writeFile(path.join(this._docDir(docId), 'meta.json'), JSON.stringify(doc, null, 2), 'utf8');
    await this._writeIndex();
    return doc;
  }

  async deleteDoc(docId) {
    const doc = this.findDoc(docId);
    if (!doc) throw new Error('文档不存在');
    this.index.docs = this.index.docs.filter((d) => d.id !== docId);
    await this._writeIndex();
    // 索引先落地，再删文件：即使删除失败，索引也不会指向幽灵目录
    await fsp.rm(this._docDir(docId), { recursive: true, force: true });
  }

  // ---------- 批注（按文档持久化） ----------

  /** 读取该文档的 Yjs 更新；无则返回 null */
  async readComments(docId) {
    try {
      return await fsp.readFile(path.join(this._docDir(docId), 'comments.ydoc'));
    } catch {
      return null;
    }
  }

  /**
   * 写入该文档的 Yjs 更新（整体状态快照）。
   * 采用「写临时文件 + 改名」保证不会读到半截数据。
   */
  async writeComments(docId, buffer) {
    if (!this.findDoc(docId)) throw new Error('文档不存在');
    const dir = this._docDir(docId);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, 'comments.ydoc');
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, target);
    return buffer.length;
  }

  async clearComments(docId) {
    const target = path.join(this._docDir(docId), 'comments.ydoc');
    await fsp.rm(target, { force: true });
  }
}

/** 便捷工厂：建好目录并返回可用实例 */
export async function createFileStore(rootDir, ownerId) {
  const store = new FileStore(rootDir, ownerId);
  await store.init();
  return store;
}

export { DEFAULT_OWNER };
export { fs };
