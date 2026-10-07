/**
 * SSE 客户端：把 /api/ai/stream 的 data: 帧还原成回调。
 * 与 server/index.js 的事件契约一一对应：
 *   {phase:'start', depth} → onStart
 *   {step:{...}}           → onStep   （步骤时间线增量，按 key upsert）
 *   {reset:true}           → onReset  （清空正文缓冲）
 *   {r:'...'}              → onReasoning
 *   {t:'...'}              → onText
 *   {done:true, ...}       → onDone
 *   {error:'...'}          → onError
 */

const ENDPOINT = '/api/ai/stream';

export function streamExplain(body, handlers = {}) {
  const { onText, onReasoning, onStart, onDone, onError, onStep, onReset } = handlers;

  const controller = new AbortController();

  // 页面切换 / 组件卸载时中断，避免后台继续消费 token
  if (typeof handlers.onAbort === 'function') handlers.onAbort(controller);

  (async () => {
    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        // 校验类错误（4xx）返回 JSON，其余按文本处理
        let msg = `请求失败（${resp.status}）`;
        try {
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const j = await resp.json();
            if (j?.error) msg = j.error;
          } else {
            const t = await resp.text();
            if (t) msg = t.slice(0, 200);
          }
        } catch {
          /* 保留默认文案 */
        }
        throw new Error(msg);
      }

      if (!resp.body) throw new Error('浏览器不支持流式响应');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // 服务端是否已经显式发过 done 帧。读取循环结束后要据此决定是否兜底收尾。
      let sawDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            let evt;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }

            if (evt.phase === 'start') {
              onStart?.(evt);
            } else if (evt.step) {
              onStep?.(evt.step);
            } else if (evt.reset) {
              onReset?.();
            } else if (typeof evt.r === 'string' && evt.r) {
              onReasoning?.(evt.r);
            } else if (typeof evt.t === 'string' && evt.t) {
              onText?.(evt.t);
            } else if (evt.error) {
              throw new Error(evt.detail ? `${evt.error}：${evt.detail}` : evt.error);
            } else if (evt.done) {
              sawDone = true;
              onDone?.(evt);
            }
          }
        }
      }

      // 服务端未显式发 done（例如连接被截断）时兜底收尾。
      //
      // 必须判断 sawDone：服务端是「先发 done 帧、再 res.end()」，
      // 所以读取循环走完是**正常结束**，done 帧已经回调过一次。
      // 若无条件再调一次兜底，就会用 {truncated:true} 覆盖掉刚拿到的权威快照，
      // 导致 sources / searched / elapsedMs / steps 全部被清空
      // （症状：「来源」清单永远不显示、摘要里的「检索 M 次」和耗时永远是 0）。
      if (!sawDone) onDone?.({ done: true, truncated: true });
    } catch (err) {
      if (err?.name === 'AbortError') return; // 用户主动中断，静默
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return () => controller.abort();
}

/** 开关与限额读取，供设置面板使用 */
export async function fetchSettings() {
  const resp = await fetch('/api/settings');
  if (!resp.ok) throw new Error(`读取设置失败（${resp.status}）`);
  return resp.json();
}

export async function saveSettings(patch) {
  const resp = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`保存设置失败（${resp.status}）`);
  return resp.json();
}
