/**
 * 文档库前端 API 封装。
 * 与 server/routes-files.js 的接口一一对应。
 */

const json = async (resp) => {
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    if (!resp.ok) throw new Error(`请求失败（${resp.status}）`);
    return null;
  }
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error || `请求失败（${resp.status}）`);
  return data;
};

/** 目录树：{ folders, docs } */
export async function fetchTree() {
  return json(await fetch('/api/files/tree'));
}

/**
 * 上传文件。
 * @param {File[]} files
 * @param {{folderId?:string}} options
 * @returns {Promise<{results:Array}>} 逐文件结果（含失败项）
 */
export async function uploadFiles(files, { folderId } = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  if (folderId) fd.append('folderId', folderId);
  return json(await fetch('/api/files/upload', { method: 'POST', body: fd }));
}

/** 文档详情：{ doc, policy, warnings } */
export async function fetchDoc(docId) {
  return json(await fetch(`/api/files/${encodeURIComponent(docId)}`));
}

export async function createFolder(name, parentId) {
  return json(
    await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId: parentId ?? null }),
    }),
  );
}

export async function deleteFolder(folderId) {
  return json(await fetch(`/api/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' }));
}

/** 移动文档 / 改名 */
export async function updateDoc(docId, patch) {
  return json(
    await fetch(`/api/files/${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteDoc(docId) {
  return json(await fetch(`/api/files/${encodeURIComponent(docId)}`, { method: 'DELETE' }));
}

/** 读取某文档的批注（Yjs 更新字节）；没有则返回 null */
export async function fetchComments(docId) {
  const resp = await fetch(`/api/files/${encodeURIComponent(docId)}/comments`);
  if (!resp.ok) return null;
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('json')) return null; // {"ok":true,"empty":true}
  const buf = await resp.arrayBuffer();
  return buf.byteLength ? new Uint8Array(buf) : null;
}

/** 保存某文档的批注（整体状态快照） */
export async function saveComments(docId, bytes) {
  const resp = await fetch(`/api/files/${encodeURIComponent(docId)}/comments`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  return json(resp);
}
