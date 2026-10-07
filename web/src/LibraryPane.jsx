/**
 * 文档库面板：上传、目录文件夹、文档列表。
 *
 * 交互约定：
 *   · 拖拽文件到面板任意位置即可上传
 *   · 点击文档即载入阅读区；当前文档高亮
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  createFolder,
  deleteDoc,
  deleteFolder,
  fetchTree,
  updateDoc,
  uploadFiles,
} from './files-api.js';

/** 按格式给个短标签，列表里比 full label 更省地方 */
function shortFormat(doc) {
  const f = doc.formatLabel ?? '';
  if (f.includes('Word')) return 'Word';
  if (f.includes('Excel')) return 'Excel';
  if (f.includes('PPT')) return 'PPT';
  if (f.includes('PDF')) return 'PDF';
  if (f.includes('RTF')) return 'RTF';
  if (f.includes('纯文本')) return '文本';
  return '未知';
}

export default function LibraryPane({
  tree,
  currentDocId,
  onRefresh,
  onOpenDoc,
  onError,
  busy,
  onCollapse,
}) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [uploadFolder, setUploadFolder] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');
  const [menuFor, setMenuFor] = useState(null);
  const fileInputRef = useRef(null);

  const folders = tree?.folders ?? [];
  const docs = tree?.docs ?? [];

  /** 把扁平文件夹列表转成层级结构，便于缩进渲染 */
  const childrenOf = useMemo(() => {
    const map = new Map();
    for (const f of folders) {
      const key = f.parentId ?? '__root__';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(f);
    }
    return map;
  }, [folders]);

  const docsOf = useMemo(() => {
    const map = new Map();
    for (const d of docs) {
      const key = d.folderId ?? '__root__';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(d);
    }
    return map;
  }, [docs]);

  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doUpload = useCallback(
    async (fileList) => {
      const files = [...fileList];
      if (files.length === 0) return;
      setUploading(true);
      setProgress(`正在解析 ${files.length} 个文件…`);
      try {
        const res = await uploadFiles(files, {
          folderId: uploadFolder || undefined,
        });
        const results = res?.results ?? [];
        const ok = results.filter((r) => r.ok);
        const failed = results.filter((r) => !r.ok);
        const unsupported = ok.filter((r) => r.supported === false);

        const parts = [];
        if (ok.length) parts.push(`成功 ${ok.length} 个`);
        if (unsupported.length) parts.push(`${unsupported.length} 个无法解析`);
        if (failed.length) parts.push(`失败 ${failed.length} 个`);
        setProgress(parts.join(' · ') || '完成');

        if (failed.length) {
          onError?.(`${failed.map((f) => `${f.name}：${f.error}`).join('；')}`);
        }
        await onRefresh();
        // 上传成功后自动打开第一个可解析的文档
        const first = ok.find((r) => r.supported !== false);
        if (first?.docId) onOpenDoc?.(first.docId);
      } catch (err) {
        setProgress('');
        onError?.(String(err.message || err));
      } finally {
        setUploading(false);
        setTimeout(() => setProgress(''), 4000);
      }
    },
    [uploadFolder, onRefresh, onOpenDoc, onError],
  );

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) doUpload(e.dataTransfer.files);
  };

  const renderDoc = (doc, depth) => {
    const isCurrent = doc.id === currentDocId;
    const broken = doc.supported === false;
    return (
      <div
        key={doc.id}
        className={`lib-doc ${isCurrent ? 'cur' : ''} ${broken ? 'broken' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => (broken ? onError?.(doc.reason || '该文件无法解析') : onOpenDoc?.(doc.id))}
        title={broken ? doc.reason : `${doc.name}\n${doc.formatLabel ?? ''}`}
      >
        <span className="lib-doc-name">{doc.name}</span>
        <span className="lib-tags">
          <em className="tag">{shortFormat(doc)}</em>
          {broken && <em className="tag warn">不可解析</em>}
        </span>
        <button
          className="lib-more"
          title="更多"
          onClick={(e) => {
            e.stopPropagation();
            setMenuFor(menuFor === doc.id ? null : doc.id);
          }}
        >
          ⋯
        </button>

        {menuFor === doc.id && (
          <div className="lib-menu" onClick={(e) => e.stopPropagation()}>
            <div className="lib-menu-title">移动到</div>
            <button
              onClick={async () => {
                await updateDoc(doc.id, { folderId: null });
                setMenuFor(null);
                onRefresh();
              }}
            >
              根目录
            </button>
            {folders.map((f) => (
              <button
                key={f.id}
                onClick={async () => {
                  await updateDoc(doc.id, { folderId: f.id });
                  setMenuFor(null);
                  onRefresh();
                }}
              >
                {f.name}
              </button>
            ))}
            <div className="lib-menu-sep" />
            <button
              className="danger"
              onClick={async () => {
                setMenuFor(null);
                await deleteDoc(doc.id);
                onRefresh();
              }}
            >
              删除文档
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderFolder = (folder, depth) => {
    const open = expanded.has(folder.id);
    const kids = childrenOf.get(folder.id) ?? [];
    const childDocs = docsOf.get(folder.id) ?? [];
    return (
      <div key={folder.id}>
        <div
          className="lib-folder"
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => toggle(folder.id)}
        >
          <span className="lib-caret">{open ? '▾' : '▸'}</span>
          <span className="lib-folder-name">{folder.name}</span>
          <span className="lib-count">{childDocs.length + kids.length || ''}</span>
          <button
            className="lib-more"
            title="删除文件夹"
            onClick={async (e) => {
              e.stopPropagation();
              try {
                await deleteFolder(folder.id);
                onRefresh();
              } catch (err) {
                onError?.(String(err.message || err));
              }
            }}
          >
            ×
          </button>
        </div>
        {open && (
          <>
            {kids.map((k) => renderFolder(k, depth + 1))}
            {childDocs.map((d) => renderDoc(d, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const rootFolders = childrenOf.get('__root__') ?? [];
  const rootDocs = docsOf.get('__root__') ?? [];

  return (
    <aside
      className={`lib-pane ${dragOver ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="lib-head">
        <div className="lib-title">
          文档库
          <span className="lib-count-total">{docs.length}</span>
          <button
            className="lib-collapse"
            onClick={onCollapse}
            title="收起文档库"
            aria-label="收起文档库"
          >
            «
          </button>
        </div>
        <div className="lib-actions">
          <button
            className="mini"
            disabled={uploading || busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? '处理中…' : '上传'}
          </button>
          <button
            className="mini"
            disabled={uploading || busy}
            onClick={async () => {
              const name = window.prompt('新建文件夹名称');
              if (!name?.trim()) return;
              try {
                await createFolder(name.trim());
                onRefresh();
              } catch (err) {
                onError?.(String(err.message || err));
              }
            }}
          >
            新建文件夹
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) doUpload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <div className="lib-upload-opts">
        <label>
          上传到
          <select value={uploadFolder} onChange={(e) => setUploadFolder(e.target.value)}>
            <option value="">根目录</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="lib-body">
        {docs.length === 0 && !uploading && (
          <div className="lib-empty">
            <p>还没有文档</p>
            <span>把文件拖到这里，或点上方「上传」</span>
            <div className="lib-empty-hint">
              支持 .docx / .doc / .wps / .wpt / .xlsx / .et / .pptx / .dps / .pdf / .rtf / .txt / .md
              <br />
              按文件内容识别格式，扩展名写错也能正确解析
            </div>
          </div>
        )}
        {rootFolders.map((f) => renderFolder(f, 0))}
        {rootDocs.map((d) => renderDoc(d, 0))}
      </div>

      {progress && <div className="lib-progress">{progress}</div>}

      {/* 涉密提示固定挂在面板底部居中：常驻可见，不做成可关闭的浮层 */}
      <div className="lib-secret-notice">
        禁止上传涉密文档
      </div>

      {dragOver && <div className="lib-drop-hint">松开即可上传</div>}
    </aside>
  );
}
