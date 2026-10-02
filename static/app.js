"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const DIRECT_EXT = [".wav", ".mp3", ".flac"];
const SPEAKER_COLORS = ["#1f5fbf", "#c2410c", "#15803d", "#7c3aed", "#be185d", "#0e7490", "#a16207", "#4b5563"];

let config = null;
let selectedFile = null;
let selectedDuration = null;
let current = null; // 編集中の議事録
let saveTimer = null;

// ------------------------------------------------------------ 共通

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 空の応答 */ }
  if (!res.ok) throw new Error((data && data.error) || "通信エラー（" + res.status + "）");
  return data;
}
const postJSON = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" : "") + String(m).padStart(h ? 2 : 1, "0") + ":" + String(s).padStart(2, "0");
}
function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return h + "時間" + m + "分";
  if (m) return m + "分" + (s ? s + "秒" : "");
  return s + "秒";
}
function usdToYen(usd) { return usd * Number(config.jpy_per_usd || 150); }
function fmtYen(yen) {
  if (yen < 1) return "1円未満（約" + yen.toFixed(2) + "円）";
  return "約" + Math.round(yen).toLocaleString() + "円";
}
function costOf(sec) {
  const usd = sec / 3600 * Number(config.price_usd_per_hour || 0);
  return { usd, yen: usdToYen(usd) };
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function localDate(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function extOf(name) { const i = name.lastIndexOf("."); return i >= 0 ? name.slice(i).toLowerCase() : ""; }

function modal(title, html, { okText = "OK", cancel = true } = {}) {
  return new Promise((resolve) => {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal-ok").textContent = okText;
    $("#modal-cancel").classList.toggle("hidden", !cancel);
    $("#modal").classList.remove("hidden");
    const done = (v) => { $("#modal").classList.add("hidden"); resolve(v); };
    $("#modal-ok").onclick = () => done(true);
    $("#modal-cancel").onclick = () => done(false);
  });
}

// ------------------------------------------------------------ タブ

function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === "history") loadHistory();
  if (name === "cost") loadCost();
  if (name === "settings") fillSettings();
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab],[data-goto]");
  if (!t) return;
  e.preventDefault();
  showTab(t.dataset.tab || t.dataset.goto);
});

// ------------------------------------------------------------ 設定

async function loadConfig() {
  config = await api("/api/config");
  $("#setup-banner").classList.toggle("hidden", config.has_key);
  // プレビュー価格の期限（2026/12/31）を過ぎたら単価の確認を促す
  const expired = config.today > "2026-12-31" && Number(config.price_usd_per_hour) === 0.10;
  const pb = $("#price-banner");
  pb.classList.toggle("hidden", !expired);
  if (expired) {
    pb.innerHTML = "MAI-Transcribe-2 の期間限定価格（2026年12月31日まで）が終了している可能性があります。" +
      "<a href='https://azure.microsoft.com/ja-jp/pricing/details/speech/' target='_blank' rel='noopener'>料金ページ</a>で最新の単価を確認し、" +
      "<a href='#' data-goto='settings'>初期設定</a>の単価を更新してください。";
  }
  if (!$("#opt-phrases").value && config.default_phrases?.length) {
    $("#opt-phrases").value = config.default_phrases.join("\n");
  }
}

function fillSettings() {
  $("#key-now").innerHTML = config.has_key
    ? "現在のキー：<code>" + esc(config.api_key_masked) + "</code>（変更するときだけ下に新しいキーを貼り付け）"
    : "<span class='warn-text'>まだ設定されていません</span>";
  $("#set-endpoint").value = config.endpoint || "";
  $("#set-region").innerHTML = config.supported_regions.map((r) => {
    const label = { southeastasia: "Southeast Asia（東南アジア・シンガポール）★おすすめ", centralindia: "Central India（インド中部）",
      eastus: "East US（米国東部）", westus: "West US（米国西部）", westus2: "West US 2（米国西部2）",
      northeurope: "North Europe（北ヨーロッパ）" }[r] || r;
    return `<option value="${r}" ${r === config.region ? "selected" : ""}>${label}</option>`;
  }).join("");
  $("#set-price").value = config.price_usd_per_hour;
  $("#set-fx").value = config.jpy_per_usd;
  $("#set-budget").value = config.monthly_budget_jpy;
  $("#set-phrases").value = (config.default_phrases || []).join("\n");
  $("#conv-state").innerHTML = config.converter
    ? "✅ 音声変換ツール（" + esc(config.converter) + "）が使えます。M4A・MP4 など、ほとんどの形式をそのまま扱えます。"
    : "ℹ️ 音声変換ツールが見つかりません。MP3・WAV・FLAC はそのまま使えます。それ以外の形式（M4A・MP4 など）は" +
      "ブラウザ内で変換しますが、長い録音では時間がかかったり失敗したりすることがあります。";
}

function setMsg(el, text, ok) {
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "ng");
}

$("#show-key").addEventListener("change", (e) => { $("#set-key").type = e.target.checked ? "text" : "password"; });

$("#save-btn").addEventListener("click", async () => {
  const key = $("#set-key").value.trim();
  const endpoint = $("#set-endpoint").value.trim();
  if (!config.has_key && !key) return setMsg($("#set-msg"), "APIキーを入力してください。", false);
  if (endpoint && !/^https?:\/\//.test(endpoint)) return setMsg($("#set-msg"), "エンドポイントは https:// から始まるURLを貼り付けてください。", false);
  try {
    await postJSON("/api/config", { api_key: key, endpoint, region: $("#set-region").value });
    $("#set-key").value = "";
    await loadConfig(); fillSettings();
    setMsg($("#set-msg"), "保存しました。続けて「接続テスト」を押してください。", true);
  } catch (e) { setMsg($("#set-msg"), e.message, false); }
});

$("#test-btn").addEventListener("click", async () => {
  const btn = $("#test-btn");
  btn.disabled = true;
  setMsg($("#set-msg"), "確認しています…", true);
  try {
    await postJSON("/api/test", {});
    setMsg($("#set-msg"), "✅ 接続できました！「① 文字起こし」から使い始められます。", true);
  } catch (e) { setMsg($("#set-msg"), e.message, false); }
  btn.disabled = false;
});

$("#save-price-btn").addEventListener("click", async () => {
  try {
    await postJSON("/api/config", {
      price_usd_per_hour: Number($("#set-price").value), jpy_per_usd: Number($("#set-fx").value),
      monthly_budget_jpy: Number($("#set-budget").value),
    });
    await loadConfig();
    setMsg($("#price-msg"), "保存しました。", true);
  } catch (e) { setMsg($("#price-msg"), e.message, false); }
});

$("#save-phr-btn").addEventListener("click", async () => {
  const list = $("#set-phrases").value.split("\n").map((s) => s.trim()).filter(Boolean);
  try {
    await postJSON("/api/config", { default_phrases: list });
    await loadConfig();
    $("#opt-phrases").value = list.join("\n");
    setMsg($("#phr-msg"), "保存しました。", true);
  } catch (e) { setMsg($("#phr-msg"), e.message, false); }
});

// ------------------------------------------------------------ ファイル選択

const dz = $("#dropzone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault(); dz.classList.remove("over");
  if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
});
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file-input").click(); } });
$("#file-input").addEventListener("change", (e) => { if (e.target.files[0]) pickFile(e.target.files[0]); });
$("#file-clear").addEventListener("click", () => {
  selectedFile = null; selectedDuration = null; $("#file-input").value = "";
  $("#file-card").classList.add("hidden"); dz.classList.remove("hidden"); updateStart();
});

function probeDuration(file) {
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith("video") ? "video" : "audio");
    const url = URL.createObjectURL(file);
    const finish = (v) => { URL.revokeObjectURL(url); resolve(v); };
    el.preload = "metadata";
    el.onloadedmetadata = () => finish(isFinite(el.duration) ? el.duration : null);
    el.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
    el.src = url;
  });
}

async function pickFile(file) {
  selectedFile = file;
  if (!$("#opt-title").value) $("#opt-title").value = file.name.replace(/\.[^.]+$/, "");
  $("#file-name").textContent = file.name;
  $("#file-meta").textContent = (file.size / 1024 / 1024).toFixed(1) + " MB ・ 長さを確認中…";
  $("#estimate").innerHTML = "";
  dz.classList.add("hidden");
  $("#file-card").classList.remove("hidden");
  selectedDuration = await probeDuration(file);
  if (selectedFile !== file) return;
  const size = (file.size / 1024 / 1024).toFixed(1) + " MB";
  if (selectedDuration) {
    const c = costOf(selectedDuration);
    $("#file-meta").textContent = size + " ・ 長さ " + fmtDuration(selectedDuration);
    let warn = "";
    if (selectedDuration > 5 * 3600) warn = "<br><span class='warn-text'>5時間を超える録音は処理できません。録音を分けてください。</span>";
    $("#estimate").innerHTML = "💴 この録音の料金の目安：<b>" + fmtYen(c.yen) + "</b>" +
      "<span class='muted small'>（" + fmtDuration(selectedDuration) + " × 1時間あたり $" + config.price_usd_per_hour +
      "、1ドル=" + config.jpy_per_usd + "円で計算）</span>" + warn;
  } else {
    $("#file-meta").textContent = size + " ・ 長さはこのブラウザでは確認できませんでした";
    $("#estimate").innerHTML = "💴 料金は録音の長さで決まります（1時間あたり約" +
      Math.round(usdToYen(config.price_usd_per_hour)) + "円）。処理後に「③ 料金と利用状況」で確認できます。";
  }
  updateStart();
}

function updateStart() {
  const ready = !!selectedFile && config.has_key;
  $("#start-btn").disabled = !ready;
  $("#start-hint").textContent = !config.has_key ? "先に「④ 初期設定」で APIキーを設定してください"
    : !selectedFile ? "録音ファイルを選ぶとボタンが押せるようになります" : "準備ができました";
}

// ------------------------------------------------------------ ブラウザ内での変換（変換ツールがない場合）

async function convertInBrowser(file) {
  const buf = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const decoded = await ctx.decodeAudioData(buf);
  ctx.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVEfmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true);
  out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new File([out.buffer], file.name.replace(/\.[^.]+$/, "") + ".wav", { type: "audio/wav" });
}

// ------------------------------------------------------------ 文字起こし実行

function setStep(step, pct) {
  const order = ["upload", "convert", "transcribe", "done"];
  const idx = order.indexOf(step);
  $$("#steps li").forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.className = i < idx ? "fin" : i === idx ? "now" : "";
  });
  const bar = $("#bar-fill").parentElement;
  if (pct == null) { bar.classList.add("indeterminate"); $("#bar-fill").style.width = ""; }
  else { bar.classList.remove("indeterminate"); $("#bar-fill").style.width = pct + "%"; }
}

function uploadWithProgress(file, opts) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-Options", encodeURIComponent(JSON.stringify(opts)));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setStep("upload", Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => {
      let d = {}; try { d = JSON.parse(xhr.responseText); } catch (_) {}
      xhr.status === 200 ? resolve(d.job_id) : reject(new Error(d.error || "読み込みに失敗しました"));
    };
    xhr.onerror = () => reject(new Error("アプリとの通信が切れました。アプリ（黒い画面）が起動しているか確認してください。"));
    xhr.send(file);
  });
}

$("#start-btn").addEventListener("click", async () => {
  if (!selectedFile) return;
  let costLine = "料金は録音の長さに応じてかかります。";
  if (selectedDuration) costLine = "長さ <b>" + fmtDuration(selectedDuration) + "</b>、料金の目安は <b>" + fmtYen(costOf(selectedDuration).yen) + "</b> です。";
  const ok = await modal("文字起こしを始めますか？",
    "<p>" + costLine + "</p><p class='muted small'>音声は Microsoft Azure（" + esc(config.endpoint ? "設定したリソース" : config.region) +
    "）に送られて処理されます。</p>", { okText: "始める" });
  if (!ok) return;

  const opts = {
    title: $("#opt-title").value.trim(),
    meeting_date: $("#opt-date").value,
    diarization: $("#opt-diar").checked,
    clean: $("#opt-clean").checked,
    language: $("#opt-lang").value,
    phrases: $("#opt-phrases").value.split("\n").map((s) => s.trim()).filter(Boolean),
  };
  $("#upload-area").classList.add("hidden");
  $("#error-area").classList.add("hidden");
  $("#progress-area").classList.remove("hidden");
  $("#progress-msg").textContent = "";

  try {
    let file = selectedFile;
    if (!config.converter && !DIRECT_EXT.includes(extOf(file.name))) {
      setStep("convert", null);
      $("#progress-msg").textContent = "ブラウザ内で音声を変換しています（長い録音では数分かかります）…";
      try { file = await convertInBrowser(file); }
      catch (e) { throw new Error("この形式の音声をブラウザで変換できませんでした。MP3 か WAV に変換してからお試しください。"); }
    }
    setStep("upload", 0);
    const jobId = await uploadWithProgress(file, opts);
    await pollJob(jobId);
  } catch (e) { showError(e.message); }
});

async function pollJob(jobId) {
  for (;;) {
    const job = await api("/api/jobs/" + jobId);
    $("#progress-msg").textContent = job.message || "";
    if (job.stage === "convert") setStep("convert", null);
    if (job.stage === "transcribe") setStep("transcribe", null);
    if (job.stage === "error") throw new Error(job.message);
    if (job.stage === "done") {
      setStep("done", 100);
      resetUpload();
      await openTranscript(job.transcript_id, { justDone: true });
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function showError(msg) {
  $("#progress-area").classList.add("hidden");
  $("#error-area").classList.remove("hidden");
  $("#error-msg").textContent = msg;
}
$("#error-back").addEventListener("click", () => {
  $("#error-area").classList.add("hidden");
  $("#upload-area").classList.remove("hidden");
});

function resetUpload() {
  $("#progress-area").classList.add("hidden");
  $("#upload-area").classList.remove("hidden");
  $("#file-clear").click();
  $("#opt-title").value = "";
}

// ------------------------------------------------------------ 議事録の表示と編集

function speakerKeys(doc) {
  return [...new Set(doc.segments.map((s) => s.speaker).filter((s) => s !== ""))];
}
function speakerName(doc, key) {
  if (key === "") return "";
  return (doc.speaker_names && doc.speaker_names[key]) || "話者" + key;
}
function speakerColor(doc, key) {
  return SPEAKER_COLORS[speakerKeys(doc).indexOf(key) % SPEAKER_COLORS.length];
}

async function openTranscript(id, { justDone = false } = {}) {
  current = await api("/api/transcripts/" + encodeURIComponent(id));
  current.speaker_names = current.speaker_names || {};
  $("#ed-title").value = current.title || "";
  $("#ed-date").value = current.meeting_date || "";
  $("#ed-attendees").value = current.attendees || "";
  $("#ed-meta").textContent = "元ファイル：" + current.file + " ／ 処理時間：" + fmtDuration(current.processing_seconds);
  $("#save-state").textContent = "保存済み";
  renderSpeakers();
  renderSegments();
  showTab("editor");
  await renderCostCard(current, justDone);
}

// 文字起こし時点の単価・為替で計算した金額（古い記録は現在の設定で計算）
function docCost(doc) {
  const rate = doc.price_usd_per_hour ?? Number(config.price_usd_per_hour);
  const fx = doc.jpy_per_usd ?? Number(config.jpy_per_usd);
  const usd = doc.cost_usd ?? (doc.duration_seconds || 0) / 3600 * rate;
  return { usd, yen: usd * fx, rate, fx };
}
function fmtYenPrecise(yen) {
  if (yen < 10) return "約 " + yen.toFixed(2) + " 円";
  return "約 " + Math.round(yen).toLocaleString() + " 円";
}

async function renderCostCard(doc, justDone) {
  const c = docCost(doc);
  $("#cost-card").classList.toggle("just-done", justDone);
  $("#cost-title").textContent = justDone ? "✅ 文字起こしが完了しました ― 今回の料金（概算）" : "この文字起こしの料金（概算）";
  $("#cost-yen").textContent = fmtYenPrecise(c.yen);
  $("#cost-usd").textContent = "$" + c.usd.toFixed(4) + "（1ドル = " + c.fx + " 円で換算）";
  $("#cost-len").textContent = fmtDuration(doc.duration_seconds);
  $("#cost-rate").textContent = "単価 1時間あたり $" + c.rate;
  try {
    const usage = await api("/api/usage");
    const month = localDate().slice(0, 7);
    const yen = usdToYen(usage.filter((u) => u.time.startsWith(month)).reduce((a, u) => a + u.usd, 0));
    const budget = Number(config.monthly_budget_jpy || 0);
    $("#cost-month").textContent = fmtYenPrecise(yen);
    $("#cost-budget").textContent = budget ? "月の予算 " + budget.toLocaleString() + " 円の " + (yen / budget * 100).toFixed(1) + "%" : "";
  } catch (_) {
    $("#cost-month").textContent = "-";
  }
}

function renderSpeakers() {
  const keys = speakerKeys(current);
  $("#speaker-card").classList.toggle("hidden", keys.length === 0);
  $("#speaker-list").innerHTML = keys.map((k) =>
    `<label class="speaker-item"><span class="chip" style="background:${speakerColor(current, k)}">話者${esc(k)}</span>
     <input type="text" data-spk="${esc(k)}" value="${esc(current.speaker_names[k] || "")}" placeholder="名前を入力"></label>`).join("");
  $$("#speaker-list input").forEach((inp) => inp.addEventListener("input", () => {
    current.speaker_names[inp.dataset.spk] = inp.value.trim();
    $$(`.seg [data-chip="${CSS.escape(inp.dataset.spk)}"]`).forEach((ch) => { ch.textContent = speakerName(current, inp.dataset.spk); });
    scheduleSave();
  }));
}

function renderSegments() {
  if (!current.segments.length) {
    $("#segments").innerHTML = "<p class='muted'>文字が検出されませんでした。録音に声が入っているか確認してください。</p>";
    return;
  }
  $("#segments").innerHTML = current.segments.map((s, i) => `
    <div class="seg">
      <div class="seg-time">${fmtTime(s.start)}</div>
      <div>
        ${s.speaker !== "" ? `<span class="chip" data-chip="${esc(s.speaker)}" style="background:${speakerColor(current, s.speaker)}">${esc(speakerName(current, s.speaker))}</span>` : ""}
        <div class="seg-text" contenteditable="true" spellcheck="false" data-i="${i}">${esc(s.text)}</div>
      </div>
    </div>`).join("");
  $$(".seg-text").forEach((el) => el.addEventListener("input", () => {
    current.segments[el.dataset.i].text = el.innerText.trim();
    scheduleSave();
  }));
}

["#ed-title", "#ed-date", "#ed-attendees"].forEach((s) => $(s).addEventListener("input", () => {
  current.title = $("#ed-title").value; current.meeting_date = $("#ed-date").value;
  current.attendees = $("#ed-attendees").value; scheduleSave();
}));

function scheduleSave() {
  $("#save-state").textContent = "保存中…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await postJSON("/api/transcripts/" + encodeURIComponent(current.id), {
        title: current.title, meeting_date: current.meeting_date, attendees: current.attendees,
        speaker_names: current.speaker_names, segments: current.segments,
      });
      $("#save-state").textContent = "✔ 自動保存しました";
    } catch (e) { $("#save-state").textContent = "⚠ 保存できませんでした：" + e.message; }
  }, 700);
}

// ------------------------------------------------------------ 書き出し

function lines(doc, withTime = true) {
  return doc.segments.map((s) => {
    const who = s.speaker !== "" ? speakerName(doc, s.speaker) + "：" : "";
    return (withTime ? "[" + fmtTime(s.start) + "] " : "") + who + s.text;
  });
}
function asText(doc) {
  return ["会議名：" + (doc.title || ""), "開催日：" + (doc.meeting_date || ""), "出席者：" + (doc.attendees || ""),
    "", "―――― 発言記録 ――――", "", ...lines(doc)].join("\n");
}
function asMarkdown(doc) {
  return ["# " + (doc.title || "議事録"), "", "- 開催日：" + (doc.meeting_date || ""), "- 出席者：" + (doc.attendees || ""),
    "", "## 発言記録", "", ...doc.segments.map((s) => {
      const who = s.speaker !== "" ? "**" + speakerName(doc, s.speaker) + "**：" : "";
      return "`" + fmtTime(s.start) + "` " + who + s.text + "  ";
    })].join("\n");
}
function asWord(doc) {
  const body = doc.segments.map((s) => {
    const who = s.speaker !== "" ? "<b>" + esc(speakerName(doc, s.speaker)) + "</b>：" : "";
    return `<p><span style="color:#888">[${fmtTime(s.start)}]</span> ${who}${esc(s.text)}</p>`;
  }).join("");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${esc(doc.title)}</title>
<style>body{font-family:"Yu Mincho","MS Mincho",serif;font-size:10.5pt;line-height:1.6}h1{font-size:16pt}td{padding:2pt 8pt}</style></head>
<body><h1>${esc(doc.title || "議事録")}</h1>
<table><tr><td>開催日</td><td>${esc(doc.meeting_date || "")}</td></tr><tr><td>出席者</td><td>${esc(doc.attendees || "")}</td></tr></table>
<h2>発言記録</h2>${body}</body></html>`;
}
function download(name, content, type) {
  const blob = new Blob([type.startsWith("text/plain") ? "﻿" + content : content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const baseName = () => ((current.meeting_date || "") + "_" + (current.title || "議事録")).replace(/[\\/:*?"<>|]/g, "_");
$("#dl-txt").addEventListener("click", () => download(baseName() + ".txt", asText(current), "text/plain;charset=utf-8"));
$("#dl-md").addEventListener("click", () => download(baseName() + ".md", asMarkdown(current), "text/markdown;charset=utf-8"));
$("#dl-word").addEventListener("click", () => download(baseName() + ".doc", asWord(current), "application/msword"));
$("#copy-btn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(asText(current)); $("#copy-btn").textContent = "✔ コピーしました"; }
  catch (_) { $("#copy-btn").textContent = "コピーできませんでした"; }
  setTimeout(() => { $("#copy-btn").textContent = "📋 コピー"; }, 2000);
});

// ------------------------------------------------------------ 履歴

async function loadHistory() {
  const items = await api("/api/transcripts");
  const box = $("#history-list");
  if (!items.length) {
    box.innerHTML = "<div class='card muted'>まだ議事録はありません。「① 文字起こし」から始めましょう。</div>";
    return;
  }
  box.innerHTML = items.map((d) => `
    <div class="card history-item" data-open="${esc(d.id)}">
      <div>
        <div class="history-title">${esc(d.title || "(無題)")}</div>
        <div class="muted small">開催日 ${esc(d.meeting_date || "-")} ・ ${fmtDuration(d.duration_seconds)} ・ 料金（概算） ${fmtYenPrecise(docCost(d).yen)}</div>
      </div>
      <button class="danger" data-del="${esc(d.id)}">削除</button>
    </div>`).join("");
  $$("[data-open]").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("[data-del]")) return;
    openTranscript(el.dataset.open);
  }));
  $$("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await modal("削除しますか？", "<p>この議事録をパソコンから削除します。元に戻せません。</p>", { okText: "削除する" }))) return;
    await postJSON("/api/transcripts/" + encodeURIComponent(b.dataset.del), { delete: true });
    loadHistory();
  }));
}

// ------------------------------------------------------------ 料金と利用状況

async function loadCost() {
  const usage = await api("/api/usage");
  const month = localDate().slice(0, 7);
  const thisMonth = usage.filter((u) => u.time.startsWith(month));
  const sec = thisMonth.reduce((a, u) => a + u.seconds, 0);
  const yen = usdToYen(thisMonth.reduce((a, u) => a + u.usd, 0));
  const budget = Number(config.monthly_budget_jpy || 0);
  $("#st-min").textContent = fmtDuration(sec);
  $("#st-yen").textContent = yen < 1 ? "1円未満" : "約" + Math.round(yen).toLocaleString() + "円";
  $("#st-budget").textContent = budget ? budget.toLocaleString() + "円" : "未設定";
  const pct = budget ? Math.min(100, yen / budget * 100) : 0;
  $("#budget-fill").style.width = pct + "%";
  $("#budget-fill").style.background = pct >= 100 ? "var(--err)" : pct >= 80 ? "#d97706" : "var(--accent)";
  const remainHours = budget && config.price_usd_per_hour > 0 ? Math.max(0, budget - yen) / usdToYen(config.price_usd_per_hour) : null;
  $("#budget-text").textContent = budget
    ? "予算の " + pct.toFixed(1) + "% を使用。" + (remainHours != null ? "残りの予算で、あと約 " + Math.floor(remainHours) + " 時間分の録音を文字起こしできます。" : "")
    : "";

  const p = Number(config.price_usd_per_hour);
  $("#price-now").textContent = "1時間あたり $" + p + "（約" + Math.round(usdToYen(p) * 10) / 10 + "円）";
  $("#price-note").textContent = config.price_note || "";
  $("#fx").textContent = config.jpy_per_usd;
  $("#price-table").innerHTML = [[60, "1分"], [1800, "30分の会議"], [3600, "1時間の会議"], [7200, "2時間の会議"], [72000, "1時間の会議 × 月20回"]]
    .map(([s, l]) => `<tr><td>${l}</td><td class="num">${fmtYen(costOf(s).yen)}（$${(costOf(s).usd).toFixed(3)}）</td></tr>`).join("");

  $("#usage-list").innerHTML = usage.length
    ? `<table class="table"><thead><tr><th>日時</th><th>内容</th><th>長さ</th><th>料金の目安</th></tr></thead><tbody>` +
      usage.slice().reverse().slice(0, 100).map((u) => `<tr><td>${esc(u.time.replace("T", " "))}</td><td>${esc(u.file)}</td>
        <td class="num">${fmtDuration(u.seconds)}</td><td class="num">${fmtYen(usdToYen(u.usd))}</td></tr>`).join("") + "</tbody></table>"
    : "<p class='muted'>まだ利用記録はありません。</p>";
}

// ------------------------------------------------------------ 起動

(async () => {
  $("#opt-date").value = localDate();
  try {
    await loadConfig();
    updateStart();
    if (!config.has_key) showTab("guide");
  } catch (e) {
    document.body.innerHTML = "<p style='padding:2rem'>アプリに接続できません。起動用のファイルからアプリを起動してください。</p>";
  }
})();
