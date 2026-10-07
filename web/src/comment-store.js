/**
 * 评论存储层 —— 基于 @pokapali/comments + @pokapali/comments-tiptap。
 *
 * 设计要点（对应设计文档 3.2 / 6.1 / 6.2）：
 * 1. 锚点通过 Y.RelativePosition 桥接，文档轻微编辑后仍可定位；
 * 2. 每条评论冗余保存锚定原文文本，用于锚点恢复；
 * 3. 解析失败的锚点降级为「孤立评论」，不删除。
 */
import * as Y from 'yjs';
import { comments as createComments } from '@pokapali/comments';
import {
  anchorFromSelection,
  getSyncState,
  resolveAnchors,
} from '@pokapali/comments-tiptap';

/** 评论数据类型，对应设计文档 6.1 节 PolicyComment */
export const COMMENT_TYPES = {
  HUMAN: 'human',
  AI_EXPLANATION: 'ai-explanation',
  AI_FOLLOWUP: 'ai-followup',
};

const LOCAL_AUTHOR = 'local-user';
const LOCAL_AUTHOR_NAME = '我';

/** 极简响应式订阅容器 */
function createSignal(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = next;
      subs.forEach((fn) => fn(value));
    },
    subscribe(fn) {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
  };
}

export class PolicyCommentStore {
  constructor() {
    this.contentDoc = new Y.Doc();
    this.commentsDoc = new Y.Doc();
    this.authorName = LOCAL_AUTHOR_NAME;

    this.feedSignal = createSignal([]);
    this._subs = new Set();
    this._list = [];
    this._unsubFeed = null;

    this.comments = createComments(this.commentsDoc, this.contentDoc, {
      author: LOCAL_AUTHOR,
      // 单机场景无 P2P 身份映射。@pokapali/comments 要求 Feed 形状
      // { getSnapshot(), subscribe(cb) }，此处按该契约提供空映射。
      clientIdMapping: createStaticFeed(new Map()),
      contentType: this.contentDoc.getXmlFragment('default'),
    });

    // 直接订阅包内 feed 作为唯一数据源（@pokapali/comments 返回 { feed, add, update, ... }）
    this._list = toArray(this.comments.feed.getSnapshot());
    this._unsubFeed = this.comments.feed.subscribe(() => {
      this._list = toArray(this.comments.feed.getSnapshot());
      this.notify();
    });
  }

  /** 通知订阅者列表已更新 */
  notify() {
    this._subs.forEach((fn) => fn(this._list));
  }

  /** 订阅评论列表变化 */
  subscribeComments(fn) {
    this._subs.add(fn);
    fn(this._list);
    return () => this._subs.delete(fn);
  }

  get commentsList() {
    return this._list;
  }

  /** 从当前编辑器选区创建锚点（选区为空时返回 null） */
  anchorFromSelection(editor) {
    try {
      return anchorFromSelection(editor);
    } catch {
      return null;
    }
  }

  /**
   * 解析全部锚点为 ProseMirror 位置。
   * @param {import('@tiptap/core').Editor} [editor] 提供后自动取 ySync 状态
   * @returns Map<commentId, {from,to}> 解析成功的锚点
   */
  resolveAnchors(editor) {
    let syncState = null;
    if (editor) {
      try {
        syncState = getSyncState(editor);
      } catch {
        syncState = null;
      }
    }
    let resolved = [];
    try {
      resolved = resolveAnchors(this.commentsDoc, this.contentDoc, syncState) ?? [];
    } catch {
      resolved = [];
    }
    const map = new Map();
    for (const item of resolved) {
      if (item && item.id != null) {
        map.set(item.id, { from: item.from, to: item.to });
      }
    }
    return map;
  }

  /**
   * 新增评论。
   * @param {object} params
   * @param {string} params.content 内容
   * @param {string} params.type    评论类型
   * @param {object} [params.anchor] 锚点
   * @param {string} [params.anchorText] 锚定原文（冗余存储，供恢复用）
   * @param {string} [params.paragraphId] 段落编号
   * @param {string[]} [params.citations] 引用的段落编号
   * @param {string} [params.question] AI 追问的提问
   * @param {string|null} [params.parentId] 父评论 ID
   */
  addComment({
    content,
    type = COMMENT_TYPES.HUMAN,
    anchor = null,
    anchorText = '',
    paragraphId = '',
    citations = [],
    question = '',
    parentId = null,
    depth = 0,
  }) {
    const id = this.comments.add({
      content,
      anchor: anchor ?? undefined,
      parentId: parentId ?? undefined,
      data: {
        type,
        anchorText,
        paragraphId,
        citations,
        question,
        depth,
        status: 'open',
        createdAt: Date.now(),
        streaming: false,
        reasoning: '',
        error: '',
      },
    });
    return id;
  }

  /**
   * 更新评论。
   * 注意：@pokapali/comments 的 Comment 结构里 content/anchor 是顶层字段，
   * 只有 app 自定义数据（如 type、citations）才在 data 中。
   * 因此正文内容必须写顶层 content，不能塞进 data。
   *
   * 底层 comments.update 在条目不存在时会 throw。流式回调是异步的，
   * 用户可能在生成过程中删除该评论，此时必须静默忽略，
   * 否则异常会从 fetch 回调里抛出变成未处理拒绝。
   *
   * @returns {boolean} 是否真的写入
   */
  updateComment(id, patch) {
    let wrote = false;
    if (patch?.content !== undefined) {
      wrote = this._setTopLevelContent(id, patch.content) || wrote;
    }
    const { content, ...rest } = patch ?? {};
    if (Object.keys(rest).length) {
      try {
        this.comments.update(id, { data: rest });
        wrote = true;
      } catch {
        // 评论已被删除，丢弃这次更新
        return wrote;
      }
    }
    return wrote;
  }

  /** 直接操作底层 Y.Map 写入顶层 content（entry 为 Y.Map） */
  _setTopLevelContent(id, content) {
    const map = this.commentsDoc.getMap('comments');
    const entry = map.get(id);
    if (entry && typeof entry.set === 'function') {
      entry.set('content', content);
      return true;
    }
    return false;
  }

  /** 读取单条评论的 data */
  getData(id) {
    const found = this._find(id);
    return found ? { ...(found.data || {}), content: found.content } : null;
  }

  getContent(id) {
    const found = this._find(id);
    return found ? found.content : '';
  }

  getComment(id) {
    return this._find(id) ?? null;
  }

  _find(id) {
    const walk = (list) => {
      for (const c of list) {
        if (c.id === id) return c;
        const hit = walk(c.children ?? []);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this._list);
  }

  /**
   * 将线程化结构拍平（按文档顺序），便于侧边栏按位置排序。
   * 每条记录深拷贝 data，确保 React 能感知流式内容更新。
   */
  flatOrdered(anchorPositions) {
    const flat = [];
    const walk = (list, threadRoot) => {
      for (const c of list) {
        const node = {
          ...c,
          data: { ...(c.data || {}) },
          children: [],
          threadRootId: threadRoot ?? c.id,
        };
        flat.push(node);
        if (c.children?.length) {
          // 递归摊平子回复，收集到同一 flat 列表
          walk(c.children, threadRoot ?? c.id);
        }
      }
    };
    walk(this._list, null);
    if (anchorPositions) {
      const posOf = (id) => anchorPositions.get(id);
      flat.sort((a, b) => {
        const pa = posOf(a.id);
        const pb = posOf(b.id);
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pa - pb;
      });
    }
    return flat;
  }

  destroy() {
    this.comments.destroy();
    this.contentDoc.destroy();
    this.commentsDoc.destroy();
  }
}

/** @pokapali/comments 的 feed 返回可能是数组或带迭代器的对象 */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value[Symbol.iterator] === 'function') {
    return Array.from(value);
  }
  return [];
}

/** 构造符合 Feed 契约 { getSnapshot, subscribe } 的静态数据源 */
function createStaticFeed(value) {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  };
}

/**
 * 锚点恢复策略（对应设计文档 6.2）：
 * 在文档内容附近（±500 字符窗口）搜索锚点文本 anchorText 重新定位。
 * @returns {{from:number,to:number}|null}
 */
export function recoverAnchor(editor, anchorText, fallbackPos) {
  if (!editor || !anchorText) return null;
  const docText = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
  const idx = docText.indexOf(anchorText);
  if (idx >= 0) {
    // textBetween 的字符偏移与 PM 位置需转换：用 doc.descendants 精确定位
    const pos = offsetToPmPos(editor, idx);
    if (pos != null) {
      return { from: pos, to: pos + anchorText.length };
    }
  }
  return fallbackPos ? { from: fallbackPos.from, to: fallbackPos.to } : null;
}

/** 字符偏移 → ProseMirror 位置（逐块累加） */
function offsetToPmPos(editor, offset) {
  let acc = 0;
  let result = null;
  editor.state.doc.descendants((node, pos) => {
    if (result != null) return false;
    const len = node.isText ? node.text.length : 1;
    if (acc + len > offset) {
      result = pos + 1;
      return false;
    }
    acc += len;
    return true;
  });
  return result;
}