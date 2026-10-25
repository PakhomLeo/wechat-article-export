#!/usr/bin/env node
// 微信文章「长链 -> 短链」采集器
// 用法（需要 QODER_HOME 指向 Qoder 数据目录，且微信已登录、文件传输助手已打开）：
//   QODER_HOME="$HOME/.qoder-cn" node harvest.mjs --links ~/Downloads/长链接.txt --out data/shortlinks.jsonl --limit 2
// 原理：把长链发给文件传输助手 -> 点击消息 -> 微信内置浏览器打开 -> 右键标题 -> 复制链接 -> 读剪贴板。
// 短链形如 https://mp.weixin.qq.com/s/XXXXXXXX，可脱离微信直接抓取。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CUA_ENTRY = '/Applications/Qoder CN.app/Contents/Resources/node-repl/node_modules/@qoder-space/computer-use/index.js';
const PY_MOUSE = path.join(HERE, 'human_mouse.py');
const PY_KEY = path.join(HERE, 'human_key.py');

function parseArgs(argv) {
  const a = { links: null, table: null, out: 'data/shortlinks.jsonl', fail: 'data/failures.jsonl', dead: 'data/dead.jsonl', limit: 0, start: 1, human: true,
    everyMin: 10, everyMax: 30, pauseMin: 60, pauseMax: 120 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--links') a.links = argv[++i];
    else if (k === '--table') a.table = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--fail') a.fail = argv[++i];
    else if (k === '--dead') a.dead = argv[++i];
    else if (k === '--limit') a.limit = parseInt(argv[++i], 10) || 0;
    else if (k === '--start') a.start = parseInt(argv[++i], 10) || 1;
    else if (k === '--human') a.human = argv[++i] !== '0';
    else if (k === '--every-min') a.everyMin = parseInt(argv[++i], 10) || 0;
    else if (k === '--every-max') a.everyMax = parseInt(argv[++i], 10) || 0;
    else if (k === '--pause-min') a.pauseMin = parseInt(argv[++i], 10) || 0;
    else if (k === '--pause-max') a.pauseMax = parseInt(argv[++i], 10) || 0;
  }
  if (a.everyMax < a.everyMin) a.everyMax = a.everyMin;
  if (a.pauseMax < a.pauseMin) a.pauseMax = a.pauseMin;
  if (!a.links && !a.table) throw new Error('missing --links or --table');
  return a;
}

const args = parseArgs(process.argv);
let entries;
if (args.table) {
  entries = [];
  for (const ln of fs.readFileSync(args.table, 'utf8').split(/\r?\n/)) {
    const t = ln.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split('|');
    if (p.length < 4) continue;
    entries.push({ seq: parseInt(p[0], 10) || entries.length + 1, id: p[1].trim(), title: p[2].trim(), long: p[3].trim() });
  }
} else {
  entries = fs.readFileSync(args.links, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .map((u, k) => ({ seq: k + 1, id: null, title: '', long: u }));
}
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.mkdirSync('data/shots', { recursive: true });

const normLong = u => u.trim()
  .replace(/#.*$/, '')
  .replace(/[?&]scene=\d+/g, '')
  .replace(/^https?:\/\//, 'http://');
const doneIds = new Set();
const doneLongs = new Set();
const deadIds = new Set();
const dupShorts = new Map();
let lastShort0 = null;
if (fs.existsSync(args.out)) {
  for (const line of fs.readFileSync(args.out, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      doneLongs.add(o.long);
      if (o.id) doneIds.add(o.id);
      if (o.short) { lastShort0 = o.short; dupShorts.set(normLong(o.long), o.short); }
    } catch {}
  }
}

// 已确认失效（页面显示“已被发布者删除”、取不到短链）的文章，后续运行直接跳过
if (fs.existsSync(args.dead)) {
  for (const line of fs.readFileSync(args.dead, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.id) deadIds.add(o.id); } catch {}
  }
}

let origClip = '';
try { origClip = execFileSync('pbpaste', [], { encoding: 'utf8', maxBuffer: 32 << 20 }); } catch {}
process.on('exit', () => { try { execFileSync('pbcopy', [], { input: origClip }); } catch {} });

const log = (...xs) => console.log(new Date().toISOString().slice(11, 19), ...xs);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const pause = (a, b) => sleep(Math.round(rnd(a, b)));
const sh = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8' });
const key = (k, opts = {}) => execFileSync('python3', [PY_KEY, '--key', k,
  ...(opts.cmd ? ['--cmd'] : []), ...(opts.shift ? ['--shift'] : [])], { timeout: 8000 });
const pasteText = async (text) => {
  execFileSync('pbcopy', [], { input: text, timeout: 5000 });
  await pause(120, 260);
  key('v', { cmd: true });
};

function pngSize(buf) {
  if (buf.length < 24) return { w: 0, h: 0 };
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// 在菜单截图里找第 3 个文字行（问AI/刷新/复制链接），返回点击坐标
// 深浅主题通用：按“相对本行中位亮度的反差”判断有没有文字，而不是“够不够亮”
function findCopyLinkY(shotPath, W, H, rect, xLeft = 250) {
  const sx = W / rect.w, sy = H / rect.h;
  const x0 = Math.round(xLeft * sx), y0 = Math.round(32 * sy);
  const w = Math.round(180 * sx), h = Math.round(488 * sy);
  const raw = execFileSync('magick', [shotPath, '-crop', `${w}x${h}+${x0}+${y0}`, '+repage', '-colorspace', 'gray', '-depth', '8', 'gray:-'], { maxBuffer: 64 << 20 });
  const vals = new Array(w);
  const blocks = [];
  let cur = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) vals[x] = raw[y * w + x];
    const sorted = vals.slice().sort((a, b) => a - b);
    const med = sorted[w >> 1];
    let cnt = 0;
    for (let x = 0; x < w; x++) if (Math.abs(vals[x] - med) > 45) cnt++;
    const hasText = cnt > Math.max(4, Math.round(w * 0.03));
    if (hasText) {
      if (!cur) cur = [y, y]; else cur[1] = y;
    } else if (cur) {
      if (cur[1] - cur[0] >= 6) blocks.push(cur);
      cur = null;
    }
  }
  if (cur && cur[1] - cur[0] >= 6) blocks.push(cur);
  if (blocks.length < 3) return null;
  const b = blocks[2];
  return { y: y0 + Math.round((b[0] + b[1]) / 2) / sy, x: xLeft + 50, blocks: blocks.length };
}

// 找聊天区最下面的绿色气泡（发出的消息）
function findLastBubbleY(shotPath, W, H) {
  const raw = execFileSync('magick', [shotPath, '-depth', '8', 'rgb:-'], { maxBuffer: 64 << 20 });
  const x1 = Math.min(W - 30, Math.round(W * 0.95));
  const yEnd = Math.min(H, Math.round(H * 0.78));
  const blocks = [];
  let cur = null;
  for (let y = Math.round(H * 0.10); y < yEnd; y++) {
    let cnt = 0;
    for (let x = Math.round(W * 0.15); x < x1; x += 2) {
      const i = (y * W + x) * 3;
      const r = raw[i], g = raw[i + 1], b = raw[i + 2];
      if (g > 120 && g > r * 1.25 && g > b * 1.15) cnt++;
    }
    if (cnt > 15) {
      if (!cur) cur = [y, y]; else cur[1] = y;
    } else if (cur) {
      if (cur[1] - cur[0] > 8) blocks.push(cur);
      cur = null;
    }
  }
  if (cur && cur[1] - cur[0] > 8) blocks.push(cur);
  if (!blocks.length) return null;
  const b = blocks[blocks.length - 1];
  return Math.round((b[0] + b[1]) / 2);
}

const mod = await import(CUA_ENTRY);
const cua = await mod.ComputerUse.createAppClient();

async function activateWechat() {
  try { sh('osascript', ['-e', 'tell application "WeChat" to activate']); } catch (e) { log('activate warn', e.message); }
  await pause(500, 900);
}

async function snap(wx) {
  const s = await wx.getScreenshot({ emit: false });
  const b = Buffer.from(s);
  const { w, h } = pngSize(b);
  return { buf: b, w, h };
}

function winRects() {
  let names = [];
  try {
    const no = sh('osascript', ['-e', 'tell application "System Events" to tell process "WeChat" to get name of every window']).trim();
    if (no) names = no.split(/,\s*/);
  } catch {}
  const out = sh('osascript', ['-e', 'tell application "System Events" to tell process "WeChat" to get {position of every window, size of every window}']);
  const n = (out.match(/-?\d+/g) || []).map(Number);
  const count = Math.floor(n.length / 4);
  const rects = [];
  for (let i = 0; i < count; i++) {
    const x = n[i * 2], y = n[i * 2 + 1];
    const w = n[count * 2 + i * 2], h = n[count * 2 + i * 2 + 1];
    if (w > 100 && h > 100) rects.push({ name: names[i] || '', x, y, w, h, aspect: w / h });
  }
  return rects;
}

function rectByName(name) {
  return winRects().find(r => r.name === name) || null;
}

// 文章窗口名字不固定（微信 (窗口) / 消息阅读 …），用“不是主窗口/看图窗口”来认
function articleRect() {
  return winRects().find(r => r.name !== '微信' && r.name !== '图片和视频' && !r.name.startsWith('图片和视频') && r.w > 500 && r.h > 400) || null;
}

// 按截图宽高比挑出对应的那个微信窗口（主窗口 vs 文章窗口）
function winRectFor(sw, sh) {
  const target = sw / sh;
  const rects = winRects();
  if (!rects.length) throw new Error('no wechat windows');
  rects.sort((a, b) => Math.abs(a.aspect - target) - Math.abs(b.aspect - target));
  return rects[0];
}

// 从截图比例坐标换算成屏幕坐标，沿随机贝塞尔曲线移动后点击
async function clickFrac(wx, fx, fy, opts = {}) {
  try {
    const s = opts.shot || await snap(wx);
    let r;
    if (opts.window === 'main') r = rectByName('微信');
    else if (opts.window === 'article') r = articleRect();
    if (!r) r = winRectFor(s.w, s.h);
    const j = opts.jitter ?? 2;
    const x = r.x + fx * r.w + rnd(-j, j);
    const y = r.y + fy * r.h + rnd(-j, j);
    if (args.human) {
      if (opts.archive) log(`  click ${Math.round(x)},${Math.round(y)} (win ${r.x},${r.y},${r.w}x${r.h})`);
      let lastErr = null;
      for (let k = 0; k < 2; k++) {
        try {
          execFileSync('python3', [PY_MOUSE, '--x', x.toFixed(1), '--y', y.toFixed(1),
            '--button', opts.mouseButton === 'right' ? 'right' : 'left'], { timeout: 10000 });
          return;
        } catch (e) { lastErr = e; await pause(250, 550); }
      }
      throw lastErr;
    }
    await wx.click([Math.round(fx * s.w), Math.round(fy * s.h)], opts);
    return;
  } catch (e) {
    log('human click failed, fallback:', e.message.split('\n')[0]);
  }
  const s = await snap(wx);
  await wx.click([Math.round(fx * s.w), Math.round(fy * s.h)], opts);
}

async function shotFile(wx, name) {
  const s = await snap(wx);
  const p = path.resolve('data/shots', name);
  fs.writeFileSync(p, s.buf);
  return { ...s, p };
}

// 找绿色的“发送”按钮（输入框有文字时才会变绿）——深浅主题下都是绿色，比“亮像素”可靠
function findSendButton(shotPath, W, H) {
  const x0 = W - 130, y0 = H - 80, w = 130, h = 80;
  const raw = execFileSync('magick', [shotPath, '-crop', `${w}x${h}+${x0}+${y0}`, '+repage', '-depth', '8', 'rgb:-'], { maxBuffer: 32 << 20 });
  let sx = 0, sy = 0, c = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, r = raw[i], g = raw[i + 1], b = raw[i + 2];
      if (g > 100 && g > r * 1.25 && g > b * 1.15) { sx += x; sy += y; c++; }
    }
  }
  if (c < 60) return null;
  return { x: x0 + sx / c, y: y0 + sy / c };
}

async function clickPx(wx, px, py, opts = {}) {
  const s = opts.shot || await snap(wx);
  let r = opts.window === 'main' ? rectByName('微信') : opts.window === 'article' ? articleRect() : null;
  if (!r) r = winRectFor(s.w, s.h);
  try {
    execFileSync('python3', [PY_MOUSE, '--x', (r.x + px).toFixed(1), '--y', (r.y + py).toFixed(1),
      '--button', opts.mouseButton === 'right' ? 'right' : 'left'], { timeout: 10000 });
  } catch (e) { log('human click failed:', e.message.split('\n')[0]); throw e; }
}

async function clickScreen(x, y, opts = {}) {
  execFileSync('python3', [PY_MOUSE, '--x', x.toFixed(1), '--y', y.toFixed(1),
    '--button', opts.mouseButton === 'right' ? 'right' : 'left'], { timeout: 10000 });
}

// 关掉遗留的文章窗口（用红绿灯按钮，逐个数）
async function closeAllArticles(wx) {
  for (let k = 0; k < 5; k++) {
    const arts = winRects().filter(r => r.name !== '微信' && !r.name.startsWith('图片和视频') && r.w > 500 && r.h > 400);
    if (!arts.length) return;
    const a = arts[0];
    log(`  leftover article window ${a.name} ${a.w}x${a.h}, closing`);
    try { await clickScreen(a.x + 14, a.y + 13); } catch {}
    await pause(500, 900);
    if (winRects().some(r => r.name === a.name && r.w === a.w && r.h === a.h)) {
      try {
        sh('osascript', ['-e', `tell application "System Events" to tell process "WeChat" to perform action "AXRaise" of window "${a.name}"`]);
        await pause(200, 400);
        key('w', { cmd: true });
      } catch {}
      await pause(500, 900);
    }
    if (!winRects().some(r => r.name === a.name && r.w === a.w && r.h === a.h)) return;
  }
  throw new Error('cannot close leftover article window');
}

async function raiseMain() {
  try {
    sh('osascript', ['-e', 'tell application "System Events" to tell process "WeChat" to perform action "AXRaise" of window "微信"']);
  } catch (e) { log('  raiseMain warn:', e.message.split('\n')[0]); }
  await pause(250, 450);
}

async function clearInput(wx) {
  await clickFrac(wx, 0.707, 0.890, { window: 'main' });
  await pause(150, 350);
  key('a', { cmd: true });
  await pause(80, 180);
  key('delete');
  await pause(150, 300);
}

// 点“发送”按钮，并用发送按钮是否还绿着来验证（绿色=还有文字，灰色=已发出）
async function sendInput(wx, i) {
  const hasText = (s, p) => !!findSendButton(p, s.w, s.h);
  let s = await snap(wx);
  fs.writeFileSync('/tmp/_wxs.png', s.buf);
  if (!hasText(s, '/tmp/_wxs.png')) throw new Error('input empty after paste (focus lost?)');
  const p = '/tmp/_wxs.png';
  const btn = findSendButton(p, s.w, s.h);
  if (btn) await clickFrac(wx, btn.x / s.w, btn.y / s.h, { shot: s, jitter: 0, window: 'main' });
  else await clickFrac(wx, (s.w - 69) / s.w, (s.h - 43) / s.h, { shot: s, window: 'main' });
  await pause(600, 1000);
  s = await shotFile(wx, `i${i}-sent.png`);
  if (hasText(s, s.p)) {
    log('  发送按钮后还有文字，试 Cmd+Enter');
    key('return', { cmd: true });
    await pause(450, 800);
    s = await snap(wx); fs.writeFileSync('/tmp/_wxs.png', s.buf);
    if (hasText(s, '/tmp/_wxs.png')) {
      log('  仍没发出，试小键盘 Enter');
      key('enter');
      await pause(450, 800);
      s = await snap(wx); fs.writeFileSync('/tmp/_wxs.png', s.buf);
      if (hasText(s, '/tmp/_wxs.png')) throw new Error('message not sent (send button still green)');
    }
  }
  return s;
}

let lastShort = lastShort0;

async function runOne(wx, longUrl, i) {
  await closeAllArticles(wx);
  await activateWechat();
  await raiseMain();

  // 1. 发给文件传输助手（先清空输入框，粘贴后点“发送”并验证）
  await clearInput(wx);
  await pasteText(longUrl);
  await pause(150, 300);
  let s = await sendInput(wx, i);
  await pause(600, 1100);

  // 2. 点最新气泡
  s = await shotFile(wx, `i${i}-chat.png`);
  const by = findLastBubbleY(s.p, s.w, s.h);
  if (!by) throw new Error('no bubble found');
  await clickFrac(wx, (s.w - 150) / s.w, by / s.h, { shot: s, window: 'main' });
  await pause(900, 1700);

  // 3. 等文章窗口；如果没有（宽窗口会在右侧开分栏），点分栏右上角的“弹出”图标
  const findArt = () => articleRect();
  let artWin = null;
  for (let k = 0; k < 8; k++) {
    artWin = findArt();
    if (artWin) break;
    await pause(400, 800);
  }
  if (!artWin) {
    log('  article opened in split pane, popping out');
    const sm = await snap(wx);
    const mr = rectByName('微信'); await clickPx(wx, mr.w - 33, 20, { shot: sm, window: 'main' });
    for (let k = 0; k < 12; k++) {
      artWin = findArt();
      if (artWin) break;
      await pause(500, 900);
    }
  }
  if (!artWin) throw new Error('article window not opened');
  await pause(1600, 2800);
  try { execFileSync('pbcopy', [], { input: '__wxprobe_' + Date.now() }); } catch {}

  // 4. 右键标题 -> 复制链接
  let short = null;
  for (let attempt = 0; attempt < 2 && !short; attempt++) {
    await clickPx(wx, 200, 20, { mouseButton: 'right', window: 'article' });
    await pause(650, 1100);
    const menu = await shotFile(wx, `i${i}-menu${attempt}.png`);
    const ar = articleRect(); const pos = findCopyLinkY(menu.p, menu.w, menu.h, ar, 210);
    if (!pos) { key('escape'); await pause(350, 700); continue; }
    await clickPx(wx, pos.x, pos.y, { shot: menu, window: 'article' });
    await pause(550, 950);
    const clip = sh('pbpaste', []).trim();
    if (/^https?:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+$/.test(clip) && clip !== lastShort) short = clip;
    else { log('  菜单点击后剪贴板不是新短链:', clip.slice(0, 60)); key('escape'); await pause(350, 700); }
  }
  if (!short) throw new Error('copy link failed');

  // 5. 关闭文章窗口并确认回到聊天
  await pause(300, 800);
  await closeAllArticles(wx);
  await pause(400, 800);
  const back = await snap(wx);
  if (back.w > 600) throw new Error('article window did not close');
  return short;
}

await activateWechat();
const wx = await cua.getApp('WeChat');
await wx.getAXState({ disableDiffing: true });

let ok = 0, bad = 0, n = 0, consecFail = 0, consecCopy = 0;
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
let sincePause = 0;
let pauseAfter = randInt(args.everyMin || 1, args.everyMax || 1);
// 每处理 10–30 条随机休息 1–2 分钟，降低连续操作的账号风险
async function maybePause() {
  sincePause++;
  if (!args.everyMin) return;
  if (sincePause < pauseAfter) return;
  const sec = randInt(args.pauseMin, args.pauseMax);
  log(`  —— 随机休息 ${sec}s（已处理 ${sincePause} 条）`);
  await sleep(sec * 1000);
  log('  —— 休息结束，继续');
  sincePause = 0;
  pauseAfter = randInt(args.everyMin, args.everyMax);
}
for (let idx = args.start - 1; idx < entries.length; idx++) {
  const e = entries[idx];
  const label = e.seq;
  const isDone = e.id ? doneIds.has(e.id) : doneLongs.has(e.long);
  if (isDone) { log(`skip #${label}${e.id ? ' [' + e.id + ']' : ''} (done)`); continue; }
  if (e.id && deadIds.has(e.id)) { log(`dead #${label} [${e.id}] (已确认失效，跳过)`); continue; }
  if (args.limit && ok >= args.limit) break;   // --limit 数的是“本次成功拿到的篇数”
  n++;
  const nlong = normLong(e.long);
  if (dupShorts.has(nlong)) {
    const short = dupShorts.get(nlong);
    fs.appendFileSync(args.out, JSON.stringify({ i: label, seq: e.seq, id: e.id, title: e.title, long: e.long, short, dup: true, ts: new Date().toISOString() }) + '\n');
    ok++;
    log(`dup #${label}${e.id ? ' [' + e.id + ']' : ''} -> ${short}`);
    await maybePause();
    continue;
  }
  let short = null, err = null;
  for (let tryNo = 0; tryNo < 2 && !short; tryNo++) {
    try {
      short = await runOne(wx, e.long, label);
    } catch (ex) {
      err = ex.message;
      log(`  第 ${tryNo + 1} 次失败 #${label}: ${err}`);
      try { await closeAllArticles(wx); } catch {}
      await activateWechat();
      await pause(1200, 2200);
      // 取不到链接基本就是文章已被删除，再试一次也是白跑，直接标记后下一个
      if (err === 'copy link failed') break;
    }
  }
  if (short) {
    lastShort = short;
    const rec = { i: label, seq: e.seq, id: e.id, title: e.title, long: e.long, short, ts: new Date().toISOString() };
    fs.appendFileSync(args.out, JSON.stringify(rec) + '\n');
    dupShorts.set(nlong, short);
    consecFail = 0;
    consecCopy = 0;
    ok++;
    log(`ok #${label}${e.id ? ' [' + e.id + ']' : ''} -> ${short}`);
    try {
      for (const f of fs.readdirSync('data/shots')) {
        if (f.startsWith(`i${label}-`)) fs.rmSync(path.join('data/shots', f));
      }
    } catch {}
  } else {
    fs.appendFileSync(args.fail, JSON.stringify({ i: label, seq: e.seq, id: e.id, title: e.title, long: e.long, err, ts: new Date().toISOString() }) + '\n');
    bad++;
    const isCopy = err === 'copy link failed';
    if (isCopy) {
      const rec = { i: label, seq: e.seq, id: e.id, title: e.title, long: e.long, err, reason: 'deleted/no copy-link', ts: new Date().toISOString() };
      fs.appendFileSync(args.dead, JSON.stringify(rec) + '\n');
      if (e.id) deadIds.add(e.id);
      log(`  -> 已标记为失效文章 #${label}（以后跳过）`);
    }
    consecCopy = isCopy ? consecCopy + 1 : 0;
    consecFail = isCopy ? 0 : consecFail + 1;
    log(`FAIL #${label}${e.id ? ' [' + e.id + ']' : ''}: ${err} (连续取链接失败 ${consecCopy}，其他连续失败 ${consecFail})`);
    // “取不到链接”多半是文章已被发布者删除，不算系统故障；连成 50 条才认为是菜单/风控变了
    if (consecCopy >= 50) {
      log('连续 50 条取不到链接，停止运行，请检查菜单是否变化/是否被风控');
      process.exit(3);
    }
    if (consecFail >= 5) {
      log('连续 5 条其他失败，停止运行，请检查微信窗口/登录状态');
      process.exit(3);
    }
  }
  await pause(900, 2200);
  await maybePause();
}
log(`done ok=${ok} fail=${bad}`);
process.exit(0);
