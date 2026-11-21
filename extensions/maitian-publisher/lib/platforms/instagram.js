import { evaluate, setFiles, sleep, waitFor, typeLines, click, send } from '../cdp.js';

// Instagram 网页版：创建 → 帖子 → 选视频 → 比例「原版」→ 封面 → 配文 → （定时）→ 你点「分享」。
// 网页上传的视频一律按 Reels 发；前端上限 20 分钟、1GB（PolarisCreationConstants）。
// 界面中英文都认：L(中文, English)
const L = (...t) => t;
const DLG = `[...document.querySelectorAll('[role=dialog]')]`;
const dlgText = `${DLG}.map(d=>d.innerText).join('\\n')`;
// 文字等于其中之一的最后一个可见元素；xmax 限定横坐标（「帖子」在侧栏菜单和主页统计里都有）
const anyText = (texts, xmax = 1e5) => `(()=>{const want=${JSON.stringify(texts)};const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;const h=[];
  while((n=w.nextNode())) if(want.includes(n.nodeValue.trim())){const e=n.parentElement,r=e.getBoundingClientRect();if(r.width&&r.x<${xmax})h.push(e)}return h.at(-1)||null})()`;
const svg = (...labels) => `(${JSON.stringify(labels)}.map(l=>[...document.querySelectorAll('svg[aria-label="'+l+'"]')].filter(e=>e.getClientRects().length).at(-1)).find(Boolean)||null)`;
const CROP = svg('选择“裁剪”', 'Select crop', 'Select Crop');
const CAPTION = `document.querySelector('[role=dialog] [contenteditable=true]')`;

async function realClick(T, expr, what) {
  if (!await click(T, expr)) throw new Error(`找不到「${what}」`);
  await sleep(700);
}

// IG 网页 bug（2026-11-15 发现）：长视频上传前先查续传位置，PolarisInstajax 已把返回解析成对象，
// 上传代码又 JSON.parse(String(e)).offset → "[object Object]" 解析失败，界面只说「无法分享帖子」。
// 只在代码里确实还有这句时打补丁：把这个接口的返回转回 JSON 字符串。补丁随页面存在，刷新就没了。
const PATCH = `(async()=>{
  let m; try { m = require('PolarisInstajax'); } catch { return 'no-module'; }
  if (m.__maitianPatched) return 'already';
  const urls = performance.getEntriesByType('resource').map(e => e.name).filter(u => /\\.js(\\?|$)/.test(u));
  let buggy = false;
  for (const u of urls) { try { const t = await (await fetch(u, { cache: 'force-cache' })).text(); if (t.includes('rupload_igvideo/') && /JSON\\.parse\\(String\\(\\w\\)\\)\\.offset/.test(t)) { buggy = true; break; } } catch {} }
  if (!buggy) return 'fixed';
  const get = m.get_UNTYPED;
  m.get_UNTYPED = function (url) { const p = get.apply(this, arguments); return String(url).includes('rupload_igvideo') ? p.then(r => (r && typeof r === 'object') ? JSON.stringify(r) : r) : p; };
  m.__maitianPatched = true;
  return 'patched';
})()`;

// 定时：「定时发布内容」开关 → 日期（月历，按北京时间，浏览器时区就是本机时区）→ 时、分两个输入框（24 小时制）。
// 打开开关后右上角「分享」会变成「预设发布时间」，仍由你来点。
const SCHED_LABEL = anyText(L('定时发布内容', 'Schedule this post', 'Schedule post'));
const SWITCH = `(()=>{let c=${SCHED_LABEL};for(let i=0;i<4&&c;i++){c=c.parentElement;const b=c&&c.querySelector('input[role=switch],input[type=checkbox]');if(b)return b}return null})()`;
const HOURS = `document.querySelector('[role=dialog] input[aria-label=Hours]')`;
const MINUTES = `document.querySelector('[role=dialog] input[aria-label=Minutes]')`;
const CAL = `[...document.querySelectorAll('[role=dialog]')].find(d=>d.querySelector('[role=grid]'))`;

// 时、分是 role=spinbutton：值在 aria-valuenow，不认 insertText，要逐个按数字键
async function typeDigits(T, expr, digits) {
  await realClick(T, expr, '时间');
  for (const k of digits) {
    const base = { key: k, code: 'Digit' + k, windowsVirtualKeyCode: 48 + +k, nativeVirtualKeyCode: 48 + +k };
    await send(T, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: k });
    await send(T, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(120);
  }
  await sleep(300);
}

async function schedule(ctx) {
  const T = ctx.tabId, s = ctx.schedule;
  const on = await evaluate(T, `(()=>{const b=${SWITCH};return b?b.checked:null})()`);
  if (on === null) { ctx.fail('找不到「定时发布内容」开关，请手动设置定时'); return; }
  if (!on) await realClick(T, SWITCH, '定时发布内容');
  if (!await waitFor(T, `!!${HOURS}`, 8000)) { ctx.fail('打开定时后没出现时间输入框，请手动设置'); return; }

  // 日期：打开月历，翻到目标月份，点那一天（月历里前后会带上个月、下个月的几天，从本月 1 号开始找）
  const DATE_BTN = `[...document.querySelectorAll('[role=dialog] *')].filter(e=>e.childElementCount===0&&/^\\d{4}年\\d{1,2}月\\d{1,2}日|^[A-Z][a-z]+day, /.test(e.textContent.trim())).at(-1)`;
  await realClick(T, DATE_BTN, '日期');
  if (!await waitFor(T, `!!${CAL}`, 5000)) { ctx.fail('日历没打开，请手动选日期'); return; }
  const want = `${s.y}年${s.m}月`;
  for (let i = 0; i < 13; i++) {
    const head = await evaluate(T, `(${CAL}.innerText.match(/\\d{4}年\\d{1,2}月/)||[''])[0]`);
    if (head === want) break;
    await realClick(T, `document.querySelector('button[aria-label="Next month"], button[aria-label="下个月"]')`, '下个月');
  }
  const DAY = `(()=>{const c=[...${CAL}.querySelectorAll('[role=gridcell]')];const s=c.findIndex(e=>e.innerText.trim()==='1');return c.slice(s).find(e=>e.innerText.trim()==='${s.d}'&&e.getAttribute('aria-disabled')!=='true')||null})()`;
  if (!await click(T, DAY)) { ctx.fail(`日历里点不了 ${s.m} 月 ${s.d} 日（可能超出可定时范围）`); return; }
  await sleep(800);

  const p2 = (n) => String(n).padStart(2, '0');
  await typeDigits(T, HOURS, p2(s.hh));
  await typeDigits(T, MINUTES, p2(s.mm));
  await click(T, SCHED_LABEL);   // 让输入框失焦
  await sleep(600);

  const got = await evaluate(T, `(()=>{const t=${DLG}[0].innerText;const m=t.match(/(\\d{4})年(\\d{1,2})月(\\d{1,2})日/);return {d:m?[+m[1],+m[2],+m[3]].join('-'):'',h:${HOURS}.getAttribute('aria-valuenow'),mi:${MINUTES}.getAttribute('aria-valuenow')}})()`);
  const ok = got.d === `${s.y}-${s.m}-${s.d}` && +got.h === s.hh && +got.mi === s.mm;
  if (ok) ctx.log(`定时发布：${s.text}（右上角按钮已变成「预设发布时间」）`);
  else ctx.fail(`定时没设对：页面上是 ${got.d} ${got.h}:${got.mi}，应为 ${s.text}`);
}

export default {
  id: 'instagram',
  name: 'Instagram',
  url: 'https://www.instagram.com/',
  ready: `!!${svg('新帖子', 'New post')}`,

  async fill(ctx) {
    const { tabId: T, p } = ctx;
    await realClick(T, svg('新帖子', 'New post'), '创建');
    // 菜单有弹出动画：等「帖子」出现再停一下，否则坐标会落到下面的「广告」上（2026-11-15 误进了广告工具页）
    if (!await waitFor(T, `!!${anyText(L('帖子', 'Post'), 400)}`, 10000)) throw new Error('「新帖子」菜单没弹出来');
    await sleep(900);
    await realClick(T, anyText(L('帖子', 'Post'), 400), '帖子');
    if (!await waitFor(T, `!!document.querySelector('[role=dialog] input[type=file][accept*=video]')`, 20000)) throw new Error('「创建新帖子」窗口没打开');
    await setFiles(T, `document.querySelector('[role=dialog] input[type=file][accept*=video]')`, [ctx.video]);
    if (!await waitFor(T, `!!${CROP}`, 120000, 1000)) {
      const msg = await evaluate(T, dlgText);
      throw new Error(`视频没进到裁剪页：${(msg || '').replace(/\n/g, ' / ').slice(0, 120)}`);
    }
    ctx.log('视频已选（网页上传的视频按 Reels 发）');
    await sleep(1500);
    // 第一次发视频会弹「视频帖现在会以 Reels 的形式分享」
    if (await evaluate(T, `/Reels 的形式分享|shared as reels/i.test(${dlgText})`)) await realClick(T, anyText(L('确定', 'OK')), '确定');

    // 比例：原版（默认 1:1 会把横屏裁成方形）
    await realClick(T, CROP, '裁剪');
    await realClick(T, anyText(L('原版', 'Original')), '原版');
    await realClick(T, CROP, '裁剪');
    ctx.log('比例：原版（不裁）');

    await realClick(T, anyText(L('继续', 'Next')), '继续');
    if (!await waitFor(T, `/封面照片|Cover photo/i.test(${dlgText})`, 30000)) throw new Error('没进到编辑页（封面、修剪）');
    const cover = ctx.cover('ig') || ctx.cover('16x9') || ctx.cover('4x3');   // ig：中间放完整竖版封面的 16:9 图，主页网格裁成竖版也完整
    if (cover) {
      await setFiles(T, `document.querySelector('[role=dialog] input[type=file][accept="image/jpeg,image/png"]')`, [cover]);
      await sleep(3000);
      ctx.log(`封面：${cover.split('/').pop()}`);
    } else ctx.note('没有 16:9 封面，用的是视频里自动截的一帧');
    const sound = await evaluate(T, `(document.querySelector('[role=dialog] input[type=checkbox]')||{}).checked`);
    if (sound === false) ctx.fail('「打开声音」是关着的，发出去会没声音');

    await realClick(T, anyText(L('继续', 'Next')), '继续');
    if (!await waitFor(T, `!!${CAPTION}`, 30000)) throw new Error('没进到写配文这一步');
    await realClick(T, CAPTION, '配文框');
    await typeLines(T, p.caption);
    await sleep(800);
    // 结尾的 #话题 会弹联想框，点一下标题栏收起（按 Esc 会关掉整个窗口）
    await click(T, anyText(L('新 Reels', 'New reel', '创建新帖子', 'Create new post')));
    const got = await evaluate(T, `${CAPTION}.innerText`);
    const want = p.caption.replace(/\n+/g, '\n').trim(), have = (got || '').replace(/\n+/g, '\n').trim();
    if (have !== want) ctx.fail(`配文和素材不一致（页面 ${[...have].length} 字，应为 ${[...want].length} 字），请检查`);
    else ctx.log(`配文：${[...want].length} 字`);

    const patch = await evaluate(T, PATCH);
    if (patch === 'patched' || patch === 'already') ctx.log('已绕过 IG 网页长视频上传的 bug（不点就会「无法分享」）');
    else if (patch !== 'fixed') ctx.note(`没能检查 IG 上传 bug（${patch}），如果分享失败请告诉麦田`);

    if (ctx.schedule) await schedule(ctx);
    ctx.note(`点右上角「${ctx.schedule ? '预设发布时间' : '分享'}」后视频才开始上传，十几分钟的视频要传几分钟到二十多分钟，传完前别关这个页面`);
  },

  // 发布后回传链接：左侧栏头像 → 自己主页的 Reels 列表，逐条打开最近几条，配文第一行对上的就是这一期。
  // 定时中的 Reels 不在主页列表里，会返回「未找到」。
  links: {
    url: 'https://www.instagram.com/',
    ready: `!!${svg('新帖子', 'New post')}`,
    async collect(T, p) {
      const user = await evaluate(T, `(()=>{const i=[...document.querySelectorAll('a[href] img[alt]')].find(i=>/的头像|profile picture/i.test(i.alt)&&i.getBoundingClientRect().x<150);return i?i.closest('a').getAttribute('href').replace(/\\//g,''):null})()`);
      if (!user) return null;
      const head = [...p.caption.split('\n')[0].trim()].slice(0, 30).join('');
      await evaluate(T, `(location.href='/${user}/reels/',1)`);
      await sleep(2000);
      if (!await waitFor(T, `document.querySelectorAll('a[href*="/reel/"]').length>0`, 30000)) return null;
      const hrefs = await evaluate(T, `[...new Set([...document.querySelectorAll('a[href*="/reel/"]')].map(a=>a.getAttribute('href').replace(/^.*?(\\/reel\\/[^/]+\\/).*$/,'$1')))].slice(0,4)`);
      for (const h of hrefs) {
        await evaluate(T, `(location.href='${h}',1)`);
        await sleep(2000);
        if (await waitFor(T, `document.body.innerText.includes(${JSON.stringify(head)})`, 15000)) {
          return { status: '已发布', url: `https://www.instagram.com${h}` };
        }
      }
      return null;
    },
  },
};
