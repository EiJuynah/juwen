/**
 * 测试用真实样本（《中国共产党统一战线工作条例》.wps，实为 Word97 二进制）的路径解析。
 *
 * 为什么需要它：`parser-test` / `policy-extract-test` / `files-api-test` 原本都硬编码了
 * 开发机上的绝对路径 `C:/Users/<用户名>/Desktop/工作/0个人资料/…`。
 * 换台机器或跑 CI 时文件不存在 → `fs.readFileSync` 直接抛 ENOENT，
 * 整个离线测试挂掉（首次发布流水线两个平台就是因为这个红的）。
 *
 * 解析顺序：
 *   1. 环境变量 `JUWEN_SAMPLE`（想用别的文件时覆盖）
 *   2. 仓库内随包提供的 `test-fixtures/`（其他人 clone、CI 上都能跑）
 *   3. 开发机上的原始路径（兼容老习惯）
 * 都找不到时返回 `null`，调用方打印 SKIP 并跳过依赖它的断言，**不要抛错**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SAMPLE_NAME = '中国共产党统一战线工作条例.wps';

export function resolveSampleDoc() {
  const candidates = [
    process.env.JUWEN_SAMPLE,
    path.join(ROOT, 'test-fixtures', SAMPLE_NAME),
    `C:/Users/yujie/Desktop/工作/0个人资料/${SAMPLE_NAME}`,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 非法路径直接跳过 */
    }
  }
  return null;
}

/** 找不到样本时打印一行 SKIP（不算失败），返回 true 表示已跳过 */
export function skipSample(label = '真实样本') {
  console.log(
    `  \x1b[33m-\x1b[0m SKIP ${label}：找不到样本文件。` +
      '把样本放到 test-fixtures/ 或用 JUWEN_SAMPLE=<路径> 指定后即可运行这部分断言。',
  );
  return true;
}
