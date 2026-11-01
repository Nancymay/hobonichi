/* Фотоквиток: one receipt a day, printed by pulling the paper out of a small red printer.
   Data lives only on this device, in IndexedDB ("fotokvitok"): kv (receipts by date), ph (photo blobs), meta (draft, flags). */
(() => {
"use strict";

const $ = s => document.querySelector(s);
const WD_FULL = ["ВОСКРЕСЕНЬЕ","ПОНЕДЕЛЬНИК","ВТОРНИК","СРЕДА","ЧЕТВЕРГ","ПЯТНИЦА","СУББОТА"];
const WD_SHORT = ["ВС","ПН","ВТ","СР","ЧТ","ПТ","СБ"];
const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const MONTHS_UP = MONTHS.map(m => m.toUpperCase());
const pad = (n, l = 2) => String(n).padStart(l, "0");
const keyOf = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const todayKey = () => keyOf(new Date());
const parseKey = k => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const fmtDate = k => k.slice(8, 10) + "." + k.slice(5, 7) + "." + k.slice(0, 4);
const fmtNo = n => "№ " + pad(n || 1, 4);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
/* a stamp never lands quite straight; the tilt is fixed per day so a receipt looks the same everywhere */
const rotOf = k => { let h = 0; for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0; return -3 - (h % 60) / 10; };

/* ---------- IndexedDB ---------- */
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open("fotokvitok", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("kv", { keyPath: "date" });
      d.createObjectStore("ph", { keyPath: "id" });
      d.createObjectStore("meta", { keyPath: "key" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), req = fn(t.objectStore(store));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const dget = (s, k) => tx(s, "readonly", st => st.get(k));
const dput = (s, v) => tx(s, "readwrite", st => st.put(v));
const ddel = (s, k) => tx(s, "readwrite", st => st.delete(k));
const dall = s => tx(s, "readonly", st => st.getAll());
const dkeys = s => tx(s, "readonly", st => st.getAllKeys());

/* ---------- photos ---------- */
const urls = new Map();
async function photoURL(id) {
  if (urls.has(id)) return urls.get(id);
  const p = await dget("ph", id);
  if (!p) return null;
  const u = URL.createObjectURL(p.blob);
  urls.set(id, u);
  return u;
}
async function fillImgs(root) {
  for (const img of root.querySelectorAll("img[data-id]")) {
    const u = await photoURL(img.dataset.id);
    if (u && img.getAttribute("src") !== u) img.src = u;
  }
}
const loadImage = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
/* shrink big camera shots before storing: longest side 1600px, JPEG */
async function ingest(file) {
  const src = URL.createObjectURL(file);
  try {
    const img = await loadImage(src);
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.86));
    if (!blob) throw new Error("encode");
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await dput("ph", { id, blob, w, h });
    urls.set(id, URL.createObjectURL(blob));
    return { id, w, h };
  } finally { URL.revokeObjectURL(src); }
}
async function cleanupPhotos() {
  try {
    const used = new Set();
    (await dall("kv")).forEach(k => k.photos.forEach(p => used.add(p.id)));
    const d = await dget("meta", "draft"); if (d) d.photos.forEach(p => used.add(p.id));
    for (const id of await dkeys("ph")) if (!used.has(id)) { await ddel("ph", id); const u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); } }
  } catch (e) { /* not critical */ }
}

/* ---------- receipt markup ---------- */
const ratio1 = p => clamp(p.w / p.h, 0.8, 4 / 3);
function kvHTML(k, o = {}) {
  const n = k.photos.length, d = parseKey(k.date);
  let body = "";
  if (!n) {
    if (o.editing) body = '<button class="kv-add" type="button" data-act="add">Добавить фото<small>от одного до трёх снимков</small></button>';
  } else {
    body = '<div class="kv-photos n' + n + '">' + k.photos.map((p, i) => {
      const style = n === 1 ? ' style="aspect-ratio:' + ratio1(p).toFixed(4) + '"' : "";
      const tag = o.editing && n > 1 && i === 0 ? '<span class="tag">обложка</span>' : "";
      return o.editing
        ? '<button type="button" class="ph" data-i="' + i + '"' + style + ' aria-label="Фото ' + (i + 1) + ' из ' + n + ': изменить"><img alt="" data-id="' + p.id + '">' + tag + "</button>"
        : '<figure class="ph"' + style + '><img alt="" data-id="' + p.id + '"></figure>';
    }).join("") + "</div>";
    if (o.editing && n < 3) body += '<button class="kv-more" type="button" data-act="add">+ ещё фото (' + n + ' из 3)</button>';
  }
  const cap = o.editing && n
    ? '<textarea class="kv-cap" id="cap" rows="1" maxlength="140" enterkeyhint="done" placeholder="Подпись к дню, если хочется" aria-label="Подпись">' + esc(k.caption || "") + "</textarea>"
    : '<p class="kv-cap">' + esc(k.caption || "") + "</p>";
  const foot = '<div class="kv-foot"><span>КВИТОК ' + fmtNo(k.no) + '</span><span><span class="wd">' + WD_SHORT[d.getDay()] + "</span> " + fmtDate(k.date) + "</span></div>";
  const stamp = o.stamp ? '<div class="kv-stamp' + (o.land ? " land" : "") + '" style="--rot:' + rotOf(k.date).toFixed(1) + 'deg">' + WD_FULL[d.getDay()] + "</div>" : "";
  const teeth = o.teeth === false ? "" : '<div class="kv-teeth"></div>';
  return '<article class="kv' + (o.editing ? " editing" : "") + (o.stamp || o.space ? " spaced" : "") + '" data-date="' + k.date + '">' + body + cap + foot + stamp + teeth + "</article>";
}

/* ---------- state ---------- */
const S = { tab: "today", date: todayKey(), mode: "empty", draft: null, kv: null, nextNo: 1, busy: false, off: 0, H: 0, rollMonth: todayKey().slice(0, 7), exportBlob: null };
const printer = $("#printer"), feed = $("#feed"), wrap = $("#paperWrap");

async function nextNo() { return (await dall("kv")).reduce((m, k) => Math.max(m, k.no || 0), 0) + 1; }
function current() {
  if (S.draft) return { date: S.date, no: S.draft.no || S.nextNo, photos: S.draft.photos, caption: S.draft.caption };
  if (S.kv) return S.kv;
  return { date: S.date, no: S.nextNo, photos: [], caption: "" };
}
let draftTimer = 0;
function saveDraft(now) {
  clearTimeout(draftTimer);
  const go = () => S.draft ? dput("meta", Object.assign({ key: "draft", date: S.date }, S.draft)) : ddel("meta", "draft");
  if (now) return go();
  draftTimer = setTimeout(go, 400);
}

async function loadToday() {
  S.date = todayKey();
  S.kv = (await dget("kv", S.date)) || null;
  S.nextNo = S.kv ? S.kv.no : await nextNo();
  let d = await dget("meta", "draft");
  if (d && d.date !== S.date) {
    /* an unprinted composition from another day moves to today; an unfinished edit of an old receipt is dropped */
    if (d.no) { await ddel("meta", "draft"); d = null; } else d.date = S.date;
  }
  if (d && (d.photos.length || d.no)) {
    S.draft = { photos: d.photos, caption: d.caption || "", no: d.no || null, ready: !!d.ready && d.photos.length > 0 };
    S.mode = S.draft.ready ? "ready" : "draft";
  } else { S.draft = null; S.mode = S.kv ? "printed" : "empty"; }
  renderToday();
}

/* ---------- today ---------- */
function measure() { S.H = wrap.offsetHeight; }
function restOffset() {
  const kv = wrap.querySelector(".kv"), foot = kv && kv.querySelector(".kv-foot");
  if (!foot) return 0;
  const peek = S.H - foot.offsetTop + 12;
  return -Math.max(0, S.H - peek);
}
function setOff(off) {
  S.off = off;
  wrap.style.transform = "translateY(" + off.toFixed(1) + "px)";
  feed.style.height = Math.max(0, S.H + off + 24) + "px";
}
function renderToday(o = {}) {
  const k = current(), editing = S.mode === "draft" || S.mode === "empty";
  wrap.innerHTML = kvHTML(k, { editing, stamp: S.mode === "printed", space: S.mode === "ready" || S.mode === "printing", land: o.land });
  fillImgs(wrap);
  const cap = $("#cap"); if (cap) fit(cap);
  measure();
  setOff(S.mode === "ready" || S.mode === "printing" ? restOffset() : 0);
  feed.classList.toggle("grab", S.mode === "ready");
  $("#hint").hidden = S.mode !== "ready";
  printer.classList.toggle("idle", S.mode === "empty" || S.mode === "ready");
  renderActions();
}
function fit(el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
function renderActions() {
  const a = $("#actions");
  if (S.tab !== "today") { a.innerHTML = ""; return; }
  const b = (id, label, cls = "", dis = false) => '<button class="btn ' + cls + '" data-do="' + id + '"' + (dis ? " disabled" : "") + ">" + label + "</button>";
  const n = S.draft ? S.draft.photos.length : 0;
  a.innerHTML = {
    empty: "",
    draft: (S.kv ? b("cancel", "Отменить") : "") + b("load", "К печати", "primary", n === 0),
    ready: b("edit", "Изменить") + b("print", "Напечатать", "red"),
    printing: b("edit", "Изменить", "", true) + b("print", "Печатаю…", "red", true),
    printed: b("edit", "Изменить") + b("save", "Сохранить картинкой", "primary")
  }[S.mode];
}

/* paper movement */
function tween(from, to, dur, ease, step) {
  return new Promise(res => {
    if (dur <= 0) { step(to, 1); return res(); }
    const t0 = performance.now();
    const f = now => {
      const p = clamp((now - t0) / dur, 0, 1);
      step(from + (to - from) * ease(p), p);
      if (p < 1) requestAnimationFrame(f); else res();
    };
    requestAnimationFrame(f);
  });
}
const easeInOut = p => p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
const easeOut = p => 1 - Math.pow(1 - p, 3);

async function loadIntoPrinter() {
  if (S.busy || !S.draft || !S.draft.photos.length) return;
  S.busy = true;
  const cap = $("#cap"); if (cap) cap.blur();
  S.draft.ready = true; S.mode = "ready"; await saveDraft(true);
  /* the printer draws the sheet back in, leaving only the edge */
  const k = current();
  wrap.innerHTML = kvHTML(k, { space: true }); await fillImgs(wrap); measure();
  const to = restOffset();
  printer.classList.add("printing");
  await tween(0, to, reduced() ? 0 : 560, easeInOut, v => setOff(v));
  printer.classList.remove("printing");
  S.busy = false;
  renderToday();
}
async function backToDraft() {
  if (S.busy) return;
  S.busy = true;
  S.draft.ready = false; saveDraft(true);
  await tween(S.off, 0, reduced() ? 0 : 320, easeOut, v => setOff(v));
  S.mode = "draft"; S.busy = false; renderToday();
}
function springBack() {
  const from = S.off, to = restOffset();
  tween(from, to, reduced() ? 0 : 280, easeOut, v => setOff(v));
}

let printing = null;
function print() {
  if (printing || S.mode !== "ready" || !S.draft || !S.draft.photos.length) return printing;
  printing = (async () => {
    S.busy = true; S.mode = "printing"; renderActions();
    $("#hint").hidden = true; feed.classList.remove("grab");
    printer.classList.remove("idle"); printer.classList.add("printing");
    const no = S.draft.no || await nextNo();
    const from = S.off, dist = -from;
    let frame = 0;
    const dur = reduced() ? 140 : clamp(dist / 0.46, 520, 1500);
    /* a little motor: the paper advances in small steps and the body hums */
    await tween(from, 0, dur, p => p < .9 ? p / .9 * .97 : .97 + easeOut((p - .9) / .1) * .03, v => {
      setOff(reduced() ? v : Math.round(v / 1.5) * 1.5);
      if (!reduced()) printer.style.transform = "translate(" + (frame % 2 ? .5 : -.5) + "px," + (frame % 3 ? 0 : .5) + "px)";
      frame++;
    });
    printer.style.transform = "";
    if (!reduced()) await tween(0, 1, 220, p => p, (v, p) => setOff(Math.sin(p * Math.PI) * 4));
    setOff(0);
    const kv = { date: S.date, no, photos: S.draft.photos.slice(), caption: (S.draft.caption || "").trim(), printedAt: Date.now(), createdAt: (S.kv && S.kv.createdAt) || Date.now() };
    await dput("kv", kv);
    S.kv = kv; S.draft = null; await saveDraft(true);
    S.nextNo = no;
    printer.classList.remove("printing");
    S.mode = "printed";
    renderToday({ land: !reduced() });
    if (navigator.vibrate) navigator.vibrate(12);
    toast("Квиток " + fmtNo(no) + " лежит в рулоне");
    S.busy = false;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    cleanupPhotos();
    prepareExport(kv);
  })().finally(() => { printing = null; });
  return printing;
}

/* drag the paper edge */
let drag = null;
feed.addEventListener("pointerdown", e => {
  if (S.mode !== "ready" || S.busy || (e.button && e.button > 0)) return;
  e.preventDefault();
  drag = { y0: e.clientY, off0: S.off, id: e.pointerId, ly: e.clientY, lt: performance.now(), v: 0 };
  try { feed.setPointerCapture(e.pointerId); } catch (_) {}
});
feed.addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.y0, now = performance.now();
  drag.v = (e.clientY - drag.ly) / Math.max(1, now - drag.lt); drag.ly = e.clientY; drag.lt = now;
  /* follows the finger 1:1 down, resists going back up */
  const off = dy >= 0 ? Math.min(0, drag.off0 + dy) : drag.off0 + dy * 0.15;
  setOff(off);
  const travel = -drag.off0, need = Math.min(150, travel * 0.38);
  if (dy >= need) { endDrag(e); print(); }
});
function endDrag(e) { if (!drag) return; try { feed.releasePointerCapture(drag.id); } catch (_) {} drag = null; }
const release = e => {
  if (!drag || e.pointerId !== drag.id) return;
  const fast = drag.v > 0.8 && e.clientY - drag.y0 > 36;
  endDrag(e);
  if (fast) print(); else springBack();
};
feed.addEventListener("pointerup", release);
feed.addEventListener("pointercancel", release);

/* ---------- editing ---------- */
let replaceAt = -1;
wrap.addEventListener("click", e => {
  if (S.busy) return;
  if (e.target.closest('[data-act="add"]')) return pickPhotos();
  const ph = e.target.closest(".editing .ph");
  if (ph) photoMenu(+ph.dataset.i);
});
wrap.addEventListener("input", e => {
  if (e.target.id !== "cap" || !S.draft) return;
  S.draft.caption = e.target.value; fit(e.target); measure(); setOff(0); saveDraft();
});
wrap.addEventListener("keydown", e => { if (e.target.id === "cap" && e.key === "Enter") { e.preventDefault(); e.target.blur(); } });

function ensureDraft() {
  if (!S.draft) S.draft = S.kv ? { photos: S.kv.photos.slice(), caption: S.kv.caption || "", no: S.kv.no, ready: false } : { photos: [], caption: "", no: null, ready: false };
}
function pickPhotos() { replaceAt = -1; const p = $("#pick"); p.value = ""; p.click(); }
$("#pick").addEventListener("change", async e => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  ensureDraft();
  const room = 3 - S.draft.photos.length;
  if (files.length > room) toast(room ? "На квиток помещаются три фото. " + (room === 1 ? "Добавлено первое" : "Добавлены первые " + (room === 2 ? "два" : "три")) : "На квитке уже три фото");
  let bad = 0;
  for (const f of files.slice(0, room)) {
    try { S.draft.photos.push(await ingest(f)); } catch (_) { bad++; }
  }
  if (bad) toast("Не получилось открыть " + bad + " " + plural(bad, "фото", "фото", "фото") + ". Попробуйте другой снимок");
  S.mode = "draft"; await saveDraft(true); renderToday();
});
$("#pick1").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0]; if (!f || replaceAt < 0) return;
  try { S.draft.photos[replaceAt] = await ingest(f); await saveDraft(true); renderToday(); }
  catch (_) { toast("Не получилось открыть это фото. Попробуйте другой снимок"); }
  replaceAt = -1;
});
function photoMenu(i) {
  const n = S.draft.photos.length;
  sheet('<h2>Фото ' + (i + 1) + " из " + n + '</h2><div class="list">'
    + (i > 0 ? '<button class="btn" data-s="cover">Сделать обложкой</button>' : "")
    + '<button class="btn" data-s="replace">Заменить</button>'
    + '<button class="btn danger" data-s="remove">Убрать с квитка</button>'
    + '<button class="btn" data-s="close">Отмена</button></div>', {
    cover: () => { const [p] = S.draft.photos.splice(i, 1); S.draft.photos.unshift(p); closeSheet(); saveDraft(true); renderToday(); },
    replace: () => { closeSheet(); replaceAt = i; const p = $("#pick1"); p.value = ""; p.click(); },
    remove: () => {
      S.draft.photos.splice(i, 1); closeSheet();
      if (!S.draft.photos.length && !S.kv) { S.draft = null; S.mode = "empty"; }
      saveDraft(true); renderToday(); cleanupPhotos();
    }
  });
}

/* dock buttons */
$("#actions").addEventListener("click", e => {
  const b = e.target.closest("[data-do]"); if (!b || b.disabled) return;
  const a = b.dataset.do;
  if (a === "load") loadIntoPrinter();
  else if (a === "print") print();
  else if (a === "edit") {
    if (S.mode === "ready") backToDraft();
    else if (S.mode === "printed") { ensureDraft(); S.mode = "draft"; saveDraft(true); renderToday(); }
  } else if (a === "cancel") { S.draft = null; saveDraft(true); S.mode = S.kv ? "printed" : "empty"; renderToday(); cleanupPhotos(); }
  else if (a === "save" && S.kv) saveKv(S.kv);
});

/* ---------- PNG ---------- */
const W = 300, M = 16, GAP = 6, FONT = '"Plex Mono","IBM Plex Mono",ui-monospace,Menlo,monospace';
let noise = null;
function noisePattern(ctx) {
  if (!noise) {
    noise = document.createElement("canvas"); noise.width = noise.height = 96;
    const x = noise.getContext("2d"), d = x.createImageData(96, 96);
    for (let i = 0; i < d.data.length; i += 4) { d.data[i] = 115; d.data[i + 1] = 97; d.data[i + 2] = 71; d.data[i + 3] = Math.random() < .5 ? Math.random() * 16 : 0; }
    x.putImageData(d, 0, 0);
  }
  return ctx.createPattern(noise, "repeat");
}
function spaced(ctx, text, x, y, sp, align) {
  let w = 0; for (const ch of text) w += ctx.measureText(ch).width + sp; w -= sp;
  let cx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  for (const ch of text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + sp; }
  return w;
}
function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const t = line + word;
      if (ctx.measureText(t.trimEnd()).width <= maxW || !line.trim()) {
        if (ctx.measureText(t.trimEnd()).width > maxW) { let cur = ""; for (const ch of word) { if (ctx.measureText(cur + ch).width > maxW && cur) { out.push(cur); cur = ch; } else cur += ch; } line = cur; }
        else line = t;
      } else { out.push(line.trimEnd()); line = word.trimStart(); }
    }
    out.push(line.trimEnd());
  }
  return out;
}
function photoRects(k) {
  const n = k.photos.length, iw = W - 2 * M, r = [];
  let y = 0;
  if (n === 1) { const h = iw / ratio1(k.photos[0]); r.push([M, 0, iw, h]); y = h; }
  else if (n === 2) { const cw = (iw - GAP) / 2, ch = cw * 5 / 4; r.push([M, 0, cw, ch], [M + cw + GAP, 0, cw, ch]); y = ch; }
  else if (n === 3) { const bh = iw * 3 / 4, cw = (iw - GAP) / 2; r.push([M, 0, iw, bh], [M, bh + GAP, cw, cw], [M + cw + GAP, bh + GAP, cw, cw]); y = bh + GAP + cw; }
  return { r, h: y };
}
/* height of one receipt's paper (without teeth), so the month can be laid out before drawing */
function kvHeight(ctx, k, top) {
  ctx.font = "400 14px " + FONT;
  const lines = k.caption ? wrapText(ctx, k.caption, W - 2 * M) : [];
  return top + photoRects(k).h + (lines.length ? 14 + lines.length * 21 : 0) + 40 + 10 + 15 + 14;
}
function drawStamp(ctx, k, right, bottom) {
  const word = WD_FULL[parseKey(k.date).getDay()];
  const s = document.createElement("canvas"), sc = 4;
  const m = document.createElement("canvas").getContext("2d"); m.font = "600 15px " + FONT;
  let tw = 0; for (const ch of word) tw += m.measureText(ch).width + 1.8; tw -= 1.8;
  const bw = tw + 25, bh = 15 + 11 + 5;
  s.width = Math.ceil(bw * sc); s.height = Math.ceil(bh * sc);
  const x = s.getContext("2d"); x.scale(sc, sc);
  x.strokeStyle = x.fillStyle = "#294AC4";
  x.lineWidth = 2.5; x.strokeRect(1.25, 1.25, bw - 2.5, bh - 2.5);
  x.lineWidth = 1; x.strokeRect(4.5, 4.5, bw - 9, bh - 9);
  x.font = "600 15px " + FONT; x.textBaseline = "alphabetic";
  spaced(x, word, bw / 2, bh / 2 + 5.4, 1.8, "center");
  /* rubber texture: knock out specks */
  x.globalCompositeOperation = "destination-out";
  let seed = 7; for (const c of k.date) seed = (seed * 33 + c.charCodeAt(0)) >>> 0;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 10000) / 10000; };
  for (let i = 0; i < 260; i++) { x.globalAlpha = .35 + rnd() * .65; x.beginPath(); x.arc(rnd() * bw, rnd() * bh, .25 + rnd() * .9, 0, 7); x.fill(); }
  ctx.save(); ctx.translate(right - bw / 2, bottom - bh / 2); ctx.rotate(rotOf(k.date) * Math.PI / 180);
  ctx.globalAlpha = .88; ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(s, -bw / 2, -bh / 2, bw, bh);
  ctx.restore();
}
function drawCover(ctx, img, x, y, w, h) {
  const r = img.naturalWidth / img.naturalHeight, tr = w / h;
  let sw, sh, sx, sy;
  if (r > tr) { sh = img.naturalHeight; sw = sh * tr; sx = (img.naturalWidth - sw) / 2; sy = 0; }
  else { sw = img.naturalWidth; sh = sw / tr; sx = 0; sy = (img.naturalHeight - sh) / 2; }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}
/* draws a receipt's contents at (0,y0); returns the y where its paper ends */
async function drawKvAt(ctx, k, y0, top) {
  let y = y0 + top;
  const { r, h } = photoRects(k);
  for (let i = 0; i < r.length; i++) {
    const [x, yy, w, hh] = r[i];
    ctx.fillStyle = "#EEE4CF"; ctx.fillRect(x, y + yy, w, hh);
    try { const img = await loadImage(await photoURL(k.photos[i].id)); drawCover(ctx, img, x, y + yy, w, hh); } catch (_) {}
  }
  y += h;
  ctx.fillStyle = "#282522"; ctx.font = "400 14px " + FONT; ctx.textBaseline = "alphabetic";
  if (k.caption) {
    y += 14;
    for (const ln of wrapText(ctx, k.caption, W - 2 * M)) { ctx.fillText(ln, M, y + 15); y += 21; }
  }
  y += 40;
  ctx.save(); ctx.strokeStyle = "rgba(40,37,34,.38)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(M, y + .5); ctx.lineTo(W - M, y + .5); ctx.stroke(); ctx.restore();
  y += 10;
  const d = parseKey(k.date);
  ctx.font = "500 11px " + FONT; ctx.fillStyle = "#282522";
  spaced(ctx, "КВИТОК " + fmtNo(k.no), M, y + 11, .44, "left");
  const dw = spaced(ctx, fmtDate(k.date), W - M, y + 11, .44, "right");
  ctx.font = "400 11px " + FONT; ctx.fillStyle = "#8A847A";
  spaced(ctx, WD_SHORT[d.getDay()], W - M - dw - 7, y + 11, .44, "right");
  y += 15 + 14;
  drawStamp(ctx, k, W - 10, y - 38);
  return y;
}
function paperPath(ctx, h, teeth) {
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, 0); ctx.lineTo(W, h);
  if (teeth) { for (let x = W; x > 0; x -= 12) { ctx.lineTo(x - 6, h + 8); ctx.lineTo(x - 12, h); } }
  else ctx.lineTo(0, h);
  ctx.closePath();
}
/* one receipt, or a month of them separated by perforation */
async function renderPNG(list, title) {
  await document.fonts.ready.catch(() => {});
  const probe = document.createElement("canvas").getContext("2d");
  const TOP = title ? 20 : 24, HEAD = title ? 46 : 0, PERF = 22;
  const hs = list.map((k, i) => kvHeight(probe, k, i === 0 && !title ? 24 : 20));
  const H = HEAD + hs.reduce((a, b) => a + b, 0) + PERF * (list.length - 1);
  const pad = 14, totalH = H + 8 + pad * 2, totalW = W + pad * 2;
  const scale = Math.min(3, 16000 / totalH, Math.sqrt(15e6 / (totalW * totalH)));
  const c = document.createElement("canvas");
  c.width = Math.round(totalW * scale); c.height = Math.round(totalH * scale);
  const ctx = c.getContext("2d"); ctx.scale(scale, scale); ctx.translate(pad, pad);
  ctx.save(); ctx.shadowColor = "rgba(70,40,20,.18)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  paperPath(ctx, H, true); ctx.fillStyle = "#FFF8E8"; ctx.fill(); ctx.restore();
  ctx.save(); paperPath(ctx, H, true); ctx.clip(); ctx.fillStyle = noisePattern(ctx); ctx.fillRect(0, 0, W, H + 10);
  let y = 0;
  if (title) {
    ctx.fillStyle = "#282522"; ctx.font = "600 13px " + FONT;
    spaced(ctx, title, W / 2, 30, 1.6, "center");
    y = HEAD - 20;
    ctx.save(); ctx.strokeStyle = "rgba(40,37,34,.38)"; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(M, HEAD - .5); ctx.lineTo(W - M, HEAD - .5); ctx.stroke(); ctx.restore();
    y = HEAD;
  }
  for (let i = 0; i < list.length; i++) {
    const top = i === 0 && !title ? 24 : 20;
    const end = await drawKvAt(ctx, list[i], y, top);
    y = y + hs[i];
    if (i < list.length - 1) {
      ctx.save(); ctx.strokeStyle = "rgba(40,37,34,.3)"; ctx.lineWidth = 2; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(12, y + 11); ctx.lineTo(W - 12, y + 11); ctx.stroke(); ctx.restore();
      ctx.save(); ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath(); ctx.arc(0, y + 11, 7, 0, 7); ctx.arc(W, y + 11, 7, 0, 7); ctx.fill(); ctx.restore();
      y += PERF;
    }
    void end;
  }
  ctx.restore();
  return new Promise(r => c.toBlob(r, "image/png"));
}

/* Saving: share sheet on iPhone ("Сохранить изображение"), a download elsewhere.
   Safari only allows sharing straight from a tap, so the picture is prepared ahead of time. */
let ready = { key: "", blob: null, p: null };
function prepare(key, make) {
  if (ready.key === key && (ready.blob || ready.p)) return ready.p || Promise.resolve(ready.blob);
  ready = { key, blob: null, p: null };
  const r = ready;
  r.p = make().then(b => { r.blob = b; r.p = null; return b; });
  return r.p;
}
const kvKey = k => "kv:" + k.date + ":" + k.no + ":" + k.photos.map(p => p.id).join(",") + ":" + (k.caption || "");
function prepareExport(k) { return prepare(kvKey(k), () => renderPNG([k])); }
function shareNow(blob, name) {
  const file = new File([blob], name, { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file] }).catch(e => { if (e && e.name !== "AbortError") previewSheet(blob, name); });
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Картинка сохранена");
  return Promise.resolve();
}
function previewSheet(blob, name, title) {
  const u = URL.createObjectURL(blob);
  sheet('<h2>' + esc(title || "Картинка готова") + '</h2><div class="preview"><img src="' + u + '" alt="Квиток картинкой"></div><p>Если кнопка не сработала, нажмите на картинку и удерживайте, чтобы сохранить её в Фото.</p><div class="list"><button class="btn primary" data-s="share">Сохранить картинкой</button><button class="btn" data-s="close">Готово</button></div>', {
    share: () => shareNow(blob, name)
  }, () => URL.revokeObjectURL(u));
}
function saveKv(k) {
  const name = "kvitok-" + pad(k.no, 4) + "-" + k.date + ".png";
  const p = prepareExport(k);
  if (ready.blob) shareNow(ready.blob, name);
  else { sheetWait("Готовлю картинку…"); p.then(b => previewSheet(b, name)); }
}
function saveMonth(list, ym) {
  const [y, m] = ym.split("-"), title = MONTHS_UP[+m - 1] + " " + y, name = "rulon-" + ym + ".png";
  sheetWait("Склеиваю рулон за " + MONTHS[+m - 1].toLowerCase() + "…");
  prepare("m:" + ym + ":" + list.map(kvKey).join("|"), () => renderPNG(list, title)).then(b => previewSheet(b, name, "Рулон за " + MONTHS[+m - 1].toLowerCase()));
}

/* ---------- roll ---------- */
const rollEl = $("#roll");
function monthLabel(ym) { return MONTHS[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4); }
function shiftMonth(ym, d) { const t = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + d, 1); return t.getFullYear() + "-" + pad(t.getMonth() + 1); }
function oldPhotoKeys() {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && /^hb2027:photo-\d{4}-\d{2}-\d{2}$/.test(k)) out.push(k); } } catch (_) {}
  return out.sort();
}
async function renderRoll() {
  const all = (await dall("kv")).sort((a, b) => a.date < b.date ? -1 : 1);
  const nowYm = todayKey().slice(0, 7);
  const first = all.length ? (all[0].date.slice(0, 7) < nowYm ? all[0].date.slice(0, 7) : nowYm) : nowYm;
  const last = all.length && all[all.length - 1].date.slice(0, 7) > nowYm ? all[all.length - 1].date.slice(0, 7) : nowYm;
  S.rollMonth = S.rollMonth < first ? first : S.rollMonth > last ? last : S.rollMonth;
  const list = all.filter(k => k.date.startsWith(S.rollMonth));
  const chev = d => '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  let h = '<div class="roll-head"><button class="icon-btn" data-r="prev" aria-label="Предыдущий месяц"' + (S.rollMonth <= first ? " disabled" : "") + ">" + chev("M15 5l-7 7 7 7") + "</button><h1>" + monthLabel(S.rollMonth) + '</h1><button class="icon-btn" data-r="next" aria-label="Следующий месяц"' + (S.rollMonth >= last ? " disabled" : "") + ">" + chev("M9 5l7 7-7 7") + "</button></div>";
  h += '<p class="roll-sub">' + (list.length ? list.length + " " + plural(list.length, "квиток", "квитка", "квитков") : "Пока пусто") + "</p>";
  const meta = await dget("meta", "import");
  const old = oldPhotoKeys().filter(k => !all.some(x => x.date === k.slice(13)));
  if (old.length && !(meta && meta.done)) {
    h += '<div class="note"><span>В старом Хобоничи ' + old.length + " " + plural(old.length, "день", "дня", "дней") + ' с фото. Перенести их в рулон квитками? Старый дневник останется как был.</span><div class="row"><button class="btn primary" data-r="import">Перенести</button><button class="btn" data-r="noimport">Не сейчас</button></div></div>';
  }
  if (list.length) {
    h += '<div class="strip">' + list.map((k, i) => kvHTML(k, { stamp: true, teeth: i === list.length - 1 })).join('<div class="perf" aria-hidden="true"></div>') + "</div>";
    h += '<div class="actions" style="margin:26px auto 0;padding:0 16px"><button class="btn" data-r="month">Сохранить месяц картинкой</button></div>';
  } else {
    h += '<div class="empty"><b>' + (S.rollMonth === nowYm ? "В этом месяце ещё нет квитков" : "В этом месяце квитков нет") + "</b>" + (S.rollMonth === nowYm ? "Напечатайте сегодняшний, и он появится здесь." : "") + "</div>";
  }
  h += '<a class="oldlink" href="../">Открыть старый Хобоничи</a>';
  rollEl.innerHTML = h;
  rollEl._list = list;
  fillImgs(rollEl);
}
rollEl.addEventListener("click", async e => {
  const b = e.target.closest("[data-r]");
  if (b && !b.disabled) {
    const a = b.dataset.r;
    if (a === "prev" || a === "next") { S.rollMonth = shiftMonth(S.rollMonth, a === "prev" ? -1 : 1); renderRoll(); }
    else if (a === "month") saveMonth(rollEl._list, S.rollMonth);
    else if (a === "noimport") { await dput("meta", { key: "import", done: true }); renderRoll(); }
    else if (a === "import") { b.disabled = true; b.textContent = "Переношу…"; const n = await importOld(); toast("Перенесено: " + n + " " + plural(n, "квиток", "квитка", "квитков")); renderRoll(); }
    return;
  }
  const kv = e.target.closest(".strip .kv");
  if (kv) openKv(rollEl._list.find(k => k.date === kv.dataset.date));
});
function openKv(k) {
  if (!k) return;
  const isToday = k.date === todayKey();
  prepareExport(k);
  sheet('<div class="kvbox">' + kvHTML(k, { stamp: true }) + '</div><div class="list"><button class="btn primary" data-s="save">Сохранить картинкой</button>' + (isToday ? '<button class="btn" data-s="edit">Изменить подпись или фото</button>' : "") + '<button class="btn" data-s="close">Закрыть</button></div>', {
    save: () => saveKv(k),
    edit: () => { closeSheet(); go("today"); setTimeout(() => { ensureDraft(); S.mode = "draft"; saveDraft(true); renderToday(); }, 0); }
  });
  fillImgs($(".sheet"));
}
/* old Hobonichi stamps (same site, localStorage) become receipts; the old diary is not touched */
async function importOld() {
  const have = new Set((await dall("kv")).map(k => k.date));
  let no = await nextNo(), n = 0;
  for (const key of oldPhotoKeys()) {
    const date = key.slice(13);
    if (have.has(date)) continue;
    try {
      const v = JSON.parse(localStorage.getItem(key));
      if (!v || !v.img) continue;
      const blob = await (await fetch(v.img)).blob();
      const img = await loadImage(v.img);
      const id = "h" + date.replace(/-/g, "") + Math.random().toString(36).slice(2, 6);
      await dput("ph", { id, blob, w: img.naturalWidth, h: img.naturalHeight });
      await dput("kv", { date, no: no++, photos: [{ id, w: img.naturalWidth, h: img.naturalHeight }], caption: "", printedAt: Date.now(), createdAt: Date.now(), imported: true });
      n++;
    } catch (_) {}
  }
  await dput("meta", { key: "import", done: true });
  if (!S.kv) { S.nextNo = await nextNo(); if (S.tab === "today") renderToday(); }
  return n;
}

/* ---------- sheet + toast ---------- */
let sheetEl = null, sheetH = {}, sheetClose = null;
function sheet(html, handlers, onClose) {
  closeSheet();
  sheetH = handlers || {}; sheetClose = onClose || null;
  sheetEl = document.createElement("div"); sheetEl.className = "sheet-root";
  sheetEl.innerHTML = '<div class="sheet-bg" data-s="close"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grip"></div>' + html + "</div>";
  document.body.appendChild(sheetEl); document.body.classList.add("no-scroll");
  sheetEl.addEventListener("click", e => { const b = e.target.closest("[data-s]"); if (!b) return; const a = b.dataset.s; if (a === "close") closeSheet(); else if (sheetH[a]) sheetH[a](); });
}
function sheetWait(text) { sheet('<h2>' + esc(text) + "</h2><p>Это займёт пару секунд.</p>"); }
function closeSheet() { if (!sheetEl) return; sheetEl.remove(); sheetEl = null; document.body.classList.remove("no-scroll"); if (sheetClose) sheetClose(); sheetClose = null; }
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
let toastT = 0;
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2600); }

/* ---------- tabs ---------- */
function go(tab, push = true) {
  S.tab = tab;
  $("#today").hidden = tab !== "today"; rollEl.hidden = tab !== "roll";
  for (const [id, t] of [["#tab-today", "today"], ["#tab-roll", "roll"]]) { if (tab === t) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current"); }
  if (push) { try { history.replaceState(null, "", tab === "roll" ? "#roll" : location.pathname + location.search); } catch (_) {} }
  window.scrollTo(0, 0);
  renderActions();
  if (tab === "roll") renderRoll(); else if (S.date !== todayKey()) loadToday(); else { measure(); setOff(S.off); }
}
$("#tab-today").onclick = () => go("today");
$("#tab-roll").onclick = () => go("roll");
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.date !== todayKey() && !S.busy) loadToday(); });
window.addEventListener("resize", () => { if (S.tab === "today" && !S.busy) renderToday(); });

/* ---------- start ---------- */
(async () => {
  try {
    await db();
    await loadToday();
    if (document.fonts) document.fonts.ready.then(() => { if (!S.busy && S.tab === "today") renderToday(); });
    if (location.hash === "#roll") go("roll", false);
  } catch (e) {
    wrap.innerHTML = '<article class="kv"><p class="kv-cap" style="display:block">Браузер не дал сохранять данные. Откройте приложение в Safari не в режиме «Частный доступ».</p><div class="kv-teeth"></div></article>';
    measure(); setOff(0);
  }
})();
})();
