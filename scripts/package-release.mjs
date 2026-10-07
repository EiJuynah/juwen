#!/usr/bin/env node
/**
 * 发布打包：一条命令完成 staging → 生产依赖 → 内置运行时 → 便携包 → 安装器 → 自检。
 * 本地与 CI 共用；**本机缺 Inno Setup / dpkg-deb 时优雅降级**（只出 staging + 便携包），
 * 真正的 .exe / .deb 在 CI 里生成。
 *
 *   node scripts/package-release.mjs [--os win|linux] [--version v0.1.0] [--out release]
 *                                    [--node-from <path>] [--no-smoke]
 *
 * 设计取舍（详见 task-12 契约）：
 *   · 不下载整套 Node 运行时：依赖里没有原生模块，官方 node 自带 full-icu
 *     （我们要用 TextDecoder('gbk') 抓页面正文），所以复制一个 node 可执行文件就够；
 *     同目录/上级目录能找到 Node 的 LICENSE 就一并放进 runtime/（许可要求）。
 *   · 数据目录不放在程序目录：安装后程序在 Program Files / opt 下写不进去，
 *     启动器会把 cwd 切到 %APPDATA%\juwen 或 ~/.local/share/juwen。
 *   · 自检用内置 runtime/node 真起一次 staged 应用（health 200 + 首页 HTML），
 *     顺带验证 DATA_DIR 会被建出来——CI 里不跑需要外部依赖的 e2e-check。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_NAME = 'juwen';

const started = Date.now();
const log = (m) => console.log(`[打包] ${m}`);
const step = (m) => console.log(`\n[打包] ==== ${m} ====`);
const warn = (m) => console.warn(`[打包][警告] ${m}`);
function fail(msg) {
  console.error(`\n[打包][失败] ${msg}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

// ─────────────────────────────────────────────── CLI
function printHelp() {
  console.log(`用法：node scripts/package-release.mjs [选项]

  --os win|linux   目标平台（默认当前平台）
  --version vX.Y.Z 版本（可带 v，默认 0.0.0）
  --out <dir>      产物目录（默认 release）
  --node-from <p>  作为内置运行时的 node 可执行文件（默认 process.execPath）
  --no-smoke       跳过打包自检`);
}

function parseArgs(argv) {
  const args = {
    os: process.platform === 'win32' ? 'win' : 'linux',
    version: '0.0.0',
    out: 'release',
    nodeFrom: process.execPath,
    smoke: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--os') args.os = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--node-from') args.nodeFrom = argv[++i];
    else if (a === '--no-smoke') args.smoke = false;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else fail(`未知参数：${a}（--help 看用法）`);
  }
  args.version = String(args.version || '').replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(args.version)) fail(`版本号格式不对：${args.version}（期望 0.1.0 或 v0.1.0）`);
  if (args.os !== 'win' && args.os !== 'linux') fail(`--os 只能是 win 或 linux，收到：${args.os}`);
  return args;
}

// ─────────────────────────────────────────────── 小工具
/**
 * 跑外部命令。stdio 一律写文件描述符或 inherit——**不用 pipe**：
 * 本沙箱下 spawnSync 的 pipe 会 EPERM，CI 里保持同一套行为更稳。
 */
function run(cmd, cmdArgs, { cwd = ROOT, logFile = null, shell = false } = {}) {
  // shell:true 时 Node 不会替我们给参数加引号，路径里有空格就会散架——自己补上
  const finalArgs = shell
    ? cmdArgs.map((a) => (/\s/.test(String(a)) ? `"${a}"` : String(a)))
    : cmdArgs;
  let out = null;
  let stdio = 'inherit';
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.openSync(logFile, 'a');
    stdio = ['ignore', out, out];
  }
  const r = spawnSync(cmd, finalArgs, { cwd, stdio, shell, windowsHide: true, env: process.env });
  if (out !== null) fs.closeSync(out);
  return { status: r.status, error: r.error };
}

function tail(file, lines = 25) {
  try {
    const all = fs.readFileSync(file, 'utf8').split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '(无日志)';
  }
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** 优先用 5199（契约里点名的端口），被占则让系统随便给一个 */
function pickPort() {
  const tryListen = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(null));
      srv.listen(port, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
  return tryListen(5199).then((p) => p ?? tryListen(0));
}

// ─────────────────────────────────────────────── 主流程
const args = parseArgs(process.argv.slice(2));
const OUT = path.resolve(ROOT, args.out);
const STAGE_NAME = `${APP_NAME}-${args.version}-${args.os}-x64`;
const STAGE = path.join(OUT, STAGE_NAME);
const NODE_EXE = args.os === 'win' ? 'node.exe' : 'node';
const artifacts = [];

// 安全阀：--out 不许指到仓库根、仓库祖先或家目录（下一步会清空它）
{
  const resolvedRoot = path.resolve(ROOT);
  if (OUT === resolvedRoot || resolvedRoot.startsWith(OUT + path.sep) || OUT === path.resolve(os.homedir())) {
    fail(`--out 指向了危险目录：${OUT}`);
  }
}

step(`目标 ${args.os} · 版本 ${args.version} · 产物目录 ${OUT}`);

// 1) 前置校验
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  fail('找不到 dist/index.html —— 先跑 npm run build 再打包');
}

// 2) 组装 staging
log(`组装 staging：${STAGE_NAME}/`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

for (const dir of ['server', 'dist', 'demo']) {
  const src = path.join(ROOT, dir);
  if (!fs.existsSync(src)) {
    warn(`缺少 ${dir}/，跳过`);
    continue;
  }
  fs.cpSync(src, path.join(STAGE, dir), { recursive: true });
}
for (const file of ['package.json', 'package-lock.json', '.env.example', 'README.md']) {
  const src = path.join(ROOT, file);
  if (!fs.existsSync(src)) {
    warn(`缺少 ${file}，跳过`);
    continue;
  }
  fs.copyFileSync(src, path.join(STAGE, file));
}
{
  const launcherSrc = args.os === 'win'
    ? path.join(ROOT, 'packaging', 'windows', '启动 juwen.cmd')
    : path.join(ROOT, 'packaging', 'linux', 'juwen.sh');
  const launcherName = args.os === 'win' ? '启动 juwen.cmd' : 'juwen.sh';
  if (!fs.existsSync(launcherSrc)) fail(`找不到启动器：${launcherSrc}`);
  const launcherDest = path.join(STAGE, launcherName);
  fs.copyFileSync(launcherSrc, launcherDest);
  if (args.os === 'linux') fs.chmodSync(launcherDest, 0o755);
  log(`启动器：${launcherName}`);
}

// staging 里不许有私密/开发目录
for (const forbidden of ['data', '.env', 'scripts', 'web', 'wb', 'node_modules']) {
  if (fs.existsSync(path.join(STAGE, forbidden))) fail(`staging 里不允许出现 ${forbidden}/（或 .env）`);
}

// 3) 生产依赖
step('安装生产依赖');
{
  const npmLog = path.join(OUT, `npm-install-${args.os}.log`);
  log(`日志：${path.relative(ROOT, npmLog)}`);
  const shell = process.platform === 'win32';
  const common = ['--no-audit', '--no-fund', '--prefix', STAGE];
  const cacheDir = path.join(os.tmpdir(), `${APP_NAME}-npm-cache`);

  const runNpm = (npmArgs) => {
    let r = run('npm', npmArgs, { shell, logFile: npmLog });
    if (r.status === 0) return r;
    // 受限环境（沙箱 / 家目录只读）里 npm 默认缓存目录写不进去，换临时缓存再试一次
    warn(`npm 第一次没成功，改用临时缓存重试：${cacheDir}`);
    return run('npm', [...npmArgs, '--cache', cacheDir], { shell, logFile: npmLog });
  };

  let result = runNpm(['ci', '--omit=dev', ...common]);
  if (result.status !== 0) {
    warn('npm ci 失败：当前 package-lock.json 与 package.json 不同步（缺 @esbuild/* 可选依赖条目）。');
    warn('回落 npm install --omit=dev --no-package-lock；要恢复 npm ci，在开发机跑一次 npm install 并提交 package-lock.json。');
    result = runNpm(['install', '--omit=dev', '--no-package-lock', ...common]);
  }
  if (result.status !== 0) {
    fail(`生产依赖安装失败（exit=${result.status}${result.error ? `, ${result.error.message}` : ''}），日志尾部：\n${tail(npmLog)}`);
  }
  const mods = path.join(STAGE, 'node_modules');
  if (!fs.existsSync(mods)) fail('安装之后没有 node_modules');
  if (!fs.existsSync(path.join(mods, 'express', 'package.json'))) fail('安装之后缺少 express —— node_modules 不完整');
  log(`node_modules 就绪（${mb(dirSize(mods))}）`);
}

// 4) 内置运行时
step('内置 Node 运行时');
{
  const runtimeDir = path.join(STAGE, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const src = path.resolve(args.nodeFrom);
  if (!fs.existsSync(src)) fail(`--node-from 不存在：${src}`);
  const dest = path.join(runtimeDir, NODE_EXE);
  fs.copyFileSync(src, dest);
  if (args.os === 'linux') fs.chmodSync(dest, 0o755);
  log(`runtime/${NODE_EXE} ← ${src}（${mb(fs.statSync(dest).size)}）`);

  // Node 的许可要求随二进制分发 LICENSE。先按契约找 <node 目录>/../LICENSE，
  // 再补一个同目录回退（Windows 官方 zip 的 LICENSE 就在 node.exe 旁边）。
  const candidates = [
    path.join(path.dirname(src), '..', 'LICENSE'),
    path.join(path.dirname(src), 'LICENSE'),
  ];
  const lic = candidates.find((p) => fs.existsSync(p));
  if (lic) {
    fs.copyFileSync(lic, path.join(runtimeDir, 'LICENSE'));
    log(`runtime/LICENSE ← ${lic}`);
  } else {
    warn(`没找到 Node 的 LICENSE（试过 ${candidates.join(' / ')}），已跳过——发布前建议手工补上`);
  }
}

// 5) 便携包
step('便携包');
{
  const name = args.os === 'win'
    ? `${STAGE_NAME}.zip`
    : `${STAGE_NAME}.tar.gz`;
  const target = path.join(OUT, name);
  const tarArgs = args.os === 'win'
    ? ['-a', '-c', '-f', target, '-C', OUT, STAGE_NAME]
    : ['-czf', target, '-C', OUT, STAGE_NAME];
  const r = run('tar', tarArgs, { logFile: path.join(OUT, `tar-${args.os}.log`) });
  if (r.status !== 0 || !fs.existsSync(target)) fail(`tar 打包失败：${r.error?.message || `exit=${r.status}`}`);
  artifacts.push(target);
  log(`${name}（${mb(fs.statSync(target).size)}）`);
}

// 6) 安装器（缺工具就降级）
step('安装器');
if (args.os === 'win') {
  const iss = path.join(ROOT, 'installer', 'windows', 'juwen.iss');
  const isccCandidates = [
    process.env.ISCC,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter(Boolean);
  const iscc = isccCandidates.find((p) => fs.existsSync(p));
  if (!iscc) {
    warn('未找到 Inno Setup，已跳过 .exe（CI 会装）');
  } else {
    const r = run(iscc, [
      `/DAppVersion=${args.version}`,
      `/DStageDir=${STAGE}`,
      `/O${OUT}`,
      `/F${APP_NAME}-${args.version}-win-x64-setup`,
      iss,
    ], { logFile: path.join(OUT, 'iscc.log') });
    const exe = path.join(OUT, `${APP_NAME}-${args.version}-win-x64-setup.exe`);
    if (r.status !== 0 || !fs.existsSync(exe)) fail(`Inno Setup 编译失败：\n${tail(path.join(OUT, 'iscc.log'))}`);
    artifacts.push(exe);
    log(`${path.basename(exe)}（${mb(fs.statSync(exe).size)}）`);
  }
} else {
  const hasDpkg = run('sh', ['-c', 'command -v dpkg-deb >/dev/null 2>&1']).status === 0;
  if (!hasDpkg) {
    warn('未找到 dpkg-deb，已跳过 .deb（CI 会装/deb 工具链自带）');
  } else {
    const script = path.join(ROOT, 'installer', 'linux', 'build-deb.sh');
    const r = run('bash', [script, STAGE, args.version, OUT], { logFile: path.join(OUT, 'build-deb.log') });
    const deb = path.join(OUT, `${APP_NAME}_${args.version}_amd64.deb`);
    if (r.status !== 0 || !fs.existsSync(deb)) fail(`build-deb.sh 失败：\n${tail(path.join(OUT, 'build-deb.log'))}`);
    artifacts.push(deb);
    log(`${path.basename(deb)}（${mb(fs.statSync(deb).size)}）`);
  }
}

// 7) SHA256SUMS
step('校验和');
{
  const lines = [];
  for (const file of artifacts) lines.push(`${await sha256(file)}  ${path.basename(file)}`);
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), lines.join('\n') + '\n', 'utf8');
  log('SHA256SUMS');
  for (const l of lines) console.log(`        ${l.split('  ')[1]}  ${l.slice(0, 16)}…`);
}

// 8) 自检：用内置 runtime/node 真起一次 staged 应用
if (args.smoke) {
  step('打包自检（起 staged 应用）');
  const nodeBin = path.join(STAGE, 'runtime', NODE_EXE);
  const port = await pickPort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_NAME}-smoke-`));
  const dataDir = path.join(tmpRoot, 'data');
  const appLog = path.join(OUT, `smoke-${args.os}.log`);
  const fd = fs.openSync(appLog, 'w');
  log(`cwd=${tmpRoot}（模拟数据根）DATA_DIR=${dataDir} PORT=${port}`);
  const child = spawn(nodeBin, [path.join(STAGE, 'server', 'index.js')], {
    cwd: tmpRoot,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  let exitCode = null;
  child.on('exit', (c) => {
    exitCode = c;
  });

  const base = `http://127.0.0.1:${port}`;
  let health = null;
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline && exitCode === null) {
      try {
        const r = await fetch(`${base}/api/health`);
        if (r.ok) {
          const j = await r.json();
          if (j?.ok === true) {
            health = j;
            break;
          }
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(300);
    }
    if (!health) {
      fail(`自检失败：/api/health 30s 内未就绪（子进程退出码 ${exitCode}），应用日志尾部：\n${tail(appLog)}`);
    }
    log(`/api/health ok=true（profile=${health.profile ?? '?'}，model=${health.model ?? '?'}）`);

    const homepage = await fetch(`${base}/`);
    const html = await homepage.text();
    if (!homepage.ok || !html.includes('<div id="root">')) {
      fail(`自检失败：GET / 未返回预期的 HTML（status=${homepage.status}，长度=${html.length}），日志尾部：\n${tail(appLog)}`);
    }
    log('GET / 返回含 <div id="root"> 的 HTML');

    if (!fs.existsSync(dataDir)) fail(`自检失败：DATA_DIR 没有被创建：${dataDir}`);
    log(`DATA_DIR 已按预期创建（${path.basename(dataDir)}/ 落在数据根下）`);

    log('自检通过');
  } finally {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
    await sleep(400);
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    try {
      fs.closeSync(fd);
    } catch {
      /* 忽略 */
    }
  }
} else {
  step('打包自检：已用 --no-smoke 跳过');
}

// 9) 产物清单
step('产物');
console.log(`  staging: ${STAGE_NAME}/（${mb(dirSize(STAGE))}）`);
for (const f of [...artifacts, path.join(OUT, 'SHA256SUMS')]) {
  console.log(`  ${path.basename(f)}（${mb(fs.statSync(f).size)}）`);
}
log(`完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
