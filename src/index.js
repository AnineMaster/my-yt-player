const pathCache = new Map();
let cachedZipMap = null;

function getBotTokens(env) {
  return (env.BOT_TOKENS || env.BOT_TOKEN || "").split(",").map(s => s.trim()).filter(Boolean);
}

async function loadZipMap(origin, env) {
  if (cachedZipMap) return cachedZipMap;
  const res = await env.ASSETS.fetch(new Request(origin + "/site_upload.zip"));
  if (!res.ok) return null;

  const bytes = new Uint8Array(await res.arrayBuffer());
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const minPos = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const cdCount = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const map = new Map();
  const td = new TextDecoder();

  for (let idx = 0; idx < cdCount; idx++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);

    const rawName = td.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    p += 46 + nameLen + extraLen + commentLen;
    if (!rawName || rawName.endsWith("/")) continue;

    const lhNameLen = dv.getUint16(localOff + 26, true);
    const lhExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const slice = bytes.subarray(dataStart, dataStart + compSize);

    let outBytes;
    if (method === 0) {
      outBytes = slice;
    } else if (method === 8) {
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Response(slice).body.pipeThrough(ds);
      outBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      continue;
    }
    map.set("/" + rawName, td.decode(outBytes));
  }

  cachedZipMap = map;
  return map;
}

async function getSiteText(pathname, origin, env) {
  const zipMap = await loadZipMap(origin, env);
  if (zipMap && zipMap.has(pathname)) return zipMap.get(pathname);
  const asset = await env.ASSETS.fetch(new Request(origin + pathname));
  if (!asset.ok) return null;
  return await asset.text();
}

async function getTgFileUrl(fileId, botToken) {
  const key = `${botToken.slice(-8)}:${fileId}`;
  const now = Date.now();
  const cached = pathCache.get(key);
  if (cached && cached.exp > now) return cached.url;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const data = await res.json();
  if (!data.ok) throw new Error("getFile error");

  const dlUrl = `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
  pathCache.set(key, { url: dlUrl, exp: now + 50 * 60 * 1000 });
  return dlUrl;
}

function renderApp(catalog, activeItem) {
  const boot = JSON.stringify({ catalog, active: activeItem }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${activeItem.title.replace(/</g, "&lt;")}</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script src="https://cdn.jsdelivr.net/npm/mux.js@6.3.0/dist/mux.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--yt-red:#ff0033;--bg:#0f0f0f;--surface:#181818;--surface2:#272727;--text:#f1f1f1;--muted:#aaaaaa;--blue:#3ea6ff}
  body{background:var(--bg);color:var(--text);font-family:"Roboto","Inter",system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;min-height:100vh}
  .page{width:100%;max-width:1160px;padding:16px 16px 40px}
  .player{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:14px;overflow:hidden;user-select:none;box-shadow:0 20px 50px rgba(0,0,0,.65)}
  .player:fullscreen{border-radius:0}
  video{width:100%;height:100%;display:block;object-fit:contain;background:#000}
  .tap-flash{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(.7);width:68px;height:68px;border-radius:50%;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s}
  .tap-flash.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
  .seek-ripple{position:absolute;top:0;bottom:0;width:36%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:600;background:radial-gradient(circle,rgba(255,255,255,.16),transparent 70%);opacity:0;pointer-events:none;transition:opacity .25s}
  .seek-ripple.left{left:0;border-radius:0 50% 50% 0}
  .seek-ripple.right{right:0;border-radius:50% 0 0 50%}
  .seek-ripple.show{opacity:1}
  .spinner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:48px;height:48px;border:4px solid rgba(255,255,255,.22);border-top-color:#fff;border-radius:50%;animation:spin .75s linear infinite;display:none;pointer-events:none}
  @keyframes spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
  .controls{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,rgba(0,0,0,.65) 40%,rgba(0,0,0,.9));padding:36px 14px 10px;transition:opacity .22s;z-index:10}
  .controls.hide{opacity:0;pointer-events:none}
  .seek-area{position:relative;width:100%;height:18px;display:flex;align-items:center;cursor:pointer;margin-bottom:4px}
  .seek-track{position:relative;width:100%;height:4px;background:rgba(255,255,255,.24);border-radius:3px;transition:height .12s}
  .seek-area:hover .seek-track{height:6px}
  .seek-buf{position:absolute;left:0;top:0;bottom:0;background:rgba(255,255,255,.42);border-radius:3px;width:0%}
  .seek-prog{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#ff0033,#ff2e63);border-radius:3px;width:0%}
  .seek-thumb{position:absolute;top:50%;width:13px;height:13px;background:#ff0033;border-radius:50%;transform:translate(-50%,-50%) scale(0);transition:transform .12s;left:0%}
  .seek-area:hover .seek-thumb{transform:translate(-50%,-50%) scale(1)}
  .hover-tip{position:absolute;bottom:22px;transform:translateX(-50%);background:rgba(15,15,15,.92);color:#fff;padding:3px 7px;border-radius:5px;font-size:12px;font-weight:500;display:none;pointer-events:none}
  .ctrl-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .ctrl-left,.ctrl-right{display:flex;align-items:center;gap:6px}
  .ibtn{position:relative;background:none;border:none;color:#fff;width:38px;height:38px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s}
  .ibtn:hover{background:rgba(255,255,255,.12)}
  .ibtn svg{width:22px;height:22px;fill:currentColor;transition:transform .2s}
  .ibtn.open .gear-svg{transform:rotate(35deg)}
  .hd-tag{position:absolute;top:5px;right:2px;background:var(--yt-red);color:#fff;font-size:9px;font-weight:700;padding:1px 3.5px;border-radius:3px;line-height:1.1;display:none}
  .vol-wrap{display:flex;align-items:center;gap:4px}
  .vol-slider{width:0;opacity:0;accent-color:#fff;cursor:pointer;transition:width .18s,opacity .18s}
  .vol-wrap:hover .vol-slider{width:68px;opacity:1}
  .time-txt{font-size:13px;font-variant-numeric:tabular-nums;color:#f1f1f1;margin-left:6px;white-space:nowrap}
  .menu-wrap{position:relative}
  .yt-menu{position:absolute;right:0;bottom:48px;width:255px;background:rgba(22,22,26,.96);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:8px 0;display:none;box-shadow:0 12px 36px rgba(0,0,0,.6);z-index:30}
  .yt-menu.open{display:block}
  .ym-item{width:100%;background:none;border:none;color:var(--text);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;font-size:13.5px;cursor:pointer;text-align:left}
  .ym-item:hover{background:rgba(255,255,255,.09)}
  .ym-left{display:flex;align-items:center;gap:10px}
  .ym-right{display:flex;align-items:center;gap:4px;color:var(--muted);font-size:12.5px}
  .ym-head{padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.1);display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;cursor:pointer}
  .ym-list{max-height:240px;overflow-y:auto;padding-top:4px}
  .meta-wrap{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:14px;padding:16px 2px 10px}
  .v-title{font-size:20px;font-weight:700;letter-spacing:-.2px;margin-bottom:10px}
  .specs-row{display:flex;flex-wrap:wrap;gap:8px}
  .pill{background:var(--surface);border:1px solid rgba(255,255,255,.08);color:#d4d4d8;font-size:12.5px;padding:5px 11px;border-radius:16px;display:inline-flex;align-items:center;gap:5px}
  .pill b{color:#fff;font-weight:500}
  .action-btn{background:var(--surface2);color:#fff;border:1px solid rgba(255,255,255,.1);padding:10px 18px;border-radius:22px;font-size:14px;font-weight:500;display:inline-flex;align-items:center;gap:8px;cursor:pointer;transition:background .15s}
  .action-btn:hover{background:#3a3a3a}
  .action-btn svg{width:19px;height:19px;fill:currentColor}
  .switch-row{margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.08);display:flex;flex-wrap:wrap;gap:8px}
  .vchip{background:var(--surface);border:1px solid rgba(255,255,255,.08);color:#ccc;padding:7px 14px;border-radius:8px;font-size:13px;cursor:pointer;text-decoration:none}
  .vchip.active{background:#f1f1f1;color:#0f0f0f;font-weight:600}
  .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;padding:16px;z-index:100}
  .modal-bg.show{display:flex}
  .modal{width:100%;max-width:520px;background:#1a1a1f;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:20px;box-shadow:0 24px 60px rgba(0,0,0,.75);max-height:90vh;overflow-y:auto}
  .m-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  .m-title{font-size:17px;font-weight:600}
  .q-card{background:#23232a;border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:12px 14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:12px}
  .q-info h4{font-size:14.5px;margin-bottom:4px}
  .q-info p{font-size:12px;color:var(--muted);line-height:1.45}
  .q-dl-btn{background:var(--blue);color:#06121e;border:none;padding:8px 14px;border-radius:18px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
  .dl-box{background:#121217;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px;margin-top:12px;display:none}
  .dl-box.show{display:block}
  .pbar-bg{width:100%;height:8px;background:#2c2c35;border-radius:6px;overflow:hidden;margin:10px 0}
  .pbar-fill{width:0%;height:100%;background:linear-gradient(90deg,#3ea6ff,#22c55e);transition:width .2s}
  .dl-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .btn-s{padding:8px 13px;border-radius:18px;border:none;font-size:13px;font-weight:600;cursor:pointer}
  .btn-ok{background:#22c55e;color:#052e16}
  .btn-sec{background:#33333d;color:#fff}
  @media(max-width:640px){.vol-wrap{display:none}.v-title{font-size:17px}.page{padding:10px 10px 30px}}
</style>
</head>
<body>
<div class="page">
  <div class="player" id="pbox">
    <video id="video" playsinline></video>
    <div class="seek-ripple left" id="ripL">-10s</div>
    <div class="seek-ripple right" id="ripR">+10s</div>
    <div class="tap-flash" id="tapFlash"></div>
    <div class="spinner" id="spin"></div>

    <div class="controls" id="ctrls">
      <div class="seek-area" id="seekArea">
        <div class="hover-tip" id="hoverTip">0:00</div>
        <div class="seek-track">
          <div class="seek-buf" id="sbuf"></div>
          <div class="seek-prog" id="sprog"></div>
          <div class="seek-thumb" id="sthumb"></div>
        </div>
      </div>

      <div class="ctrl-row">
        <div class="ctrl-left">
          <button class="ibtn" id="playBtn" onclick="togglePlay()" aria-label="Play"></button>
          <div class="vol-wrap">
            <button class="ibtn" id="muteBtn" onclick="toggleMute()" aria-label="Mute"></button>
            <input class="vol-slider" id="volRange" type="range" min="0" max="1" step="0.05" value="1" oninput="setVol(this.value)">
          </div>
          <span class="time-txt" id="timeTxt">0:00 / 0:00</span>
        </div>

        <div class="ctrl-right">
          <div class="menu-wrap">
            <button class="ibtn" id="gearBtn" onclick="toggleGear(event)" aria-label="Settings">
              <svg class="gear-svg" viewBox="0 0 24 24"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></svg>
              <span class="hd-tag" id="hdTag">HD</span>
            </button>
            <div class="yt-menu" id="ytMenu"></div>
          </div>
          <button class="ibtn" id="fsBtn" onclick="toggleFS()" aria-label="Fullscreen"></button>
        </div>
      </div>
    </div>
  </div>

  <div class="meta-wrap">
    <div style="flex:1;min-width:240px">
      <div class="v-title" id="vTitle"></div>
      <div class="specs-row" id="specsRow"></div>
    </div>
    <button class="action-btn" onclick="openDlModal()">
      <svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>
      <span>Download</span>
    </button>
  </div>

  <div class="switch-row" id="switchRow" style="display:none"></div>
</div>

<div class="modal-bg" id="dlModal">
  <div class="modal">
    <div class="m-top">
      <div class="m-title">Download Quality & Specs (.MP4)</div>
      <button class="ibtn" onclick="closeDlModal()" aria-label="Close">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
    <div id="qCards"></div>
    <div class="dl-box" id="dlBox">
      <div style="display:flex;justify-content:space-between;font-size:13px">
        <strong id="dlName">Preparing...</strong>
        <span id="dlPct">0%</span>
      </div>
      <div class="pbar-bg"><div class="pbar-fill" id="dlBar"></div></div>
      <div id="dlStat" style="font-size:12px;color:#aaa">Initializing...</div>
      <div class="dl-actions">
        <button class="btn-s btn-sec" id="pauseBtn" onclick="togglePauseDl()">Pause</button>
        <button class="btn-s btn-ok" onclick="savePartialNow()">Save Current % (.mp4)</button>
        <button class="btn-s btn-sec" onclick="resetDl()">Clear</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-bg" id="discModal" style="z-index:120">
  <div class="modal" style="max-width:430px">
    <div class="m-top"><div class="m-title" style="color:#f59e0b">Internet Disconnected</div></div>
    <p id="discMsg" style="font-size:13.5px;color:#d4d4d8;line-height:1.55;margin-bottom:16px"></p>
    <div class="dl-actions" style="justify-content:flex-end">
      <button class="btn-s btn-sec" onclick="closeDiscModal()">Wait / Resume Later</button>
      <button class="btn-s btn-ok" onclick="confirmDisconnectSave()">OK, Save .MP4 Part</button>
    </div>
  </div>
</div>

<script>
const BOOT = ${boot};
const ITEM = BOOT.active;

const SVG = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>',
  fs: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  fsExit: '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
  check: '<svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  chevR: '<svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>',
  chevL: '<svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>',
  tune: '<svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>',
  speed: '<svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor"><path d="M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z"/></svg>'
};

const video = document.getElementById("video");
const pbox = document.getElementById("pbox");
const ctrls = document.getElementById("ctrls");
const spin = document.getElementById("spin");
const playBtn = document.getElementById("playBtn");
const muteBtn = document.getElementById("muteBtn");
const fsBtn = document.getElementById("fsBtn");
const timeTxt = document.getElementById("timeTxt");
const sprog = document.getElementById("sprog");
const sbuf = document.getElementById("sbuf");
const sthumb = document.getElementById("sthumb");
const hoverTip = document.getElementById("hoverTip");
const ytMenu = document.getElementById("ytMenu");
const gearBtn = document.getElementById("gearBtn");
const hdTag = document.getElementById("hdTag");
const specsRow = document.getElementById("specsRow");

playBtn.innerHTML = SVG.play;
muteBtn.innerHTML = SVG.vol;
fsBtn.innerHTML = SVG.fs;
document.getElementById("vTitle").textContent = ITEM.title;

if (BOOT.catalog.length > 1) {
  const sw = document.getElementById("switchRow");
  sw.style.display = "flex";
  BOOT.catalog.forEach(v => {
    const a = document.createElement("a");
    a.className = "vchip" + (v.id === ITEM.id ? " active" : "");
    a.href = "?v=" + encodeURIComponent(v.id);
    a.textContent = v.title;
    sw.appendChild(a);
  });
}

let hls = null, manualMode = false, menuView = "main", hideTimer = null, dlJsonMeta = null, totalDur = 0;

function fmtBytes(b){
  if(!b) return "0 B";
  const u=["B","KB","MB","GB"]; let i=0;
  while(b>=1024 && i<3){ b/=1024; i++; }
  return b.toFixed(2)+" "+u[i];
}
function fmtTime(sec){
  if(!isFinite(sec)) return "0:00";
  sec = Math.floor(sec);
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  const ss = s<10 ? "0"+s : ""+s;
  return h>0 ? h+":"+(m<10?"0"+m:m)+":"+ss : m+":"+ss;
}

if (ITEM.has_download) {
  fetch("videos/" + ITEM.id + "/download.json").then(r=>r.json()).then(d=>{ dlJsonMeta = d; renderSpecs(); }).catch(()=>{});
}

function renderSpecs(){
  if (!hls || !hls.levels.length) return;
  const idx = hls.currentLevel >= 0 ? hls.currentLevel : (hls.loadLevel >= 0 ? hls.loadLevel : 0);
  const lvl = hls.levels[idx] || hls.levels[0];
  const estBw = hls.bandwidthEstimate ? (hls.bandwidthEstimate / 1e6).toFixed(1) + " Mbps" : "Measuring...";
  const chips = [
    "Resolution: <b>" + lvl.width + "x" + lvl.height + " (" + lvl.height + "p)</b>",
    "Mode: <b>" + (manualMode ? "Manual Locked" : "Auto ABR") + "</b>",
    "Bitrate: <b>" + (lvl.bitrate / 1e6).toFixed(2) + " Mbps</b>",
    "Codec: <b>" + (lvl.videoCodec || "H.264") + "</b>",
    "Net Speed: <b>" + estBw + "</b>"
  ];
  if (totalDur) chips.push("Duration: <b>" + fmtTime(totalDur) + "</b>");
  if (dlJsonMeta) chips.push("MP4 Size: <b>" + fmtBytes(dlJsonMeta.total_bytes) + "</b>");
  specsRow.innerHTML = chips.map(c => '<span class="pill">' + c + '</span>').join("");

  if (lvl.height >= 2000) { hdTag.textContent = "4K"; hdTag.style.display = "block"; }
  else if (lvl.height >= 720) { hdTag.textContent = "HD"; hdTag.style.display = "block"; }
  else { hdTag.style.display = "none"; }
}

function renderMenu(){
  if (!hls) return;
  const curIdx = hls.currentLevel >= 0 ? hls.currentLevel : (hls.loadLevel >= 0 ? hls.loadLevel : 0);
  const curLvl = hls.levels[curIdx] || { height: "" };
  const qLabel = manualMode ? (curLvl.height + "p") : ("Auto (" + curLvl.height + "p)");

  if (menuView === "main") {
    ytMenu.innerHTML =
      '<button class="ym-item" onclick="openSub(\'speed\',event)"><span class="ym-left">' + SVG.speed + ' Playback speed</span><span class="ym-right">' + (video.playbackRate===1?"Normal":video.playbackRate+"x") + SVG.chevR + '</span></button>' +
      '<button class="ym-item" onclick="openSub(\'quality\',event)"><span class="ym-left">' + SVG.tune + ' Quality</span><span class="ym-right">' + qLabel + SVG.chevR + '</span></button>';
  } else if (menuView === "quality") {
    let html = '<div class="ym-head" onclick="openSub(\'main\',event)">' + SVG.chevL + ' Quality</div><div class="ym-list">';
    html += '<button class="ym-item" onclick="pickQuality(-1)"><span>Auto (Internet Speed)</span><span>' + (!manualMode ? SVG.check : "") + '</span></button>';
    const sorted = hls.levels.map((l,i)=>({l,i})).sort((a,b)=>b.l.height - a.l.height);
    sorted.forEach(({l,i}) => {
      const tag = l.height >= 2000 ? " 4K" : (l.height >= 1000 ? " HD" : "");
      html += '<button class="ym-item" onclick="pickQuality(' + i + ')"><span>' + l.height + 'p' + tag + ' <span style="color:#888;font-size:11px">' + (l.bitrate/1e6).toFixed(1) + 'M</span></span><span>' + (manualMode && hls.currentLevel===i ? SVG.check : "") + '</span></button>';
    });
    ytMenu.innerHTML = html + '</div>';
  } else if (menuView === "speed") {
    let html = '<div class="ym-head" onclick="openSub(\'main\',event)">' + SVG.chevL + ' Playback speed</div><div class="ym-list">';
    [0.5, 0.75, 1, 1.25, 1.5, 2].forEach(sp => {
      html += '<button class="ym-item" onclick="pickSpeed(' + sp + ')"><span>' + (sp===1?"Normal":sp+"x") + '</span><span>' + (video.playbackRate===sp ? SVG.check : "") + '</span></button>';
    });
    ytMenu.innerHTML = html + '</div>';
  }
}

function openSub(v, e){ e.stopPropagation(); menuView = v; renderMenu(); }
function toggleGear(e){ e.stopPropagation(); menuView = "main"; ytMenu.classList.toggle("open"); gearBtn.classList.toggle("open", ytMenu.classList.contains("open")); if (ytMenu.classList.contains("open")) renderMenu(); }
function pickSpeed(sp){ video.playbackRate = sp; ytMenu.classList.remove("open"); gearBtn.classList.remove("open"); }
function pickQuality(idx){
  if (idx === -1) {
    manualMode = false;
    hls.currentLevel = -1; hls.nextLevel = -1; hls.loadLevel = -1;
  } else {
    manualMode = true;
    hls.currentLevel = idx; hls.nextLevel = idx; hls.loadLevel = idx;
  }
  ytMenu.classList.remove("open"); gearBtn.classList.remove("open");
  renderSpecs();
}

const m3u8Url = "videos/" + ITEM.id + "/master.m3u8";
if (Hls.isSupported()) {
  hls = new Hls({
    enableWorker: true, maxBufferLength: 12, maxMaxBufferLength: 24, backBufferLength: 10,
    maxBufferSize: 35000000, abrEwmaDefaultEstimate: 500000, abrBandWidthFactor: 0.9,
    abrBandWidthUpFactor: 0.7, capLevelToPlayerSize: false, fragLoadingMaxRetry: 6
  });
  hls.loadSource(m3u8Url);
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => renderSpecs());
  hls.on(Hls.Events.LEVEL_LOADED, (_, d) => { if (d.details && d.details.totalduration) { totalDur = d.details.totalduration; renderSpecs(); } });
  hls.on(Hls.Events.LEVEL_SWITCHED, () => { renderSpecs(); if (ytMenu.classList.contains("open")) renderMenu(); });
  hls.on(Hls.Events.FRAG_LOADED, () => renderSpecs());
  let retries = 0;
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (data.fatal) {
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retries < 5) { retries++; hls.startLoad(); }
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    }
  });
}

function togglePlay(){
  if (video.paused) { video.play(); flashTap(SVG.play); }
  else { video.pause(); flashTap(SVG.pause); }
}
function flashTap(svgHtml){
  const el = document.getElementById("tapFlash");
  el.innerHTML = svgHtml; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 320);
}
function toggleMute(){ video.muted = !video.muted; muteBtn.innerHTML = video.muted ? SVG.mute : SVG.vol; }
function setVol(v){ video.volume = v; video.muted = (v == 0); muteBtn.innerHTML = video.muted ? SVG.mute : SVG.vol; }
function toggleFS(){
  if (!document.fullscreenElement) (pbox.requestFullscreen || pbox.webkitRequestFullscreen).call(pbox);
  else (document.exitFullscreen || document.webkitExitFullscreen).call(document);
}

document.addEventListener("fullscreenchange", () => { fsBtn.innerHTML = document.fullscreenElement ? SVG.fsExit : SVG.fs; });
video.addEventListener("play", () => playBtn.innerHTML = SVG.pause);
video.addEventListener("pause", () => playBtn.innerHTML = SVG.play);
video.addEventListener("waiting", () => spin.style.display = "block");
video.addEventListener("playing", () => spin.style.display = "none");
video.addEventListener("canplay", () => spin.style.display = "none");
video.addEventListener("timeupdate", () => {
  timeTxt.textContent = fmtTime(video.currentTime) + " / " + fmtTime(video.duration);
  if (video.duration) {
    const p = ((video.currentTime / video.duration) * 100) + "%";
    sprog.style.width = p; sthumb.style.left = p;
  }
});
video.addEventListener("progress", () => {
  if (video.duration && video.buffered.length) sbuf.style.width = ((video.buffered.end(video.buffered.length - 1) / video.duration) * 100) + "%";
});

let lastTap = 0;
video.addEventListener("click", (e) => {
  ytMenu.classList.remove("open"); gearBtn.classList.remove("open");
  const now = Date.now(), rect = pbox.getBoundingClientRect(), xPct = (e.clientX - rect.left) / rect.width;
  if (now - lastTap < 280) {
    if (xPct < 0.38) { video.currentTime = Math.max(0, video.currentTime - 10); showRipple("ripL"); }
    else if (xPct > 0.62) { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); showRipple("ripR"); }
    else togglePlay();
    lastTap = 0;
  } else {
    lastTap = now;
    setTimeout(() => { if (lastTap !== 0 && Date.now() - lastTap >= 260) { togglePlay(); lastTap = 0; } }, 270);
  }
});
function showRipple(id){ const el = document.getElementById(id); el.classList.add("show"); setTimeout(()=>el.classList.remove("show"), 450); }

const seekArea = document.getElementById("seekArea");
seekArea.addEventListener("mousemove", (e) => {
  if (!video.duration) return;
  const rect = seekArea.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  hoverTip.style.display = "block";
  hoverTip.style.left = (pct * 100) + "%";
  hoverTip.textContent = fmtTime(pct * video.duration);
});
seekArea.addEventListener("mouseleave", () => hoverTip.style.display = "none");
seekArea.addEventListener("click", (e) => {
  if (!video.duration) return;
  const rect = seekArea.getBoundingClientRect();
  video.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * video.duration;
});

function showCtrls(){
  ctrls.classList.remove("hide"); clearTimeout(hideTimer);
  if (!video.paused) hideTimer = setTimeout(() => { if (!ytMenu.classList.contains("open")) ctrls.classList.add("hide"); }, 2600);
}
pbox.addEventListener("mousemove", showCtrls);
pbox.addEventListener("touchstart", showCtrls);
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) { ytMenu.classList.remove("open"); gearBtn.classList.remove("open"); } });
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
  else if (e.key === "f") toggleFS();
  else if (e.key === "m") toggleMute();
  else if (e.key === "ArrowRight") video.currentTime += 5;
  else if (e.key === "ArrowLeft") video.currentTime -= 5;
});

let dlState = {
  active: false, paused: false, abortCtrl: null, fh: null, writable: null,
  memChunks: [], transmuxer: null, pendingOut: [], useMux: false, wroteInit: false,
  urls: [], filename: "", key: "", idx: 0, total: 0, bytes: 0
};

function createMuxer(){
  if (typeof muxjs === "undefined") return null;
  const tm = new muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: true });
  tm.on("data", (seg) => {
    if (!dlState.wroteInit && seg.initSegment && seg.initSegment.byteLength > 0) {
      dlState.pendingOut.push(seg.initSegment);
      dlState.wroteInit = true;
    }
    if (seg.data && seg.data.byteLength > 0) dlState.pendingOut.push(seg.data);
  });
  return tm;
}

function openDlModal(){
  document.getElementById("dlModal").classList.add("show");
  const box = document.getElementById("qCards");
  box.innerHTML = "";
  const safeTitle = (ITEM.title || ITEM.id).replace(/[^a-zA-Z0-9 _.-]/g, "").trim();

  if (dlJsonMeta) {
    const fn = dlJsonMeta.filename || (safeTitle + ".mp4");
    const c = document.createElement("div");
    c.className = "q-card";
    c.innerHTML = '<div class="q-info"><h4>Original Master (.mp4)</h4><p>File: ' + fn + '<br>Exact Size: ' + fmtBytes(dlJsonMeta.total_bytes) + ' • Resume & Any-% Save</p></div>';
    const b = document.createElement("button"); b.className = "q-dl-btn"; b.textContent = "Download MP4";
    b.onclick = () => startSmartDl("orig_mp4", fn, dlJsonMeta.parts.map(p => "/c?b=" + p.b + "&id=" + encodeURIComponent(p.id)), false);
    c.appendChild(b);
    box.appendChild(c);
  }

  if (hls && hls.levels.length) {
    const sorted = hls.levels.map((l,i)=>({l,i})).sort((a,b)=>b.l.height - a.l.height);
    sorted.forEach(({l}) => {
      const qTag = l.height >= 2000 ? "4K" : (l.height + "p");
      const fn = safeTitle + "_" + qTag + ".mp4";
      const estBytes = totalDur ? Math.round((l.bitrate / 8) * totalDur) : 0;
      const c = document.createElement("div");
      c.className = "q-card";
      c.innerHTML = '<div class="q-info"><h4>' + qTag + ' (' + l.width + 'x' + l.height + ')</h4><p>File: ' + fn + '<br>' + (l.bitrate/1e6).toFixed(2) + ' Mbps • ' + (l.videoCodec || "H.264") + (estBytes ? ' • Est. ~' + fmtBytes(estBytes) : '') + ' • Auto MP4</p></div>';
      const b = document.createElement("button"); b.className = "q-dl-btn"; b.textContent = "Download " + qTag;
      b.onclick = () => startHlsQualityDl(qTag, fn, l.url[0]);
      c.appendChild(b);
      box.appendChild(c);
    });
  }
}

function closeDlModal(){ document.getElementById("dlModal").classList.remove("show"); }
function closeDiscModal(){ document.getElementById("discModal").classList.remove("show"); }

async function startHlsQualityDl(qKey, filename, m3u8Url){
  document.getElementById("dlBox").classList.add("show");
  document.getElementById("dlStat").textContent = "Loading chunk list...";
  const txt = await (await fetch(m3u8Url)).text();
  const base = new URL(m3u8Url, location.href);
  const segUrls = txt.split(/\\r?\\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#")).map(u => new URL(u, base).href);
  await startSmartDl(qKey, filename, segUrls, true);
}

async function startSmartDl(qKey, filename, urls, useMux){
  if (dlState.active) { dlState.paused = true; if (dlState.abortCtrl) dlState.abortCtrl.abort(); await commitWritable(); }
  const storeKey = "opfs_" + ITEM.id + "_" + qKey;
  const saved = JSON.parse(localStorage.getItem(storeKey) || '{"idx":0,"bytes":0}');

  dlState = {
    active: true, paused: false, abortCtrl: null, fh: null, writable: null, memChunks: [],
    transmuxer: null, pendingOut: [], useMux: useMux, wroteInit: (saved.bytes || 0) > 0,
    urls, filename: saved.filename || filename, key: storeKey, idx: saved.idx || 0, total: urls.length,
    bytes: saved.bytes || 0
  };
  if (saved.useMux !== undefined && dlState.idx > 0) dlState.useMux = saved.useMux;
  if (dlState.useMux) dlState.transmuxer = createMuxer();

  document.getElementById("dlBox").classList.add("show");
  document.getElementById("dlName").textContent = dlState.filename;
  document.getElementById("pauseBtn").textContent = "Pause";

  if (navigator.storage && navigator.storage.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      dlState.fh = await root.getFileHandle(storeKey + ".part", { create: true });
      const existing = await dlState.fh.getFile();
      if (existing.size !== dlState.bytes) {
        dlState.bytes = 0; dlState.idx = 0; dlState.wroteInit = false;
        localStorage.setItem(storeKey, JSON.stringify({ idx: 0, bytes: 0, useMux: dlState.useMux, filename: dlState.filename }));
      }
      dlState.writable = await dlState.fh.createWritable({ keepExistingData: dlState.bytes > 0 });
      if (dlState.bytes > 0) await dlState.writable.seek(dlState.bytes);
    } catch { dlState.fh = null; dlState.writable = null; }
  }
  runDlLoop();
}

function updateDlUI(msg){
  const pct = dlState.total ? Math.min(100, Math.round((dlState.idx / dlState.total) * 100)) : 0;
  document.getElementById("dlPct").textContent = pct + "%";
  document.getElementById("dlBar").style.width = pct + "%";
  document.getElementById("dlStat").textContent = msg + " (" + fmtBytes(dlState.bytes) + " • Chunk " + dlState.idx + "/" + dlState.total + ")";
}

async function commitWritable(){
  if (dlState.writable) { try { await dlState.writable.close(); } catch {} dlState.writable = null; }
}

async function writeChunkData(buf){
  const u8 = new Uint8Array(buf);
  if (dlState.useMux && dlState.transmuxer) {
    dlState.pendingOut = [];
    dlState.transmuxer.push(u8);
    dlState.transmuxer.flush();
    if (dlState.idx === 0 && dlState.pendingOut.length === 0) {
      dlState.useMux = false;
      dlState.filename = dlState.filename.replace(/\\.mp4$/i, ".ts");
      document.getElementById("dlName").textContent = dlState.filename;
      if (dlState.writable) await dlState.writable.write(u8);
      else dlState.memChunks.push(u8);
      dlState.bytes += u8.byteLength;
      return;
    }
    for (const part of dlState.pendingOut) {
      if (dlState.writable) await dlState.writable.write(part);
      else dlState.memChunks.push(part);
      dlState.bytes += part.byteLength;
    }
    dlState.pendingOut = [];
  } else {
    if (dlState.writable) await dlState.writable.write(u8);
    else dlState.memChunks.push(u8);
    dlState.bytes += u8.byteLength;
  }
}

async function runDlLoop(){
  updateDlUI(dlState.idx > 0 ? "Resuming MP4" : "Downloading & Converting to MP4");
  const tStart = Date.now();
  let sessionBytes = 0;

  while (dlState.idx < dlState.total && !dlState.paused) {
    dlState.abortCtrl = new AbortController();
    let ok = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (dlState.paused) break;
      try {
        const res = await fetch(dlState.urls[dlState.idx], { signal: dlState.abortCtrl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = await res.arrayBuffer();
        await writeChunkData(buf);
        sessionBytes += buf.byteLength;
        dlState.idx++;
        localStorage.setItem(dlState.key, JSON.stringify({ idx: dlState.idx, bytes: dlState.bytes, useMux: dlState.useMux, filename: dlState.filename }));
        const mbps = ((sessionBytes / 1048576) / Math.max(0.5, (Date.now() - tStart) / 1000)).toFixed(1);
        updateDlUI("MP4 Ready Speed: " + mbps + " MB/s");
        ok = true;
        break;
      } catch {
        if (dlState.paused || !navigator.onLine) break;
        await new Promise(r => setTimeout(r, 1200));
      }
    }

    if (!ok && !dlState.paused) {
      dlState.paused = true;
      await commitWritable();
      document.getElementById("pauseBtn").textContent = "Resume";
      const pct = Math.round((dlState.idx / dlState.total) * 100);
      updateDlUI("Paused (Connection Lost)");
      document.getElementById("discMsg").textContent =
        "Internet disconnect ho gaya! Aapka " + pct + "% (" + fmtBytes(dlState.bytes) + ") MP4 format me safely save hai. Kya aap itna downloaded .mp4 abhi device me save karna chahte hain?";
      document.getElementById("discModal").classList.add("show");
      return;
    }
  }

  if (dlState.idx >= dlState.total) {
    await commitWritable();
    dlState.active = false;
    updateDlUI("100% Complete! Saving MP4...");
    await exportSavedFile(dlState.filename);
    await resetDl();
  }
}

window.addEventListener("offline", async () => {
  if (dlState.active && !dlState.paused) {
    dlState.paused = true;
    if (dlState.abortCtrl) dlState.abortCtrl.abort();
  }
});

async function togglePauseDl(){
  if (!dlState.active) return;
  if (!dlState.paused) {
    dlState.paused = true;
    if (dlState.abortCtrl) dlState.abortCtrl.abort();
    await commitWritable();
    document.getElementById("pauseBtn").textContent = "Resume";
    updateDlUI("Paused");
  } else {
    dlState.paused = false;
    document.getElementById("pauseBtn").textContent = "Pause";
    if (!dlState.transmuxer && dlState.useMux) dlState.transmuxer = createMuxer();
    if (dlState.fh && !dlState.writable) {
      dlState.writable = await dlState.fh.createWritable({ keepExistingData: dlState.bytes > 0 });
      if (dlState.bytes > 0) await dlState.writable.seek(dlState.bytes);
    }
    runDlLoop();
  }
}

async function savePartialNow(){
  if (dlState.bytes <= 0) return alert("Abhi 0 bytes download hue hain!");
  if (!dlState.paused) {
    dlState.paused = true;
    if (dlState.abortCtrl) dlState.abortCtrl.abort();
    await commitWritable();
    document.getElementById("pauseBtn").textContent = "Resume";
  }
  const pct = Math.round((dlState.idx / dlState.total) * 100);
  const dot = dlState.filename.lastIndexOf(".");
  const partialName = pct < 100 ? (dlState.filename.slice(0, dot) + "_" + pct + "pct" + dlState.filename.slice(dot)) : dlState.filename;
  await exportSavedFile(partialName);
}

async function confirmDisconnectSave(){ closeDiscModal(); await savePartialNow(); }

async function exportSavedFile(saveAs){
  const blob = dlState.fh ? await dlState.fh.getFile() : new Blob(dlState.memChunks, { type: "video/mp4" });
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u; a.download = saveAs;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

async function resetDl(){
  dlState.paused = true; dlState.active = false;
  if (dlState.abortCtrl) dlState.abortCtrl.abort();
  await commitWritable();
  if (dlState.key) localStorage.removeItem(dlState.key);
  if (dlState.fh && navigator.storage && navigator.storage.getDirectory) {
    try { const root = await navigator.storage.getDirectory(); await root.removeEntry(dlState.key + ".part"); } catch {}
  }
  dlState.memChunks = []; dlState.bytes = 0; dlState.idx = 0; dlState.wroteInit = false; dlState.transmuxer = null;
  document.getElementById("dlBar").style.width = "0%";
  document.getElementById("dlPct").textContent = "0%";
  document.getElementById("dlStat").textContent = "Cleared.";
}
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname === "/site_upload.zip" || url.pathname === "/videos.json") {
      return new Response("Forbidden", { status: 403 });
    }

    if (url.pathname === "/") {
      const txt = await getSiteText("/videos.json", url.origin, env);
      if (!txt) return new Response("Catalog missing (site_upload.zip upload karein)", { status: 500 });
      const catalog = JSON.parse(txt);
      const vid = url.searchParams.get("v") || (catalog[0] && catalog[0].id);
      const item = catalog.find(x => x.id === vid) || catalog[0];
      if (!item) return new Response("No videos", { status: 404 });

      return new Response(renderApp(catalog, item), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname.endsWith(".m3u8")) {
      const txt = await getSiteText(url.pathname, url.origin, env);
      if (!txt) return new Response("Playlist not found", { status: 404 });
      const fixed = txt.replace(/https?:\/\/[^\/\r\n]+\/c\?/g, url.origin + "/c?");
      return new Response(fixed, {
        headers: { ...cors, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname.endsWith("/download.json")) {
      const txt = await getSiteText(url.pathname, url.origin, env);
      if (!txt) return new Response("Not found", { status: 404 });
      return new Response(txt, { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const tokens = getBotTokens(env);

    if (url.pathname === "/c") {
      const id = url.searchParams.get("id");
      const b = parseInt(url.searchParams.get("b") || "0", 10);
      const token = tokens[b] || tokens[0];
      if (!id || !token) return new Response("Bad request", { status: 400 });

      const tgUrl = await getTgFileUrl(id, token);
      const tgRes = await fetch(tgUrl);
      if (!tgRes.ok) return new Response("Upstream error", { status: 502 });

      return new Response(tgRes.body, {
        status: 200,
        headers: { ...cors, "Content-Type": "video/mp2t", "Cache-Control": "public, max-age=86400" },
      });
    }

    if (url.pathname === "/dl") {
      const manifestUrl = url.searchParams.get("manifest");
      if (!manifestUrl) return new Response("Missing manifest", { status: 400 });
      const mPath = new URL(manifestUrl).pathname;
      const txt = await getSiteText(mPath, url.origin, env);
      if (!txt) return new Response("Manifest not found", { status: 404 });
      const meta = JSON.parse(txt);
      const filename = (url.searchParams.get("name") || meta.filename || "video.mp4").replace(/["\\/\r\n]/g, "_");
      const total = meta.total_bytes;

      let start = 0, end = total - 1, isRange = false;
      const rangeHdr = request.headers.get("Range");
      if (rangeHdr && rangeHdr.startsWith("bytes=")) {
        const [sStr, eStr] = rangeHdr.slice(6).split("-");
        if (sStr === "" && eStr) start = Math.max(0, total - parseInt(eStr, 10));
        else { start = parseInt(sStr || "0", 10); if (eStr) end = Math.min(total - 1, parseInt(eStr, 10)); }
        isRange = true;
      }
      if (start >= total || start > end) {
        return new Response(null, { status: 416, headers: { ...cors, "Content-Range": `bytes */${total}` } });
      }
      const contentLen = end - start + 1;
      const baseHeaders = {
        ...cors, "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "ETag": `"${total}"`,
        "Content-Length": String(contentLen), "Content-Disposition": `attachment; filename="${filename}"`,
        ...(isRange ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
      };
      if (request.method === "HEAD") return new Response(null, { status: isRange ? 206 : 200, headers: baseHeaders });

      const { readable, writable } = new TransformStream();
      (async () => {
        const writer = writable.getWriter();
        try {
          let partOffset = 0;
          for (const part of meta.parts) {
            const pStart = partOffset, pEnd = partOffset + part.size - 1;
            partOffset += part.size;
            if (pEnd < start) continue;
            if (pStart > end) break;
            const skipStart = Math.max(0, start - pStart);
            const keepEnd = Math.min(part.size - 1, end - pStart);
            const needBytes = keepEnd - skipStart + 1;

            const tgUrl = await getTgFileUrl(part.id, tokens[part.b || 0] || tokens[0]);
            const r = await fetch(tgUrl);
            const reader = r.body.getReader();
            let seen = 0, emitted = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const cStart = seen, cEnd = seen + value.byteLength - 1;
              seen += value.byteLength;
              if (cEnd < skipStart) continue;
              const sliceFrom = Math.max(0, skipStart - cStart);
              const sliceTo = Math.min(value.byteLength, sliceFrom + (needBytes - emitted));
              const sub = (sliceFrom === 0 && sliceTo === value.byteLength) ? value : value.subarray(sliceFrom, sliceTo);
              await writer.write(sub);
              emitted += sub.byteLength;
              if (emitted >= needBytes) { await reader.cancel(); break; }
            }
          }
          await writer.close();
        } catch (err) { await writer.abort(err); }
      })();
      return new Response(readable, { status: isRange ? 206 : 200, headers: baseHeaders });
    }

    return env.ASSETS.fetch(request);
  },
};
