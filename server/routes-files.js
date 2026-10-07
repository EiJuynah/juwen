/**
 * 文档管理 API：上传、目录、文档元数据、批注持久化。
 *
 * 上传走 multipart（busboy），逐个文件解析后落盘；
 * 解析失败不影响其它文件，单个文件的结果各自回传，便于前端逐条提示。
 */

import express from 'express';
import busboy from 'busboy';
import { parseDocument } from './parsers/index.js';
import { extractPolicy, findDuplicateIds } from './policy-extract.js';
import { LIMITS, LEVEL } from './files-store.js';

/**
 * 修正上传文件名编码。
 *
 * busboy 按 RFC 7578 用 latin1 解 filename 字段，但浏览器实际发的是
 * UTF-8 字节 —— 于是「坏文件.bin」会变成「åæä»¶.bin」。
 * 这里把 latin1 还原成字节再按 UTF-8 解一次；若解出来有替换字符，
 * 说明原串本来就是合法文本（例如客户端用了 filename* ），保持原样。
 */
function decodeFilename(name) {
  if (!name) return name;
  if (!/[\u0080-\u00ff]/.test(name)) return name; // 纯 ASCII，无需处理
  const converted = Buffer.from(name, 'latin1').toString('utf8');
  return converted.includes('\uFFFD') ? name : converted;
}

/** 读取 multipart，返回 { fields, files:[{filename, buffer, truncated}] } */
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        limits: {
          fileSize: LIMITS.maxFileBytes,
          files: LIMITS.maxFilesPerUpload,
          fields: 20,
        },
      });
    } catch (err) {
      reject(err);
      return;
    }

    const fields = {};
    const files = [];
    const pending = [];

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('file', (name, stream, info) => {
      const chunks = [];
      let truncated = false;
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => {
        truncated = true;
      });
      pending.push(
        new Promise((res) => {
          stream.on('end', () => {
            files.push({
              filename: decodeFilename(info.filename),
              buffer: Buffer.concat(chunks),
              truncated,
            });
            res();
          });
        }),
      );
    });

    bb.on('error', reject);
    bb.on('close', async () => {
      await Promise.all(pending);
      resolve({ fields, files });
    });

    req.pipe(bb);
  });
}

export function createFilesRouter(store) {
  const router = express.Router();

  // ---------- 目录树 ----------
  router.get('/files/tree', (_req, res) => {
    res.json(store.tree());
  });

  // ---------- 文件夹 ----------
  router.post('/folders', async (req, res) => {
    try {
      const folder = await store.createFolder(req.body?.name, req.body?.parentId ?? null);
      res.json({ ok: true, folder });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/folders/:folderId', async (req, res) => {
    try {
      const folder = await store.renameFolder(req.params.folderId, req.body?.name);
      res.json({ ok: true, folder });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/folders/:folderId', async (req, res) => {
    try {
      await store.deleteFolder(req.params.folderId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---------- 上传 ----------
  router.post('/files/upload', async (req, res) => {
    if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data')) {
      return res.status(400).json({ error: '请以 multipart/form-data 上传' });
    }

    let payload;
    try {
      payload = await readMultipart(req);
    } catch (err) {
      return res.status(400).json({ error: `解析上传内容失败：${err.message}` });
    }

    if (payload.files.length === 0) {
      return res.status(400).json({ error: '没有收到文件' });
    }

    const folderId = payload.fields.folderId || null;
    const level = payload.fields.level === LEVEL.INTERNAL ? LEVEL.INTERNAL : LEVEL.PUBLIC;

    // 逐个文件处理，互不影响：某个文件坏掉不该让整批上传失败
    const results = [];
    for (const file of payload.files) {
      const base = { name: file.filename };
      try {
        if (file.truncated) {
          throw new Error(`文件超过 ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)}MB 上限`);
        }
        if (file.buffer.length === 0) {
          throw new Error('文件内容为空');
        }

        const parsedDoc = await parseDocument(file.buffer);
        let policy = null;
        let warnings = [];

        if (parsedDoc.supported) {
          policy = extractPolicy(parsedDoc.paragraphs);
          const dupes = findDuplicateIds(policy);
          if (dupes.length) {
            // pid 重复会让 AI 引用回查指到错误条款，必须显式告警
            warnings.push(`存在重复的段落编号：${dupes.slice(0, 5).join('、')}`);
          }
          if (policy.stats.articles === 0) {
            warnings.push('未能识别出条文结构（未找到「第X条」等编号），已按段落切分');
          }
        }

        const doc = await store.saveUpload(file.buffer, file.filename, {
          folderId,
          level,
          parsed: {
            format: parsedDoc.format,
            formatLabel: parsedDoc.formatLabel,
            supported: parsedDoc.supported,
            reason: parsedDoc.reason ?? '',
            policy,
            warnings,
            stats: policy?.stats ?? null,
            parsedAt: Date.now(),
          },
        });

        results.push({
          ...base,
          ok: true,
          // 文件已存下，但可能是「存下了却解析不了」——两者要分开表达，
          // 否则用户会以为它能用
          supported: parsedDoc.supported,
          reason: parsedDoc.reason ?? '',
          docId: doc.id,
          title: doc.title,
          format: doc.formatLabel,
          level: doc.level,
          deduped: doc.deduped,
          stats: policy?.stats ?? null,
          warnings,
        });
      } catch (err) {
        results.push({ ...base, ok: false, error: err.message });
      }
    }

    res.json({ ok: results.some((r) => r.ok), results });
  });

  // ---------- 文档详情 ----------
  router.get('/files/:docId', async (req, res) => {
    const doc = store.findDoc(req.params.docId);
    if (!doc) return res.status(404).json({ error: '文档不存在' });
    const parsed = await store.readParsed(doc.id);
    res.json({ doc, policy: parsed?.policy ?? null, warnings: parsed?.warnings ?? [] });
  });

  router.patch('/files/:docId', async (req, res) => {
    try {
      const doc = await store.updateDoc(req.params.docId, req.body ?? {});
      res.json({ ok: true, doc });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/files/:docId', async (req, res) => {
    try {
      await store.deleteDoc(req.params.docId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 原始文件下载
  router.get('/files/:docId/source', async (req, res) => {
    const doc = store.findDoc(req.params.docId);
    if (!doc) return res.status(404).json({ error: '文档不存在' });
    try {
      const buf = await store.readSource(doc.id);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      );
      res.send(buf);
    } catch {
      res.status(404).json({ error: '原始文件缺失' });
    }
  });

  // ---------- 批注持久化（按文档） ----------
  router.get('/files/:docId/comments', async (req, res) => {
    const doc = store.findDoc(req.params.docId);
    if (!doc) return res.status(404).json({ error: '文档不存在' });
    const buf = await store.readComments(doc.id);
    if (!buf || buf.length === 0) return res.json({ ok: true, empty: true });
    // 直接回传 Yjs 二进制；前端用 applyUpdate 合并
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buf);
  });

  router.put(
    '/files/:docId/comments',
    express.raw({ type: 'application/octet-stream', limit: '8mb' }),
    async (req, res) => {
      const doc = store.findDoc(req.params.docId);
      if (!doc) return res.status(404).json({ error: '文档不存在' });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length === 0) return res.status(400).json({ error: '空更新' });
      try {
        const size = await store.writeComments(doc.id, body);
        res.json({ ok: true, bytes: size });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },
  );

  router.delete('/files/:docId/comments', async (req, res) => {
    const doc = store.findDoc(req.params.docId);
    if (!doc) return res.status(404).json({ error: '文档不存在' });
    await store.clearComments(doc.id);
    res.json({ ok: true });
  });

  return router;
}
