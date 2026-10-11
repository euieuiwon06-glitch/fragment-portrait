// FRAGMENT PORTRAIT — SCATTER (8743)
// 20장의 사각형이 흩어져 돌아다니다가, 0.5초마다 한 장씩 그 순간의 모습을 찍고
// 제자리로 날아가 박힌다. 20장이 다 박히면 분절 초상화 완성.
// 영상은 브라우저 안에서만 처리한다. (CDN에서는 라이브러리·모델만 내려받음)

const MP_VERSION = '1.1.0';
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const SEG_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

// ---------------------------------------------------------------------------
// 조절값
const CFG = {
  cols: 4,              // 가로 칸 수
  rows: 5,              // 세로 칸 수
  width: 1200,          // 저장 이미지 가로 픽셀 (세로는 비율대로)
  interval: 500,        // 캡처 간격 (ms)
  order: 'random',      // 'random' | 'sequential'
  startDelay: 800,      // 사람이 감지된 뒤 첫 캡처까지 대기 (ms)
  lostGrace: 600,       // 사람이 사라져도 이 시간까지는 계속 진행 (ms)
  presence: 0.04,       // 화면 중 사람 비율이 이 값을 넘으면 '감지'
  maskLow: 0.35,        // 마스크 경계: 이 값 이하 = 배경(흰색)
  maskHigh: 0.65,       //             이 값 이상 = 사람
  maskBlur: 1.5,        // 마스크 가장자리 블러 (px)

  // 돌아다니기
  cardContent: 'live',  // 'live' = 떠다니는 카드에 자기 칸의 실시간 영상 / 'blank' = 빈 흰 카드
  wanderScale: 0.9,     // 떠다닐 때 카드 크기 (박혔을 때 대비)
  wanderSpeed: 90,      // 떠다니는 속도 (px/s)
  wanderTurn: 1.2,      // 방향 바꾸는 정도
  wanderRotate: 28,     // 떠다닐 때 최대 기울기 (deg)

  // 날아가 박히기
  flyMs: 750,           // 제자리까지 날아가는 시간
  flyOvershoot: 1.25,   // 도착할 때 살짝 지나쳤다 돌아오는 정도 (0 = 없음)
  flashMs: 220,         // 찍는 순간 흰 번쩍임

  // 러프 배치 — 격자 대신 크기 제각각인 카드가 겹쳐 쌓임 (단위: 칸)
  cardArea: [1.3, 1.6],  // 카드 넓이 범위 (칸 1개 = 1). 클수록 많이 겹침
  cardAspect: [0.4, 2.2], // 카드 가로:세로 비율 범위 (1보다 작으면 세로로 긴 카드)
  rowShift: 0.35,       // 줄마다 통째로 좌우로 밀리는 정도
  posJitter: [0.15, 0.18], // 카드마다 위치 흔들림 [가로, 세로]
  srcShift: [0.12, 0.08],  // 카드 속 사진이 제자리에서 어긋나는 정도 [가로, 세로]
  zoom: [0.9, 1.2],     // 카드마다 확대율 범위 (얼굴 크기가 카드마다 달라짐)
  rotate: 0.3,          // 박힐 때 최대 회전 (deg)
  shadow: 0.22,         // 박힌 카드 그림자 진하기
  portraitScale: 1,     // 안전영역을 꽉 채운 크기 대비 완성본 크기 (1 = 꽉 채움)
  safeTop: 56,          // 화면 위 안전영역 (px) — 완성본이 이 안으로 들어오지 않음
  safeBottom: 56,       // 화면 아래 안전영역 (px)
  safeSide: 24,         // 좌우 안전영역 (px)
  background: '#000',  // 화면·저장 이미지 바탕색 (카드는 흰색 그대로)
  grayscale: true,      // 피사체 흑백 (false = 컬러)
};

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const DEMO = params.has('demo');

// ---------------------------------------------------------------------------
const out = document.getElementById('out');
const octx = out.getContext('2d');
const video = document.getElementById('cam');

// 프레임(=저장) 해상도
const W = CFG.width;
const H = Math.round((W * CFG.rows) / CFG.cols);
const FW = W / CFG.cols; // 프레임 기준 칸 크기
const FH = H / CFG.rows;

// 흰 배경 위에 사람만 남긴 실시간 프레임
const frame = document.createElement('canvas');
frame.width = W;
frame.height = H;
const fctx = frame.getContext('2d');

const maskCanvas = document.createElement('canvas');
const mctx = maskCanvas.getContext('2d');
let maskImage = null;

let segmenter = null;
let presence = 0;
let hasFrame = false;

// 화면 레이아웃 (CSS px)
let VW = 0;
let VH = 0;
let P = { x: 0, y: 0, w: 0, h: 0 }; // 초상화 자리
let CW = 0; // 화면 기준 칸 크기
let CH = 0;

// 상태: 'loading' | 'waiting' | 'capturing' | 'paused' | 'done' | 'error'
let state = 'loading';
let cards = [];
let queue = [];
let presentSince = 0;
let lastSeen = 0;
let nextCaptureAt = 0;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// 레이아웃

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  VW = window.innerWidth;
  VH = window.innerHeight;
  out.width = Math.round(VW * dpr);
  out.height = Math.round(VH * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 안전영역 안에, 카드들이 실제로 차지하는 범위(삐져나온 카드 포함)가 들어가도록 맞춘다
  const availW = VW - CFG.safeSide * 2;
  const availH = VH - CFG.safeTop - CFG.safeBottom;
  let x0 = 0, y0 = 0, x1 = CFG.cols, y1 = CFG.rows; // 단위: 칸
  for (const c of cards) {
    if (c.cw === undefined) continue;
    x0 = Math.min(x0, c.cx - c.cw / 2);
    x1 = Math.max(x1, c.cx + c.cw / 2);
    y0 = Math.min(y0, c.cy - c.ch / 2);
    y1 = Math.max(y1, c.cy + c.ch / 2);
  }
  const cell = Math.min(availW / (x1 - x0), availH / (y1 - y0)) * CFG.portraitScale;
  CW = cell;
  CH = cell;
  const w = CFG.cols * cell;
  const h = CFG.rows * cell;
  P = {
    x: CFG.safeSide + (availW - (x1 - x0) * cell) / 2 - x0 * cell,
    y: CFG.safeTop + (availH - (y1 - y0) * cell) / 2 - y0 * cell,
    w,
    h,
  };
}

function slotOf(c) {
  return { x: P.x + c.cx * CW, y: P.y + c.cy * CH, rot: c.trot };
}

// 러프 배치: 줄마다 좌우로 밀리고, 카드마다 크기·위치·속 사진이 제각각
function roughen(c) {
  const shift = rowShifts[c.row];
  c.cx = c.col + 0.5 + shift + rand(-1, 1) * CFG.posJitter[0];
  c.cy = c.row + 0.5 + rand(-1, 1) * CFG.posJitter[1];
  // 넓이는 비슷하게, 비율만 크게 다르게 → 겹침은 적당히, 모양은 제각각
  const area = rand(CFG.cardArea[0], CFG.cardArea[1]);
  const aspect = Math.exp(rand(Math.log(CFG.cardAspect[0]), Math.log(CFG.cardAspect[1])));
  c.cw = Math.sqrt(area * aspect);
  c.ch = Math.sqrt(area / aspect);
  c.sox = rand(-1, 1) * CFG.srcShift[0];
  c.soy = rand(-1, 1) * CFG.srcShift[1];
  c.zoom = rand(CFG.zoom[0], CFG.zoom[1]);
  c.trot = rand(-1, 1) * CFG.rotate * DEG;
}

let rowShifts = [];
function newRowShifts() {
  rowShifts = Array.from({ length: CFG.rows }, () => rand(-1, 1) * CFG.rowShift);
}

// 원본 영역이 프레임 밖으로 나가면 잘라서 그린다 (밖은 흰색)
function drawRegion(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  const kx = dw / sw;
  const ky = dh / sh;
  const x0 = Math.max(sx, 0);
  const y0 = Math.max(sy, 0);
  const x1 = Math.min(sx + sw, src.width);
  const y1 = Math.min(sy + sh, src.height);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0,
    dx + (x0 - sx) * kx, dy + (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
}

// ---------------------------------------------------------------------------
// 카드

function newCards() {
  cards = [];
  for (let r = 0; r < CFG.rows; r++) {
    for (let c = 0; c < CFG.cols; c++) {
      cards.push({
        col: c,
        row: r,
        // 떠다니기 (박힐 자리·크기는 scatter()의 roughen에서 정함)
        x: rand(0.1, 0.9) * VW,
        y: rand(0.1, 0.85) * VH,
        rot: rand(-1, 1) * CFG.wanderRotate * DEG,
        s: CFG.wanderScale,
        heading: rand(0, Math.PI * 2),
        seed: rand(0, 1000),
        mode: 'wander', // 'wander' | 'fly' | 'placed'
        img: null,
        fly: null,
        flashAt: -1,
        z: 0,
      });
    }
  }
}

function scatter() {
  // 박혀 있던 카드도 그 자리에서 다시 흩어지고, 배치는 매번 새로 뽑는다
  newRowShifts();
  for (const c of cards) {
    c.mode = 'wander';
    c.img = null;
    c.fly = null;
    c.flashAt = -1;
    c.s = Math.min(c.s, 1);
    c.heading = rand(0, Math.PI * 2);
    roughen(c);
  }
  queue = cards.slice();
  if (CFG.order === 'random') {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
  }
  presentSince = 0;
  if (state !== 'loading' && state !== 'error') state = 'waiting';
  layout(); // 새 배치 범위에 맞춰 크기·위치 다시 계산
}

function wander(c, dt, t) {
  // 부드럽게 방향이 바뀌는 산책
  const turn =
    Math.sin(t * 0.7 + c.seed) * 0.6 + Math.sin(t * 1.9 + c.seed * 2.3) * 0.4;
  c.heading += turn * CFG.wanderTurn * dt;

  // 화면 가장자리에서는 안쪽으로 방향을 튼다
  const m = Math.max(CW, CH) * 0.5;
  const toCx = VW / 2 - c.x;
  const toCy = VH / 2 - c.y;
  if (c.x < m || c.x > VW - m || c.y < m || c.y > VH - m) {
    const want = Math.atan2(toCy, toCx);
    let d = want - c.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    c.heading += d * Math.min(1, dt * 3);
  }

  const sp = CFG.wanderSpeed * (0.7 + 0.3 * Math.sin(t * 0.5 + c.seed));
  c.x += Math.cos(c.heading) * sp * dt;
  c.y += Math.sin(c.heading) * sp * dt;
  c.x = clamp(c.x, -m * 0.5, VW + m * 0.5);
  c.y = clamp(c.y, -m * 0.5, VH + m * 0.5);

  const targetRot = Math.sin(t * 0.4 + c.seed * 1.7) * CFG.wanderRotate * DEG;
  c.rot += (targetRot - c.rot) * Math.min(1, dt * 1.5);
  c.s += (CFG.wanderScale - c.s) * Math.min(1, dt * 3);
}

function easeOutBack(k) {
  const s = CFG.flyOvershoot;
  const k1 = k - 1;
  return 1 + (s + 1) * k1 * k1 * k1 + s * k1 * k1;
}

function updateFly(c, now) {
  const f = c.fly;
  const k = clamp((now - f.t) / CFG.flyMs, 0, 1);
  const e = CFG.flyOvershoot > 0 ? easeOutBack(k) : 1 - Math.pow(1 - k, 3);
  const to = slotOf(c);
  // 살짝 호를 그리며 날아감
  const arc = Math.sin(k * Math.PI) * f.arc;
  c.x = f.x + (to.x - f.x) * e + arc * f.nx;
  c.y = f.y + (to.y - f.y) * e + arc * f.ny;
  c.rot = f.rot + (to.rot - f.rot) * e;
  c.s = f.s + (1 - f.s) * e;
  if (k >= 1) {
    c.mode = 'placed';
    c.fly = null;
  }
}

function capture(c, now) {
  // 카드 자리의 그 순간을 찍되, 확대율·어긋남만큼 살짝 다른 부분을 담는다
  const sw = (c.cw * FW) / c.zoom;
  const sh = (c.ch * FH) / c.zoom;
  const cx = (c.cx + c.sox) * FW;
  const cy = (c.cy + c.soy) * FH;
  const img = document.createElement('canvas');
  img.width = Math.round(c.cw * FW);
  img.height = Math.round(c.ch * FH);
  const ictx = img.getContext('2d');
  ictx.fillStyle = '#fff';
  ictx.fillRect(0, 0, img.width, img.height);
  drawRegion(ictx, frame, cx - sw / 2, cy - sh / 2, sw, sh, 0, 0, img.width, img.height);
  c.img = img;
  c.flashAt = now;
  c.z = now;

  const to = slotOf(c);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  // 회전은 가까운 방향으로
  let rot = c.rot;
  rot = to.rot + Math.atan2(Math.sin(rot - to.rot), Math.cos(rot - to.rot));
  c.mode = 'fly';
  c.fly = {
    t: now,
    x: c.x,
    y: c.y,
    rot,
    s: c.s,
    nx: -dy / len,
    ny: dx / len,
    arc: Math.min(len * 0.18, 120) * (Math.random() < 0.5 ? -1 : 1),
  };
}

// ---------------------------------------------------------------------------
// 실시간 프레임 합성 (사람 + 흰 배경, 4:5 중앙 크롭, 좌우 반전)

function cropRect(srcW, srcH) {
  const a = W / H;
  let cw = srcW;
  let ch = srcW / a;
  if (ch > srcH) {
    ch = srcH;
    cw = srcH * a;
  }
  return { sx: (srcW - cw) / 2, sy: (srcH - ch) / 2, sw: cw, sh: ch };
}

function updateMask(m) {
  const f = m.getAsFloat32Array();
  const w = m.width;
  const h = m.height;
  if (!maskImage || maskImage.width !== w || maskImage.height !== h) {
    maskCanvas.width = w;
    maskCanvas.height = h;
    maskImage = mctx.createImageData(w, h);
  }
  const d = maskImage.data;
  const lo = CFG.maskLow;
  const span = CFG.maskHigh - CFG.maskLow;
  let sum = 0;
  for (let i = 0, j = 3; i < f.length; i++, j += 4) {
    const p = f[i];
    sum += p;
    let a = (p - lo) / span;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    d[j] = (a * a * (3 - 2 * a) * 255) | 0;
  }
  mctx.putImageData(maskImage, 0, 0);
  presence = sum / f.length;
}

function composeFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !maskImage) return;
  const v = cropRect(vw, vh);
  const sx = maskCanvas.width / vw;
  const sy = maskCanvas.height / vh;

  fctx.save();
  fctx.clearRect(0, 0, W, H);
  fctx.translate(W, 0);
  fctx.scale(-1, 1);
  fctx.filter = CFG.maskBlur > 0 ? `blur(${CFG.maskBlur}px)` : 'none';
  fctx.drawImage(maskCanvas, v.sx * sx, v.sy * sy, v.sw * sx, v.sh * sy, 0, 0, W, H);
  fctx.filter = 'none';
  fctx.globalCompositeOperation = 'source-in';
  fctx.filter = CFG.grayscale ? 'grayscale(1)' : 'none';
  fctx.drawImage(video, v.sx, v.sy, v.sw, v.sh, 0, 0, W, H);
  fctx.filter = 'none';
  fctx.globalCompositeOperation = 'destination-over';
  fctx.fillStyle = '#fff';
  fctx.fillRect(0, 0, W, H);
  fctx.restore();
  hasFrame = true;
}

// 카메라 없이 확인용: 움직이는 실루엣
function composeDemo(now) {
  const t = now / 1000;
  fctx.fillStyle = '#fff';
  fctx.fillRect(0, 0, W, H);
  const x = W / 2 + Math.sin(t * 0.9) * W * 0.12;
  const y = H * 0.42 + Math.cos(t * 0.7) * H * 0.03;
  const s = 1 + Math.sin(t * 0.5) * 0.12;
  fctx.save();
  fctx.translate(x, y);
  fctx.scale(s, s);
  fctx.fillStyle = '#d9b8a3';
  fctx.beginPath();
  fctx.ellipse(0, 0, W * 0.2, H * 0.2, 0, 0, Math.PI * 2);
  fctx.fill();
  fctx.fillStyle = '#2a211c';
  for (const ex of [-1, 1]) {
    fctx.beginPath();
    fctx.ellipse(ex * W * 0.075, -H * 0.02, W * 0.022, H * 0.012, 0, 0, Math.PI * 2);
    fctx.fill();
  }
  fctx.fillStyle = '#b06a62';
  fctx.fillRect(-W * 0.05, H * 0.09, W * 0.1, H * 0.012);
  fctx.restore();
  fctx.fillStyle = '#e6e1dc';
  fctx.fillRect(W * 0.2, H * 0.78, W * 0.6, H * 0.3);
  presence = 0.3;
  hasFrame = true;
}

// ---------------------------------------------------------------------------
// 진행

function step(now) {
  const seen = presence > CFG.presence;
  if (seen) lastSeen = now;
  const present = seen || now - lastSeen < CFG.lostGrace;

  if (state === 'waiting') {
    if (present) {
      if (!presentSince) presentSince = now;
      if (now - presentSince >= CFG.startDelay) {
        state = 'capturing';
        nextCaptureAt = now;
      }
    } else {
      presentSince = 0;
    }
  } else if (state === 'capturing') {
    if (!present) {
      state = 'paused';
    } else if (now >= nextCaptureAt && queue.length) {
      capture(queue.shift(), now);
      nextCaptureAt = now + CFG.interval;
    }
    if (!queue.length && cards.every((c) => c.mode === 'placed')) finish();
  } else if (state === 'paused') {
    if (seen) {
      state = 'capturing';
      nextCaptureAt = now + CFG.interval;
    }
  }
}

function finish() {
  state = 'done';
}

// ---------------------------------------------------------------------------
// 그리기

function cardFace(c) {
  // 떠다니는 카드 안에 보일 그림: 찍힌 사진 / 자기 자리의 실시간 영상 / 빈 카드
  if (c.img) return { src: c.img, sx: 0, sy: 0, sw: c.img.width, sh: c.img.height };
  if (CFG.cardContent === 'live' && hasFrame) {
    const sw = c.cw * FW;
    const sh = c.ch * FH;
    return { src: frame, sx: c.cx * FW - sw / 2, sy: c.cy * FH - sh / 2, sw, sh };
  }
  return null;
}

function drawCard(c, now) {
  const w = c.cw * CW * c.s;
  const h = c.ch * CH * c.s;
  octx.save();
  octx.translate(c.x, c.y);
  octx.rotate(c.rot);

  const lifted = c.mode !== 'placed';
  octx.shadowColor = `rgba(0,0,0,${lifted ? CFG.shadow * 0.55 : CFG.shadow})`;
  octx.shadowBlur = lifted ? CW * 0.08 : CW * 0.025;
  octx.shadowOffsetX = lifted ? CW * 0.015 : CW * 0.006;
  octx.shadowOffsetY = lifted ? CW * 0.04 : CW * 0.01;
  octx.fillStyle = '#fff';
  octx.fillRect(-w / 2, -h / 2, w, h);
  octx.shadowColor = 'transparent';

  const face = cardFace(c);
  if (face) drawRegion(octx, face.src, face.sx, face.sy, face.sw, face.sh, -w / 2, -h / 2, w, h);

  if (!c.img) {
    // 아직 안 찍힌 카드는 가는 테두리로 흰 배경과 구분
    octx.strokeStyle = 'rgba(0,0,0,0.14)';
    octx.lineWidth = 1;
    octx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1);
  }

  if (c.flashAt >= 0) {
    const k = (now - c.flashAt) / CFG.flashMs;
    if (k < 1) {
      octx.fillStyle = `rgba(255,255,255,${0.9 * (1 - k)})`;
      octx.fillRect(-w / 2, -h / 2, w, h);
    }
  }
  octx.restore();
}

function render(now) {
  octx.fillStyle = CFG.background;
  octx.fillRect(0, 0, VW, VH);

  // 순서: 박힌 조각 → 떠다니는 카드 → 날아가는 카드
  const placed = cards.filter((c) => c.mode === 'placed').sort((a, b) => a.z - b.z);
  const wandering = cards.filter((c) => c.mode === 'wander');
  const flying = cards.filter((c) => c.mode === 'fly').sort((a, b) => a.z - b.z);
  for (const c of placed) drawCard(c, now);
  for (const c of wandering) drawCard(c, now);
  for (const c of flying) drawCard(c, now);

  if (DEBUG && maskImage) {
    const dw = 160;
    octx.drawImage(maskCanvas, VW - dw - 12, 12, dw, (dw * maskCanvas.height) / maskCanvas.width);
  }

}


// ---------------------------------------------------------------------------
// 루프

let lastVideoTime = -1;
let lastNow = performance.now();
function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastNow) / 1000);
  lastNow = now;
  const t = now / 1000;

  if (DEMO) {
    composeDemo(now);
  } else if (segmenter && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    segmenter.segmentForVideo(video, now, (res) => {
      const masks = res.confidenceMasks;
      if (masks && masks.length) updateMask(masks[0]);
    });
    composeFrame();
  }

  for (const c of cards) {
    if (c.mode === 'wander') wander(c, dt, t);
    else if (c.mode === 'fly') updateFly(c, now);
    else {
      const to = slotOf(c); // 창 크기가 바뀌어도 제자리 유지
      c.x = to.x;
      c.y = to.y;
      c.rot = to.rot;
      c.s = 1;
    }
  }

  if (state === 'waiting' || state === 'capturing' || state === 'paused') step(now);
  render(now);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// 저장 — 카드들이 차지한 영역 + 여백만 잘라서

function save() {
  const shot = cards.filter((k) => k.img);
  const pad = FW * 0.3;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of shot) {
    x0 = Math.min(x0, (k.cx - k.cw / 2) * FW);
    x1 = Math.max(x1, (k.cx + k.cw / 2) * FW);
    y0 = Math.min(y0, (k.cy - k.ch / 2) * FH);
    y1 = Math.max(y1, (k.cy + k.ch / 2) * FH);
  }
  const c = document.createElement('canvas');
  c.width = Math.round(x1 - x0 + pad * 2);
  c.height = Math.round(y1 - y0 + pad * 2);
  const x = c.getContext('2d');
  x.fillStyle = CFG.background;
  x.fillRect(0, 0, c.width, c.height);
  x.translate(pad - x0, pad - y0);
  for (const card of shot.sort((a, b) => a.z - b.z)) {
    const w = card.cw * FW;
    const h = card.ch * FH;
    x.save();
    x.translate(card.cx * FW, card.cy * FH);
    x.rotate(card.trot);
    x.shadowColor = `rgba(0,0,0,${CFG.shadow})`;
    x.shadowBlur = FW * 0.025;
    x.shadowOffsetX = FW * 0.006;
    x.shadowOffsetY = FW * 0.01;
    x.drawImage(card.img, -w / 2, -h / 2, w, h);
    x.restore();
  }
  c.toBlob((blob) => {
    const a = document.createElement('a');
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    a.download = `fragment-portrait_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}

window.addEventListener('resize', layout);
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'r' || k === ' ') { e.preventDefault(); scatter(); }
  else if (k === 's' && state === 'done') save();
});

// ---------------------------------------------------------------------------
// 시작

async function init() {
  layout();
  newCards();
  scatter();
  requestAnimationFrame(loop);
  if (DEMO) {
    state = 'waiting';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    console.error(err);
    console.warn('카메라를 쓸 수 없어요 — 브라우저 권한을 확인해 주세요');
    state = 'error';
    return;
  }
  try {
    const { FilesetResolver, ImageSegmenter } = await import(MP_BUNDLE);
    const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
    const make = (delegate) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEG_MODEL_URL, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    segmenter = await make('GPU').catch(() => make('CPU'));
  } catch (err) {
    console.error(err);
    console.warn('배경 분리 모델을 불러오지 못했어요 — 인터넷 연결을 확인해 주세요');
    state = 'error';
    return;
  }
  state = 'waiting';
}

init();
