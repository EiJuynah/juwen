import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { CommentHighlight, PendingAnchorHighlight, setPendingAnchorDecoration, clearPendingAnchorDecoration, rebuildCommentDecorations } from '@pokapali/comments-tiptap';
import { marked } from 'marked';
import { PolicyCommentStore, COMMENT_TYPES } from './comment-store.js';
import { streamExplain, fetchSettings, saveSettings } from './sse.js';
import LibraryPane from './LibraryPane.jsx';
import {
  fetchTree,
  fetchDoc,
  fetchComments,
  saveComments,
} from './files-api.js';
marked.setOptions({ gfm: true, breaks: true });

const MAX_DEPTH = 6;

/**
 * 开屏的空文档。
 *
 * 早先这里预置内置示例文本，导致每次打开都先看到一篇并不存在的文稿，
 * 既容易与真实文档混淆，也让「有没有打开文档」这件事看不出来。
 * 现在开屏留空，正文由使用者从左侧文档库自行载入。
 */
const EMPTY_POLICY = { title: '', meta: '', sections: [] };

/**
 * 面板收起状态的读写。
 * localStorage 在隐私模式下可能抛错（或不存在），
 * 因此一律包一层，失败时退化为「不记忆」，不影响收起本身。
 */
function readCollapsed(which) {
  try {
    return localStorage.getItem(`freadtool.${which}Collapsed`) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(which, value) {
  try {
    localStorage.setItem(`freadtool.${which}Collapsed`, value ? '1' : '0');
  } catch {
    /* 仅影响记忆，不影响功能 */
  }
}

/** 通用的「已关闭」标记读写（用于可关闭的提示条） */
function readFlag(name) {
  try {
    return localStorage.getItem(`freadtool.${name}`) === '1';
  } catch {
    return false;
  }
}

function writeFlag(name, value) {
  try {
    localStorage.setItem(`freadtool.${name}`, value ? '1' : '0');
  } catch {
    /* 仅影响记忆，不影响功能 */
  }
}

/**
 * 解析当前档位（'explain' | 'strict'）。
 *
 * 两档枚举只有服务端是唯一真源；这里做一次旧值兼容：
 * 只有 `profile` 字段**缺失**时才回头看旧的 `constraints` 布尔值
 * （`constraints === true` → 严格依据）。这样刷新时既读得到服务端的
 * 新值，也不会让升级过程中还没返回 profile 的响应把界面打回默认档。
 */
function readProfile(settings) {
  const p = settings?.profile;
  if (p === 'explain' || p === 'strict') return p;
  if (settings?.profile == null && settings?.constraints === true) return 'strict';
  return 'explain';
}

/** 推理强度的中文标签（下拉里不直接暴露英文枚举值） */
const EFFORT_LABEL = {
  off: '关闭（最快出字）',
  low: '低',
  medium: '中',
  high: '高（推理更充分，更慢）',
};

/**
 * 全局段落属性扩展：保留条款段落的 ID（data-pid）。
 * AI 解释中的 [P-x] 引用依赖它做回查定位。
 */
const ParagraphAttrs = Extension.create({
  name: 'paragraphAttrs',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          pid: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-pid'),
            renderHTML: (attrs) =>
              attrs.pid ? { 'data-pid': attrs.pid } : {},
          },
          clause: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-clause'),
            renderHTML: (attrs) =>
              attrs.clause ? { 'data-clause': attrs.clause } : {},
          },
        },
      },
    ];
  },
});

export default function App() {
  // ---------- 文档库 ----------
  const [tree, setTree] = useState({ folders: [], docs: [] });
  // 当前文档。null 表示尚未打开任何文档（开屏空态）
  const [currentDoc, setCurrentDoc] = useState(null);
  const [policy, setPolicy] = useState(EMPTY_POLICY);
  const [docWarnings, setDocWarnings] = useState([]);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [notice, setNotice] = useState('');
  // 文档库收起状态。持久化到 localStorage，刷新后保持；
  // 收起后仍保留一条窄边条，避免用户找不到入口
  const [libCollapsed, setLibCollapsed] = useState(() => readCollapsed('lib'));
  const toggleLib = useCallback(() => {
    setLibCollapsed((prev) => {
      const next = !prev;
      writeCollapsed('lib', next);
      return next;
    });
  }, []);

  // 右侧批注栏收起状态，同样持久化
  const [sideCollapsed, setSideCollapsed] = useState(() => readCollapsed('side'));
  const toggleSide = useCallback(() => {
    setSideCollapsed((prev) => {
      const next = !prev;
      writeCollapsed('side', next);
      return next;
    });
  }, []);

  // 操作提示条可关闭；关掉后不再出现（记住选择）
  const [hintClosed, setHintClosed] = useState(() => readFlag('hintClosed'));
  const closeHint = useCallback(() => {
    setHintClosed(true);
    writeFlag('hintClosed', true);
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      const t = await fetchTree();
      // 规范化：接口异常或返回空对象时也要保证形状可用，
      // 否则 LibraryPane 里 tree.folders.map 会炸
      setTree({ folders: t?.folders ?? [], docs: t?.docs ?? [] });
    } catch (err) {
      setNotice(String(err.message || err));
    }
  }, []);

  useEffect(() => {
    refreshTree();
  }, [refreshTree]);

  /**
   * 切换文档。
   *
   * 批注按文档独立存放，因此换文档必须换一整套 Y.Doc ——
   * 通过 docKey 触发 store 与 editor 重建（见下方 useEditor 的 deps）。
   */
  const openDoc = useCallback(
    async (docId) => {
      if (!docId) return;
      setLoadingDoc(true);
      try {
        const detail = await fetchDoc(docId);
        setCurrentDoc(detail.doc);
        setPolicy(
          detail.policy && detail.policy.sections?.length
            ? detail.policy
            : { title: detail.doc?.title ?? detail.doc?.name ?? '未命名', meta: '', sections: [] },
        );
        setDocWarnings(detail.warnings ?? []);
        if (detail.doc?.supported === false) {
          setNotice(detail.doc.reason || '该文件无法解析');
        }
      } catch (err) {
        setNotice(String(err.message || err));
      } finally {
        setLoadingDoc(false);
      }
    },
    [],
  );

  /**
   * store 随文档重建。
   * 注意顺序：必须先销毁旧 store 再建新的，
   * 否则旧 Y.Doc 的 observer 会继续推事件到已卸载的组件。
   */
  const docKey = currentDoc?.id ?? '__blank__';
  const storeRef = useRef(null);
  const storeKeyRef = useRef(null);
  if (storeKeyRef.current !== docKey) {
    storeRef.current?.destroy();
    storeRef.current = new PolicyCommentStore();
    storeKeyRef.current = docKey;
  }
  const store = storeRef.current;

  const [comments, setComments] = useState([]);
  const [anchorPositions, setAnchorPositions] = useState(new Map());
  const [pending, setPending] = useState(null); // {from,to,text}
  const [popover, setPopover] = useState(null); // 浮动按钮位置 {x,y}
  const [selectedId, setSelectedId] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [askDraft, setAskDraft] = useState({ open: false, text: '' });
  // 用 ref 同步提问框的最新输入，避免受控组件闭包读取到过期 state
  const askRef = useRef('');
  const [activeId, setActiveId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [showOrphans, setShowOrphans] = useState(true);
  /**
   * 「全部收起 / 全部展开」广播信号。
   * 卡片自己的折叠态仍然是卡片内的 state（每条独立、默认值见 CommentCard：
   * 流式中挂载展开、已完成收起），这里只发一个递增序号让所有卡片响应一次，
   * seq === 0 表示还没点过，卡片保持各自的默认值。
   */
  const [collapseSignal, setCollapseSignal] = useState({ seq: 0, to: 'collapsed' });
  const [docReady, setDocReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 服务端设置。界面按服务端实际生效值展示，避免出现「显示已关闭、实际还开着」
  const [settings, setSettings] = useState({
    enabled: true,
    // 默认档：讲透。旧版本这里是 constraints 布尔值，访问时用 readProfile 兼容。
    profile: 'explain',
    // 档位文案只从服务端取，前端不硬编码备用文案（契约 §3）
    profileOptions: [],
    model: '',
    effort: 'low',
    effortLevels: ['off', 'low', 'medium', 'high'],
    limits: null,
    // 联网检索：能力是否具备由服务端决定，是否启用由用户决定
    searchEnabled: false,
    searchAvailable: false,
    searchInfo: null,
  });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');

  // 启动时同步服务端设置
  useEffect(() => {
    fetchSettings()
      .then((s) => {
        if (s) setSettings((prev) => ({ ...prev, ...s }));
      })
      .catch(() => {
        /* 读不到就沿用默认值，不阻塞界面 */
      });
  }, []);

  const profile = readProfile(settings);
  const aiEnabled = settings.enabled !== false;
  // 联网是否真正生效：三个条件同时满足（服务端具备能力 + 用户打开 + 非严格依据档）
  const searchLive =
    settings.searchEnabled === true && settings.searchAvailable === true && profile !== 'strict';

  /**
   * 保存设置。先乐观更新本地（点了立刻有反馈），失败再回滚并用服务端返回值纠正，
   * 避免出现「界面显示已关闭、服务端其实还开着」的不一致。
   */
  const updateSettings = useCallback(
    async (patch) => {
      const prev = settings;
      setSettings((s) => ({ ...s, ...patch }));
      setSettingsSaving(true);
      setSettingsError('');
      try {
        const saved = await saveSettings(patch);
        if (saved) setSettings((s) => ({ ...s, ...saved }));
      } catch (err) {
        setSettings(prev);
        setSettingsError(String(err.message || err));
      } finally {
        setSettingsSaving(false);
      }
    },
    [settings],
  );

  // ---------- 构建 Tiptap：原文只读 + Decoration 标注 ----------
  // Collaboration 扩展挂载 ySync 插件，这是 anchorFromSelection 能够
  // 把选区转成 Y.RelativePosition 的前提（对应设计文档 3.2 节）。
  //
  // deps 传 [store]：切文档时 store 会换成新的 Y.Doc，
  // 编辑器必须跟着重建，否则会继续往旧文档的 Y.Doc 里写。
  const editor = useEditor(
    {
      editable: false, // 原文只读，标注全部走 Decoration
      extensions: [
        // 保留 heading 与段落属性扩展：原文的章节标题、条款段落 ID
        // 都依赖它们（data-pid 用于 AI 引用回查）。
        StarterKit.configure({ codeBlock: false, history: false }),
        ParagraphAttrs,
        Collaboration.configure({ document: store.contentDoc }),
        CommentHighlight.configure({
          commentsDoc: store.commentsDoc,
          contentDoc: store.contentDoc,
          activeCommentId: null,
        }),
        PendingAnchorHighlight,
      ],
    },
    [store],
  );

  // 初始化当前文档正文到 Y.Doc（ySync 会自动把初始内容同步进 contentDoc）。
  // 每换一次文档，editor 会重建、docReady 需重置，因此依赖里带上 editor。
  useEffect(() => {
    if (!editor) return;
    if (editor.state.doc.content.size <= 2) {
      editor.commands.setContent(buildPolicyHtml(policy));
    }
    setDocReady(true);
  }, [editor, policy]);

  // 载入当前文档已保存的批注。
  // 批注存在服务端的 Yjs 更新里，这里合并进来后再刷新列表。
  useEffect(() => {
    let cancelled = false;
    if (!currentDoc?.id) return undefined;
    (async () => {
      try {
        const bytes = await fetchComments(currentDoc.id);
        if (cancelled || !bytes) return;
        Y.applyUpdate(store.commentsDoc, bytes, 'remote-load');
      } catch {
        /* 批注读不到不影响阅读正文 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDoc?.id, store]);

  // 批注变化时回写服务端（防抖：流式生成期间会高频触发）
  useEffect(() => {
    if (!currentDoc?.id) return undefined;
    let timer = null;
    const dirty = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const bytes = Y.encodeStateAsUpdate(store.commentsDoc);
          await saveComments(currentDoc.id, bytes);
        } catch {
          /* 保存失败不打断使用；下次变更会再试 */
        }
      }, 800);
    };
    const unsub = store.subscribeComments(dirty);
    return () => {
      if (timer) clearTimeout(timer);
      unsub?.();
    };
  }, [currentDoc?.id, store]);

  // 同步激活项到 CommentHighlight。
  // useEditor 只在首次渲染创建编辑器，扩展 options 里的 activeCommentId
  // 会被永久冻结在 null；这里直接改写 options 再重建装饰，
  // 否则点击批注卡片时原文高亮不会跟着切换。
  useEffect(() => {
    if (!editor) return;
    const ext = editor.extensionManager.extensions.find(
      (e) => e.name === 'commentHighlight',
    );
    if (!ext) return;
    ext.options.activeCommentId = activeId;
    try {
      rebuildCommentDecorations(editor.view);
    } catch {
      /* 装饰重建失败不影响评论数据 */
    }
  }, [editor, activeId]);

  // 开发态调试钩子：便于在浏览器控制台/自动化中检查锚点解析状态
  useEffect(() => {
    if (import.meta.env.DEV && editor) {
      window.__policyDebug = { editor, store };
    }
  }, [editor, store]);

  // ---------- 刷新评论列表 ----------
  const refresh = useCallback(() => {
    const positions = store.resolveAnchors(editor);
    setAnchorPositions(positions);
    setComments(store.flatOrdered(positions));
    // 评论存于 Y.Doc，不触发 PM 的 docChanged，需显式派发事务重建 Decoration
    if (editor) {
      try {
        rebuildCommentDecorations(editor.view);
      } catch {
        /* 装饰重建失败不影响评论数据 */
      }
    }
  }, [store, editor]);

  // ---------- 订阅评论 ----------
  useEffect(() => {
    return store.subscribeComments(() => {
      refresh();
    });
  }, [store, refresh]);

  // 高亮装饰在文档变化后重建
  useEffect(() => {
    if (!editor) return;
    refresh();
    const rebuild = () => refresh();
    editor.on('transaction', rebuild);
    return () => editor.off('transaction', rebuild);
  }, [editor, refresh]);

  // ---------- 选区监听 ----------
  useEffect(() => {
    if (!editor) return;
    const onSelection = () => {
      const { from, to, empty } = editor.state.selection;
      if (empty || to - from < 2) {
        setPending(null);
        setPopover(null);
        setDialogOpen(false);
        return;
      }
      const text = editor.state.doc.textBetween(from, to, '\n', ' ').trim();
      if (!text) return;
      setPending({ from, to, text });
      // 浮动条贴在选区右上角，不遮挡正文
      const startCoords = editor.view.coordsAtPos(from);
      const endCoords = editor.view.coordsAtPos(to);
      const above = startCoords.top > 84;
      setPopover({
        x: Math.max(endCoords.right - 20, startCoords.left),
        y: above ? startCoords.top - 48 : endCoords.bottom + 10,
        placement: above ? 'top' : 'bottom',
      });
      // 待建锚点高亮：跟随选区（对应设计文档 3.2 节 PendingAnchorHighlight）
      const a = store.anchorFromSelection(editor);
      if (a) {
        try {
          setPendingAnchorDecoration(editor.view, a);
        } catch {
          /* 高亮失败不影响主流程 */
        }
      }
    };
    editor.on('selectionUpdate', onSelection);
    return () => editor.off('selectionUpdate', onSelection);
  }, [editor, store]);

  /** 清除待建锚点高亮 */
  const clearPendingMark = useCallback(() => {
    if (editor) {
      try {
        clearPendingAnchorDecoration(editor.view);
      } catch {
        /* 忽略 */
      }
    }
    setPending(null);
    setPopover(null);
  }, [editor]);

  // 段落编号：选区所属段落的 ID
  const currentParagraphId = useMemo(() => {
    if (!editor || !pending) return '';
    return findParagraphId(editor.state.doc, pending.from);
  }, [editor, pending]);

  const currentParagraphText = useMemo(() => {
    if (!editor || !pending) return '';
    return paragraphTextAt(editor.state.doc, pending.from);
  }, [editor, pending]);

  // ---------- 交互 ----------
  const openCommentBox = () => {
    setPopover(null);
    setActiveId(null);
    setDialogOpen(true);
  };

  const askAI = (question) => {
    if (!pending) return;
    setPopover(null);
    const anchor = store.anchorFromSelection(editor);
    const id = store.addComment({
      content: '',
      type: COMMENT_TYPES.AI_EXPLANATION,
      anchor,
      anchorText: pending.text,
      paragraphId: currentParagraphId,
      question,
      depth: 0,
    });
    clearPendingMark();
    setActiveId(id);
    setSelectedId(id);
    runExplain(id, {
      text: pending.text,
      paragraphText: currentParagraphText,
      paragraphId: currentParagraphId,
      question,
      maxDepth: 0,
    });
  };

    /** 点击「问 AI」后展开内联提问框（比 window.prompt 更易用、可留空） */
  const startAskAI = () => {
    if (!pending) return;
    setPopover(null);
    askRef.current = '';
    setAskDraft({ open: true, text: '' });
  };

  const submitAskAI = () => {
    const q = (askRef.current ?? askDraft.text).trim();
    setAskDraft({ open: false, text: '' });
    askRef.current = '';
    askAI(q);
  };

  /**
   * 流式解释：逐帧追加。
   * 深seek-flash 帧率很高，逐帧写 Y.Doc 会造成事务风暴、
   * React 重渲染滞后，因此本地缓冲后按帧数/时间节流提交。
   */
  const runExplain = (commentId, body) => {
    store.updateComment(commentId, {
      streaming: true,
      content: '',
      error: '',
      steps: [],
      sources: [],
      elapsedMs: 0,
      searched: 0,
    });
    // 本地累计完整文本，避免高频写入 Y.Doc 造成事务风暴
    let accText = '';
    let accReason = '';
    let pendingText = '';
    let lastFlush = Date.now();
    let frame = 0;

    /**
     * 步骤时间线。服务端按 key 增量推送（同一步骤会推 running → done 两次），
     * 这里按 key 就地合并并保持首次出现的顺序。
     * 步骤变更频率很低（一次解释几到十几条），不需要像正文那样节流。
     */
    let steps = [];
    const upsertStep = (s) => {
      if (!s?.key) return;
      const i = steps.findIndex((x) => x.key === s.key);
      steps = i >= 0 ? steps.map((x, k) => (k === i ? { ...x, ...s } : x)) : [...steps, s];
      store.updateComment(commentId, { steps });
    };

    const flush = () => {
      const patch = {};
      if (accText) patch.content = accText;           // updateComment 为合并语义，传累计值
      if (accReason) patch.reasoning = accReason;
      if (Object.keys(patch).length) store.updateComment(commentId, patch);
      pendingText = '';
      lastFlush = Date.now();
      // 必须重置：否则 frame 一旦越过 8 就永久命中阈值，
      // 后续每个 token 都会写一次 Y.Doc，节流形同虚设
      frame = 0;
    };

    // 带上 docId：服务端用它把每次解释归到具体文档，便于溯源。
    // 未从库里打开文档时不带 docId，服务端在库为空时放行。
    streamExplain(currentDoc?.id ? { ...body, docId: currentDoc.id } : body, {
      onStep: upsertStep,
      // 过渡轮那句「我先查一下…」不该留在正文里，清空缓冲重来
      onReset: () => {
        accText = '';
        pendingText = '';
        store.updateComment(commentId, { content: '' });
      },
      onText: (delta) => {
        accText += delta;
        pendingText += delta;
        frame++;
        if (frame >= 8 || Date.now() - lastFlush > 200) flush();
      },
      onReasoning: (delta) => {
        accReason += delta;
      },
      onDone: (info) => {
        flush();
        // 兜底：模型可能把 max_tokens 全花在 reasoning 上、可见答案为空，
        // 此时若不提示，卡片会一直空白，看起来像功能坏了。
        const noAnswer = !accText.trim();
        // done 里带的 steps 是服务端的权威版本：万一某个 step 事件丢帧，
        // 时间线也不会残缺
        const finalSteps = Array.isArray(info?.steps) && info.steps.length ? info.steps : steps;
        store.updateComment(commentId, {
          streaming: false,
          steps: finalSteps,
          sources: Array.isArray(info?.sources) ? info.sources : [],
          elapsedMs: info?.elapsedMs || 0,
          searched: info?.searched || 0,
          citations: extractCitations(accText),
          reasoningChars: info?.reasoningChars,
          error: noAnswer
            ? '模型本次只输出了推理过程，未给出可见答案，请重试或缩小选区'
            : '',
        });
      },
      onError: (err) => {
        flush();
        store.updateComment(commentId, {
          streaming: false,
          steps, // 保留已完成的步骤，便于定位卡在哪一步
          error: String(err.message || err),
        });
      },
    });
  };

  /** 递归追问：针对已有 AI 评论继续提问 */
  const followUp = (parentId, question) => {
    const parent = store.getComment(parentId);
    if (!parent) return;
    const data = parent.data ?? {};
    const depth = (data.depth ?? 0) + 1;
    if (depth > MAX_DEPTH) return;
    // @pokapali/comments 只支持一层线程（对回复再回复会直接 throw
    // "Cannot reply to a reply"）。因此 2 层及以后的追问一律挂到
    // 线程根节点下，层级只由 data.depth 表达 —— 侧边栏缩进与
    // MAX_DEPTH 限制都按 depth 计算，观感与真嵌套一致。
    const threadRootId = parent.parentId ?? parentId;
    const id = store.addComment({
      content: '',
      type: COMMENT_TYPES.AI_FOLLOWUP,
      parentId: threadRootId,
      paragraphId: data.paragraphId || '',
      // 追问沿用被引用的那段原文（数据完整性）；卡片上只在 depth === 0 展示，
      // 免得追问把同一段引用反复刷屏
      anchorText: data.anchorText || '',
      question,
      depth,
    });
    setActiveId(id);
    setSelectedId(id);
    runExplain(id, {
      text: data.anchorText || '',
      paragraphText: '',
      paragraphId: data.paragraphId || '',
      question,
      maxDepth: depth - 1,
      parentAnswer: parent.content || '',
    });
  };

  const addHumanComment = (anchorInfo, content) => {
    // 先建锚点（依赖当前选区），再清除高亮
    const anchor = store.anchorFromSelection(editor);
    const id = store.addComment({
      content,
      type: COMMENT_TYPES.HUMAN,
      anchor,
      anchorText: anchorInfo?.text || '',
      paragraphId: anchorInfo?.paragraphId || '',
    });
    clearPendingMark();
    setSelectedId(id);
    setActiveId(id);
  };

  /**
   * 深入删除：连同整棵追问子树一起删。
   * 注意 store.getComment() 返回的是底层**树节点**（带 children）；
   * 侧边栏里的 comment 是 flatOrdered() 拍平后的对象，children 恒为空数组，
   * 所以这里必须回 store 取原树，不能拿页面上的 comment.children 去数。
   */
  const collectSubtreeIds = (id) => {
    const ids = [id];
    const walk = (list) => {
      for (const child of list ?? []) {
        ids.push(child.id);
        walk(child.children);
      }
    };
    walk(store.getComment(id)?.children);
    return ids;
  };

  const countDescendants = (id) => collectSubtreeIds(id).length - 1;

  const removeComment = (id) => {
    const ids = collectSubtreeIds(id);
    for (const x of ids) store.comments.delete(x);
    const removed = new Set(ids);
    if (selectedId != null && removed.has(selectedId)) setSelectedId(null);
    if (activeId != null && removed.has(activeId)) setActiveId(null);
  };

  const jumpToParagraph = (pid) => {
    if (!editor || !pid) return;

    // 中文条号（第二条 / 第三章）→ 先在正文里找以它开头的段落
    const cnMatch = /^第[\d一二三四五六七八九十百零]+[条章节]$/.exec(pid);
    let found = null;
    if (cnMatch) {
      editor.state.doc.descendants((node, pos) => {
        if (found != null) return false;
        if (node.textContent?.trim().startsWith(pid)) {
          found = pos;
          return false;
        }
        return true;
      });
    }

    // 段落 ID：按 data-pid 属性匹配
    // （buildPolicyHtml 只把 pid 写在 <p> 上，<h2> 里没有，不能按标题文本找）
    if (found == null && !cnMatch) {
      editor.state.doc.descendants((node, pos) => {
        if (found != null) return false;
        if (node.attrs?.pid === pid) {
          found = pos;
          return false;
        }
        return true;
      });
    }

    if (found == null) {
      // 兜底：按条款原文做文本搜索
      const text = findClauseText(pid, policy);
      if (text) found = findTextPos(editor, text);
    }
    if (found == null) return;

    editor.commands.focus();
    // 落在段首，避免把选区推进段落内部导致滚动位置偏掉
    editor.commands.setTextSelection({ from: found + 1, to: found + 1 });
    scrollPosIntoView(editor, found);
  };

  const setActiveByParagraph = (pid) => {
    const hit = comments.find((c) => c.data?.paragraphId === pid);
    if (hit) {
      setActiveId(hit.threadRootId ?? hit.id);
      setSelectedId(hit.id);
    }
  };

  if (!editor) {
    return <div className="boot">正在载入文稿…</div>;
  }

  // 「标记解决」已被移除：`data.status` 字段保留但**不再读取**——
  // 历史批注里可能还留着 resolved，删掉控件后它们必须照常完整显示（不迁移、不隐藏、不划掉）。
  const visible = comments.filter((c) => {
    if (!c.anchor && !showOrphans) return false;
    if (filter === 'ai' && c.data?.type === COMMENT_TYPES.HUMAN) return false;
    if (filter === 'human' && c.data?.type !== COMMENT_TYPES.HUMAN) return false;
    return true;
  });

  // 「全部收起 / 全部展开」：按钮文案反映点击后会发生什么（seq === 0 时卡片还是各自默认值）
  const allCollapsed = collapseSignal.seq > 0 && collapseSignal.to === 'collapsed';
  const toggleAllCollapse = () => {
    setCollapseSignal((s) => ({
      seq: s.seq + 1,
      // 第一次点一律是「收起」，之后按上一次的方向交替
      to: s.seq > 0 && s.to === 'collapsed' ? 'expanded' : 'collapsed',
    }));
  };

  const orphanCount = comments.filter((c) => !c.anchor).length;

  // 是否已载入可阅读的文档。开屏为空态时整个 doc-head 不渲染，
  // 免得出现「未命名文档」这种没意义的占位标题。
  const hasDoc = Boolean(currentDoc) || (policy?.sections?.length ?? 0) > 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1 className="brand-name">智能解读工作台</h1>
          <span className="brand-sub">AI 智能体 · 划词批注 · 溯源解读</span>
        </div>
        <div className="topbar-meta">
          <span className="chip">DeepSeek-V4.1-Flash</span>
          {/* 联网状态只在真正生效时露出来，避免「显示了但其实不生效」的误导 */}
          {searchLive && (
            <span className="chip net-chip" title="联网检索已开启：AI 会检索权威政务网站并在答案中标出来源">
              联网检索
            </span>
          )}
          {/* 当前档位摘要：一眼能看出 AI 是按哪一档讲解的，悬停有完整说明 */}
          <span
            className={`chip mode-chip ${profile === 'strict' ? 'strict' : 'explain'}`}
            title={
              profile === 'strict'
                ? '严格依据：AI 只引用本文件原文作答，逐条标注依据段落，不编造原文之外的内容'
                : searchLive
                  ? '讲透 + 联网检索：AI 会把话讲透，并检索权威政务网站补充背景、标出来源；补充内容非原文，仅供理解参考'
                  : '讲透：AI 会把话讲透，术语当场讲清、可补背景，原文之外的补充会标注出来；不联网查证，可能过时'
            }
          >
            {profile === 'strict' ? '严格依据' : '讲透'}
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSettingsOpen(true)}
            title="设置"
            aria-label="设置"
          >
            ⚙ 设置
          </button>
        </div>
      </header>

      <div className={`layout ${libCollapsed ? 'lib-collapsed' : ''} ${sideCollapsed ? 'side-collapsed' : ''}`.trim()}>
        {libCollapsed ? (
          <button
            type="button"
            className="lib-rail"
            onClick={toggleLib}
            title="展开文档库"
            aria-label="展开文档库"
          >
            <span className="rail-caret">»</span>
            <span className="rail-text">文档库</span>
            {tree.docs.length > 0 && <span className="rail-count">{tree.docs.length}</span>}
          </button>
        ) : (
          <LibraryPane
            tree={tree}
            currentDocId={currentDoc?.id ?? null}
            onRefresh={refreshTree}
            onOpenDoc={openDoc}
            onError={setNotice}
            busy={loadingDoc}
            onCollapse={toggleLib}
          />
        )}

        <main className="doc-pane">
          {hasDoc && (
            <div className="doc-head">
              <h2>
                {policy.title || currentDoc?.name || '未命名文档'}
              </h2>
              {docWarnings.length > 0 && (
                <div className="doc-warn">
                  {docWarnings.map((w) => (
                    <div key={w}>⚠ {w}</div>
                  ))}
                </div>
              )}
              {notice && (
                <div className="doc-notice" onClick={() => setNotice('')}>
                  {notice}
                  <span className="notice-close">×</span>
                </div>
              )}
              {!hintClosed && (
                <div className={`doc-hint ${profile === 'explain' ? 'explain' : ''}`}>
                  <span className="hint-icon">✎</span>
                  <span className="hint-text">
                    {profile === 'strict'
                      ? '选中原文任意文字即可添加批注或向 AI 提问；当前为「严格依据」档，AI 只依据本文件原文作答，逐条标出依据段落，不引入原文之外的内容。'
                      : searchLive
                        ? '选中原文任意文字即可添加批注或向 AI 提问；当前为「讲透」档且已开启联网检索，AI 会把话讲透、术语当场讲清，并检索权威政务网站补充背景、标出来源。补充内容非原文，仅供理解参考。'
                        : '选中原文任意文字即可添加批注或向 AI 提问；当前为「讲透」档，AI 会把话讲透、术语当场讲清、可补背景，原文之外的补充一律标注出来；未联网查证，可能过时，仅供理解参考。'}
                  </span>
                  <button
                    className="hint-close"
                    onClick={closeHint}
                    title="不再显示"
                    aria-label="关闭提示"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 未打开文档时没有标题区，但载入失败的提示仍需有地方显示 */}
          {!hasDoc && notice && (
            <div className="doc-head">
              <div className="doc-notice" onClick={() => setNotice('')}>
                {notice}
                <span className="notice-close">×</span>
              </div>
            </div>
          )}

          <div
            className={`editor-wrap ${hasDoc ? '' : 'blank'}`.trim()}
            onClick={() => setActiveId(null)}
          >
            {editor && <EditorContent editor={editor} />}
            {!hasDoc && !loadingDoc && (
              <div className="doc-blank">
                <p>还没有打开文档</p>
                <span>从左侧「文档库」上传或选择一份文件，即可划词批注、向 AI 提问</span>
              </div>
            )}
            {loadingDoc && <div className="doc-loading">正在载入文档…</div>}
          </div>
        </main>

        {sideCollapsed ? (
          <button
            type="button"
            className="side-rail"
            onClick={toggleSide}
            title="展开批注栏"
            aria-label="展开批注栏"
          >
            <span className="rail-caret">«</span>
            <span className="rail-text">批注与解读</span>
            {visible.length > 0 && <span className="rail-count">{visible.length}</span>}
          </button>
        ) : (
        <aside className="side-pane">
          <div className="side-head">
            <div className="side-title">
              批注与解读
              <span className="count">{visible.length}</span>
              <button
                className="side-collapse"
                onClick={toggleSide}
                title="收起批注栏"
                aria-label="收起批注栏"
              >
                »
              </button>
            </div>
            <div className="filters">
              {[
                ['all', '全部', '显示全部条目：人工批注 + AI 解释 + 追问'],
                ['ai', 'AI 解释', '只看 AI 生成的解释与追问'],
                ['human', '人工批注', '只看自己手动添加的批注'],
              ].map(([k, label, tip]) => (
                <button
                  key={k}
                  className={`filter ${filter === k ? 'on' : ''}`}
                  onClick={() => setFilter(k)}
                  title={tip}
                  aria-label={tip}
                >
                  {label}
                </button>
              ))}
              {/* 至少有一条可见卡片时才出现；点一下把右栏全部收起（问题多时先扫标题） */}
              {visible.length > 0 && (
                <button
                  type="button"
                  className="collapse-all"
                  onClick={toggleAllCollapse}
                  title={allCollapsed ? '展开全部卡片' : '收起全部卡片'}
                >
                  {allCollapsed ? '全部展开' : '全部收起'}
                </button>
              )}
            </div>
          </div>

          {orphanCount > 0 && (
            <label className="orphan-toggle">
              <input
                type="checkbox"
                checked={showOrphans}
                onChange={(e) => setShowOrphans(e.target.checked)}
              />
              显示孤立批注（{orphanCount}）
            </label>
          )}

          <div className="comment-list">
            {visible.length === 0 && (
              <div className="empty">
                <div className="empty-icon">✎</div>
                <p>还没有批注</p>
                <span>在左侧选中原文，即可开始</span>
                <div className="empty-hint">
                  <b>可以这样用：</b>
                  <br />· 选中条款文字 → 添加批注，记下你的理解
                  <br />· 选中条款文字 → 问 AI，逐句拆解条款含义
                  <br />· 对 AI 解释继续追问，最多 6 层
                  <br />· 点击解释下方的依据编号，可回查原文
                </div>
              </div>
            )}

            {visible.map((c) => (
              <CommentCard
                key={c.id}
                comment={c}
                selected={selectedId === c.id}
                active={activeId === (c.threadRootId ?? c.id)}
                onSelect={() => {
                  setSelectedId(c.id);
                  setActiveId(c.threadRootId ?? c.id);
                }}
                onDelete={() => removeComment(c.id)}
                descendantCount={countDescendants(c.id)}
                collapseSignal={collapseSignal}
                onJump={jumpToParagraph}
                onFollowUp={(q) => followUp(c.id, q)}
                depth={c.data?.depth ?? 0}
              />
            ))}
          </div>
        </aside>
        )}
      </div>

      {popover && (
        <div
          className={`popover ${popover.placement === 'bottom' ? 'below' : ''}`}
          style={{
            left: Math.max(12, Math.min(popover.x - 20, window.innerWidth - 340)),
            top: popover.y,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button className="popover-btn" onClick={openCommentBox}>
            <span className="pi pi-comment" /> 添加批注
          </button>
          <button
            className="popover-btn primary"
            onClick={startAskAI}
          >
            <span className="pi pi-spark" /> 问 AI
          </button>
          <div className="popover-hint">
            段落 <b>{currentParagraphId || '—'}</b> · {pending?.text?.slice(0, 18)}…
          </div>
        </div>
      )}

      {askDraft.open && pending && (
        <AskDialog
          anchorText={pending.text}
          paragraphId={currentParagraphId}
          value={askDraft.text}
          onChange={(t) => {
            askRef.current = t;
            setAskDraft({ open: true, text: t });
          }}
          onCancel={() => setAskDraft({ open: false, text: '' })}
          onSubmit={submitAskAI}
        />
      )}

      {dialogOpen && pending && (
        <NewCommentDialog
          anchorInfo={{
            text: pending.text,
            paragraphId: currentParagraphId,
          }}
          onCancel={() => {
            setDialogOpen(false);
            clearPendingMark();
          }}
          onSubmit={(content) => {
            setDialogOpen(false);
            addHumanComment(
              { text: pending.text, paragraphId: currentParagraphId },
              content,
            );
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          saving={settingsSaving}
          error={settingsError}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

/* ---------------- 设置页 ---------------- */
function SettingsDialog({ settings, saving, error, onChange, onClose }) {
  const profile = readProfile(settings);
  const enabled = settings.enabled !== false;
  const limits = settings.limits;
  // 检索能力是否具备（由服务端 provider 配置决定）与用户是否打开，是两件事
  const searchAvailable = settings.searchAvailable === true;
  const searchEnabled = settings.searchEnabled === true;
  const searchInfo = settings.searchInfo;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-settings" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>

        <div className="set-group">
          <div className="set-title">AI 解释</div>

          <label className="set-row">
            <span className="set-label">
              启用 AI 解释
              <em>关闭后仅保留人工批注，不再向模型发起任何请求</em>
            </span>
            <input
              type="checkbox"
              className="switch"
              data-field="enabled"
              checked={enabled}
              disabled={saving}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
          </label>
        </div>

        {/* 两档并排摆出来，各自的用途写在卡片里，点一下即切换。
            文案全部来自 settings.profileOptions（服务端唯一真源），前端不写死档位名与描述 */}
        <div className="set-group">
          <div className="set-title">解读口径</div>
          <div className="set-note">
            同一个 AI，两种讲解力度。切换后立刻生效，只影响之后新发起的解释。
          </div>

          <div className="mode-picker" role="radiogroup" aria-label="解读口径">
            {Array.isArray(settings.profileOptions) && settings.profileOptions.length > 0 ? (
              settings.profileOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  data-profile={opt.value}
                  aria-checked={opt.value === profile}
                  className={`mode-opt ${opt.value === profile ? 'on' : ''}`}
                  disabled={saving || !enabled}
                  onClick={() => onChange({ profile: opt.value })}
                >
                  <b>{opt.label}</b>
                  <span>{opt.desc}</span>
                </button>
              ))
            ) : (
              <div className="set-note">
                未能读取档位选项，请检查服务端 /api/settings 是否返回 profileOptions。
              </div>
            )}
          </div>
        </div>

        {/* 联网检索。默认关闭，严格依据档强制不可用——
            严格依据档靠「只依据原文 + 逐条标出依据段落」立身，掺进外部网页溯源链就断了 */}
        <div className="set-group">
          <div className="set-title">联网检索</div>

          <label className="set-row">
            <span className="set-label">
              允许联网检索权威来源
              <em>
                {searchAvailable
                  ? `开启后，AI 判断需要时会在权威政务网站检索，并在答案里标出可点击的来源。当前仅放行 ${searchInfo?.allowedDomains?.length ?? 12} 个官方域名。`
                  : '服务端未配置检索服务（.env 缺少 SEARCH_PROVIDER 与 API Key），暂不可用。'}
              </em>
            </span>
            <input
              type="checkbox"
              className="switch"
              data-field="searchEnabled"
              checked={searchEnabled}
              disabled={saving || !enabled || !searchAvailable || profile === 'strict'}
              onChange={(e) => onChange({ searchEnabled: e.target.checked })}
            />
          </label>

          <div className={`set-note ${profile === 'strict' ? 'warn' : ''}`}>
            {profile === 'strict' ? (
              <>
                <b>严格依据档不联网。</b>
                该档要求「只依据原文作答、逐条标出依据段落」，掺入外部网页会让溯源链断掉。
                切到「讲透」档即可开启。
              </>
            ) : (
              <>
                <b>注意：开启后，选中的文字会被作为检索词发往第三方搜索服务。</b>
                内部文件、涉密材料请勿开启。检索结果只作为背景参考，与原文冲突时一律以原文为准。
              </>
            )}
          </div>
        </div>

        <div className="set-group">
          <div className="set-title">模型</div>

          <div className="set-row">
            <span className="set-label">模型名</span>
            <input
              type="text"
              className="set-input"
              value={settings.model ?? ''}
              disabled={saving || !enabled}
              placeholder="deepseek-flash"
              onChange={(e) => onChange({ model: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== settings.model) onChange({ model: v });
              }}
            />
          </div>

          <div className="set-row">
            <span className="set-label">
              推理强度
              <em>可调低以加快出字；严格依据档建议低或以上</em>
            </span>
            <select
              className="set-input"
              value={settings.effort ?? 'low'}
              disabled={saving || !enabled}
              onChange={(e) => onChange({ effort: e.target.value })}
            >
              {(settings.effortLevels ?? ['off', 'low', 'medium', 'high']).map((lv) => (
                <option key={lv} value={lv}>{EFFORT_LABEL[lv] ?? lv}</option>
              ))}
            </select>
          </div>
        </div>

        {limits && (
          <div className="set-group">
            <div className="set-title">限额（服务端固定）</div>
            <div className="set-limits">
              <span>选中内容 ≤ {limits.maxTextChars} 字</span>
              <span>段落 ≤ {limits.maxParagraphChars} 字</span>
              <span>追问 ≤ {limits.maxDepth} 层</span>
              <span>温度 {limits.temperature}</span>
            </div>
          </div>
        )}

        {error && <div className="set-error">保存失败：{error}</div>}

        <div className="modal-foot">
          <span className="set-saving">{saving ? '保存中…' : ''}</span>
          <button className="mini primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 活动时间线 ----------------
 * 把服务端推来的步骤（思考 / 检索 / 来源 / 作答）渲染成一条过程记录。
 *
 * 交互约定（按用户要求）：
 *   · 生成过程中**自动展开**，当前进行中的那一步带呼吸点，让等待有内容可看；
 *   · 调用结束后**自动折叠**成一行摘要（N 步 · 检索 M 次 · 耗时），需要时点开回看。
 */
const STEP_MARK = {
  think: '思',
  search: '检',
  answer: '答',
};

function ActivityTimeline({ steps = [], streaming, elapsedMs = 0, searched = 0 }) {
  const [open, setOpen] = useState(false);

  if (!steps.length) return null;

  // 流式中强制展开；结束后由用户控制，默认折叠
  const expanded = streaming ? true : open;
  const secs = elapsedMs > 0 ? (elapsedMs / 1000).toFixed(1) : '';
  const running = steps.some((s) => s.status === 'running');

  return (
    <div className={`activity ${streaming ? 'live' : ''}`} onClick={(e) => e.stopPropagation()}>
      <button
        className="act-head"
        type="button"
        disabled={streaming}
        title={streaming ? '生成中，结束后可折叠' : expanded ? '收起过程' : '展开过程'}
        onClick={() => { if (!streaming) setOpen((v) => !v); }}
      >
        <span className={`act-caret ${expanded ? 'down' : ''}`}>▸</span>
        <span className="act-name">{streaming ? '正在处理' : '处理过程'}</span>
        <span className="act-meta">
          {steps.length} 步
          {searched > 0 ? ` · 检索 ${searched} 次` : ''}
          {!streaming && secs ? ` · ${secs}s` : ''}
        </span>
        {streaming && <span className="act-pulse" />}
      </button>

      {expanded && (
        <ol className="act-list">
          {steps.map((s) => (
            <li key={s.key} className={`act-item ${s.status}`} data-kind={s.kind}>
              <span className="act-node">{STEP_MARK[s.kind] || '·'}</span>
              <div className="act-body">
                <div className="act-line">
                  <span className="act-label">{s.label}</span>
                  {s.elapsedMs > 0 ? (
                    <span className="act-time">{(s.elapsedMs / 1000).toFixed(1)}s</span>
                  ) : null}
                </div>
                {s.detail ? <div className="act-detail">「{s.detail}」</div> : null}
                {Array.isArray(s.items) && s.items.length > 0 && (
                  <ul className="act-docs">
                    {s.items.map((it) => (
                      <li key={it.url}>
                        <a
                          href={it.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={it.url}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {it.title}
                        </a>
                        {it.site ? <span className="act-site">{it.site}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
          {running && <li className="act-tail" />}
        </ol>
      )}
    </div>
  );
}

/* ---------------- 批注卡片 ---------------- */

/** 来源清单默认展示条数，其余折叠（联网一次最多 26 条） */
const SOURCE_PREVIEW = 6;

function CommentCard({
  comment,
  selected,
  active,
  onSelect,
  onDelete,
  // 整棵追问子树的条数（不含自己），用于「删除这条解读及其 N 条追问？」文案
  descendantCount = 0,
  // App 广播的「全部收起/展开」信号 { seq, to }
  collapseSignal,
  onJump,
  onFollowUp,
  depth,
}) {
  const d = comment.data || {};
  const isAI = d.type !== COMMENT_TYPES.HUMAN;
  // 注意：历史上用过 data.status === 'resolved' 做「标记解决」，该控件已移除。
  // 字段保留但不读取——旧批注即使带 resolved 也要完整显示（不划掉、不隐藏）。
  const [showReasoning, setShowReasoning] = useState(false);
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState('');
  // 删除二次确认（卡片内联，不用 window.confirm：jsdom 不实现，也没法断言）
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 来源清单展开态：放在 CommentCard 内，所以每条注释各自独立
  const [showAllSources, setShowAllSources] = useState(false);
  /**
   * AI 解答折叠态。
   *   · 流式中挂载 → 展开（用户要看着它出字），结束后也保持展开，由用户手动收起；
   *   · 刷新后加载到的「已完成」卡片 → 默认收起，问题一多时右栏才不至于被答案淹没。
   * 人工批注不折叠（本来就只有引用 + 批注文字），所以初值里带了 isAI 判断。
   * 「全部收起/展开」只通过 collapseSignal 覆盖，不改变这里的默认值。
   */
  const [collapsed, setCollapsed] = useState(() => isAI && d.streaming !== true);

  // 响应「全部收起/展开」：seq 递增即触发一次，to 决定方向。
  // 两个前提：
  //   1. 只作用于 AI 卡片——人工批注「不折叠」（它的正文就是全部内容，收起来等于看不到）；
  //   2. 挂载时就已经存在的 seq 记为「已消费」，否则点过「全部收起」之后新建的流式卡片
  //      会在挂载后被立刻收起，违反「流式中挂载默认展开」（task-6）。
  const seenCollapseSeq = useRef(collapseSignal?.seq ?? 0);
  useEffect(() => {
    if (!isAI) return;
    if (!collapseSignal?.seq || collapseSignal.seq === seenCollapseSeq.current) return;
    seenCollapseSeq.current = collapseSignal.seq;
    setCollapsed(collapseSignal.to === 'collapsed');
  }, [collapseSignal, isAI]);

  // 确认条打开时按 Escape 相当于「取消」
  useEffect(() => {
    if (!confirmDelete) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setConfirmDelete(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDelete]);

  const html = useMemo(() => {
    if (!comment.content) return '';
    try {
      return marked.parse(comment.content);
    } catch {
      return `<p>${escapeHtml(comment.content)}</p>`;
    }
  }, [comment.content]);

  const citations = d.citations?.length ? d.citations : extractCitations(comment.content);

  // 联网一次最多能带回 26 条去重来源，全量铺开会把卡片撑很长、
  // 把下面的「追问」按钮挤出视野，因此默认只露前 SOURCE_PREVIEW 条。
  // Array.from 兜一层：data 里的数组可能来自 Y.Doc 快照（类数组而非原生数组），
  // 归一成原生数组后才能安心用 slice。
  const sources = Array.isArray(d.sources) ? d.sources : Array.from(d.sources ?? []);
  const hiddenSources = Math.max(0, sources.length - SOURCE_PREVIEW);
  const shownSources = showAllSources ? sources : sources.slice(0, SOURCE_PREVIEW);

  return (
    <div
      className={`card ${selected ? 'sel' : ''} ${active ? 'act' : ''} ${collapsed ? 'is-collapsed' : ''}`.trim()}
      data-kind={isAI ? 'ai' : 'human'}
      onClick={onSelect}
      style={depth > 0 ? { marginLeft: Math.min(depth, 3) * 14 } : undefined}
    >
      <div className="card-head">
        <span className={`badge ${isAI ? 'ai' : 'human'}`}>
          {isAI ? (d.type === COMMENT_TYPES.AI_FOLLOWUP ? `AI 追问 L${d.depth}` : 'AI 解读') : '人工批注'}
        </span>
        {d.paragraphId && (
          <button className="pid" onClick={(e) => { e.stopPropagation(); onJump(d.paragraphId); }}>
            {d.paragraphId}
          </button>
        )}
        <span className="spacer" />
        {/* 「标记解决」已按用户反馈移除：会回看，不需要划掉。只保留删除，且删除前要确认 */}
        <button
          type="button"
          className="ic"
          title="删除"
          onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
        >
          ×
        </button>
      </div>

      {confirmDelete && (
        <div className="del-confirm" onClick={(e) => e.stopPropagation()}>
          <span className="del-text">
            {descendantCount > 0 ? `删除这条解读及其 ${descendantCount} 条追问？` : '删除这条解读？'}
          </span>
          <button
            type="button"
            className="del-yes"
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); onDelete(); }}
          >
            删除
          </button>
          <button
            type="button"
            className="del-no"
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
          >
            取消
          </button>
        </div>
      )}

      {/*
        引用块：一眼看出这条批注/解读针对的是哪段原文（用户反馈：现在必须回头看正文才知道）。
        只在顶层卡片（depth === 0）渲染，追问不把同一段引用重复刷屏；人工批注同样显示。
      */}
      {d.anchorText && depth === 0 && (
        <div className="card-quote" title={d.anchorText}>
          <span className="quote-tag">引用</span>
          <span className="quote-text">{d.anchorText}</span>
        </div>
      )}

      {d.question && (
        <div className="q">
          <span className="q-tag">问</span>
          {d.question}
        </div>
      )}

      {/* AI 解答可折叠：收起后右栏只剩「引用 + 问题」，问题多了也不至于太长 */}
      {isAI && (
        <button
          type="button"
          className="card-collapse"
          onClick={(e) => {
            // 卡片点击会选中注释，展开/收起不该顺带切选中态
            e.stopPropagation();
            setCollapsed((v) => !v);
          }}
        >
          {collapsed ? '展开解答' : '收起'}
        </button>
      )}

      {!comment.anchor && <div className="orphan-tag">孤立批注 · 未绑定位置</div>}

      {!collapsed && (
        <>
          {isAI && (
            <ActivityTimeline
              steps={d.steps}
              streaming={d.streaming}
              elapsedMs={d.elapsedMs}
              searched={d.searched}
            />
          )}

      {d.streaming ? (
        <div className="stream">
          {comment.content ? (
            <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
          ) : d.steps?.length ? (
            // 有步骤时间线时不再重复报「正在生成」，避免同一件事说两遍
            <span className="thinking"> </span>
          ) : (
            <span className="thinking">正在依据原文生成解释…</span>
          )}
          <span className="caret" />
        </div>
      ) : d.error ? (
        <div className="err">{d.error}</div>
      ) : (
        <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      )}

      {d.reasoning && (
        <div className="reasoning">
          <button className="rt" onClick={(e) => { e.stopPropagation(); setShowReasoning(!showReasoning); }}>
            {showReasoning ? '▾' : '▸'} 推理过程（{d.reasoning.length} 字）
          </button>
          {showReasoning && <pre className="rbody">{d.reasoning}</pre>}
        </div>
      )}

      {citations.length > 0 && (
        <div className="cites">
          依据
          {citations.map((c) => (
            <button key={c} className="cite" onClick={(e) => { e.stopPropagation(); onJump(c); }}>
              {c}
            </button>
          ))}
        </div>
      )}

      {/*
        联网来源清单。done 事件带的 sources 是整轮去重后的权威来源，
        时间线里的来源只挂在「检索」步骤下、折叠后看不见，
        因此这里再单独列一份：答案说完，用户能立刻点开原始出处核对。
        条数可能很多（真机最多 26 条），默认只露前 6 条，其余用按钮展开；
        徽标始终显示总条数，展开态由 CommentCard 各自持有。
      */}
      {isAI && sources.length > 0 && (
        <div className="srcs" onClick={(e) => e.stopPropagation()}>
          <div className="srcs-head">
            来源
            <span className="srcs-count">{sources.length}</span>
            <span className="srcs-note">联网检索，非原文</span>
          </div>
          <ol className="srcs-list">
            {shownSources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer noopener" title={s.url}>
                  {s.title || s.url}
                </a>
                {s.site ? <span className="srcs-site">{s.site}</span> : null}
              </li>
            ))}
          </ol>
          {hiddenSources > 0 && (
            <button
              type="button"
              className="srcs-more"
              onClick={(e) => {
                // 卡片本身点击会选中注释，这里必须拦住，否则展开会顺带切选中态
                e.stopPropagation();
                setShowAllSources((v) => !v);
              }}
            >
              {showAllSources ? '收起' : `展开其余 ${hiddenSources} 条`}
            </button>
          )}
        </div>
      )}

      {isAI && (
        <div className="card-foot" onClick={(e) => e.stopPropagation()}>
          {replying ? (
            <div className="reply-box">
              <input
                autoFocus
                value={replyText}
                placeholder="针对这条解释继续追问…"
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && replyText.trim()) {
                    onFollowUp(replyText.trim());
                    setReplyText('');
                    setReplying(false);
                  }
                  if (e.key === 'Escape') setReplying(false);
                }}
              />
              <button
                className="mini primary"
                onClick={() => {
                  if (replyText.trim()) {
                    onFollowUp(replyText.trim());
                    setReplyText('');
                    setReplying(false);
                  }
                }}
              >
                发送
              </button>
            </div>
          ) : (
            <button className="mini" onClick={() => setReplying(true)}>
              ↳ 追问（{(d.depth ?? 0) + 1}/{MAX_DEPTH}）
            </button>
          )}
        </div>
      )}
        </>
      )}
    </div>
  );
}

function AskDialog({ anchorText, paragraphId, value, onChange, onCancel, onSubmit }) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>向 AI 提问</h3>
        <div className="anchor-preview">
          <span className="pid">{paragraphId || '未定位'}</span>
          {anchorText}
        </div>
        <textarea
          autoFocus
          rows={3}
          value={value}
          placeholder="留空则直接解释选中内容；例如：我这种情况属于哪一类？"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit();
            if (e.key === 'Escape') onCancel();
          }}
        />
        <p className="modal-tip">
          AI 回答将严格依据上方原文段落，并标注依据段落编号。
        </p>
        <div className="modal-foot">
          <button className="mini" onClick={onCancel}>取消</button>
          <button className="mini primary" onClick={onSubmit}>
            {value.trim() ? '提问' : '直接解释'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewCommentDialog({ anchorInfo, onCancel, onSubmit }) {
  const [text, setText] = useState('');
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>添加批注</h3>
        <div className="anchor-preview">
          <span className="pid">{anchorInfo.paragraphId || '未定位'}</span>
          {anchorInfo.text}
        </div>
        <textarea
          autoFocus
          rows={4}
          value={text}
          placeholder="写下你的理解或疑问…"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="modal-foot">
          <button className="mini" onClick={onCancel}>取消</button>
          <button
            className="mini primary"
            disabled={!text.trim()}
            onClick={() => text.trim() && onSubmit(text.trim())}
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 工具函数 ---------------- */

/** 构建正文 HTML。标题与发布信息已在页面头部呈现，此处只输出章节与条款。 */
function buildPolicyHtml(policy) {
  const esc = escapeHtml;
  const parts = [];
  for (const sec of policy.sections) {
    parts.push(`<h2>${esc(sec.heading)}</h2>`);
    for (const cl of sec.clauses) {
      parts.push(`<p data-pid="${esc(cl.id)}" data-clause="${esc(cl.id)}">${esc(cl.text)}</p>`);
    }
  }
  return parts.join('');
}

/**
 * 抽取引用编号。
 *
 * 同时认两种形式：
 *   [P-3-1]   系统分配的段落 ID
 *   [第二条]   中文条号
 *
 * 后者必须支持：条例类文本每条正文本身就以「第X条」开头，
 * 模型极易直接引用这个自然编号，只认 [P-x] 会导致
 * 引用标签不显示、点击回查失效（真实条例测试中复现过）。
 */
function extractCitations(text) {
  const out = [];
  const re = /\[(P-[\w-]+|第[\d一二三四五六七八九十百零]+[条章节])\]/g;
  let m;
  while ((m = re.exec(text || ''))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 选区所属条款段落 ID */
function findParagraphId(doc, pos) {
  let result = '';
  doc.descendants((node, p) => {
    if (node.type.name === 'paragraph') {
      const end = p + node.nodeSize;
      if (pos >= p && pos <= end) {
        const pid = node.attrs?.pid;
        if (pid) result = pid;
        return false;
      }
    }
    return true;
  });
  return result;
}

/** 选区所属段落的完整文本 */
function paragraphTextAt(doc, pos) {
  let result = '';
  doc.descendants((node, p) => {
    if (node.type.name === 'paragraph') {
      const end = p + node.nodeSize;
      if (pos >= p && pos <= end) {
        result = node.textContent;
        return false;
      }
    }
    return true;
  });
  return result;
}

/**
 * 按 pid 取条款原文，用于跳转兜底。
 * 必须传当前文档的 policy —— 早先写死用 SAMPLE_POLICY，
 * 载入真实文档后这里永远找不到，兜底形同虚设。
 */
function findClauseText(pid, policy) {
  const sections = policy?.sections ?? [];
  for (const sec of sections) {
    for (const cl of sec.clauses) {
      if (cl.id === pid) return cl.text;
    }
  }
  return '';
}

/**
 * 把指定位置滚动到视野中央。
 *
 * domAtPos() 返回的 node 可能是文本节点，文本节点没有 scrollIntoView，
 * 直接调会抛 TypeError（真实浏览器与 jsdom 都会）。
 * 因此非元素节点要上溯到父元素，并做能力检测。
 */
function scrollPosIntoView(editor, pos) {
  try {
    const at = editor.view.domAtPos(pos);
    let node = at?.node ?? null;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (typeof node?.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch {
    /* 定位失败不影响正文与批注数据 */
  }
}

function findTextPos(editor, text) {  const doc = editor.state.doc;
  let found = null;
  doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.isText && node.text.includes(text.slice(0, 20))) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * 说明：contentDoc 的结构由 Collaboration（ySync）插件自动维护，
 * 此处无需手工同步 XmlFragment。
 */