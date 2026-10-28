// scripts/build.js - Progressive build (v2)
//
// Splits the catalog into three JSON files instead of inlining a single
// 4.5 MB JSON blob into index.html.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { sortCatalog } = require("./lib/catalog-utils");

const ROOT = path.resolve(__dirname, "..");
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;
const SITE_ORIGIN = "https://prompt-site.shop";
const ADSENSE_CLIENT = "ca-pub-5297416023272291";

function readNoBom(p) { let buf = fs.readFileSync(p); if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3); return buf.toString("utf8"); }

function slugId(id) { return String(id == null ? "" : id).replace(/[^a-zA-Z0-9._-]/g, "_"); }
function escHtml(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function fmtDate(v) { if (!v) return ""; const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); }
function catSlug(cat) { return slugId(cat || "uncategorized").toLowerCase(); }

function detectKind(abs) {
  try {
    const b = fs.readFileSync(abs).subarray(0, 16);
    const sig = b.toString("latin1");
    if (sig.startsWith("RIFF") && sig.includes("WEBP")) return "webp";
    if (sig.startsWith("#EXTM3U")) return "hls";
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return "webm";
    if (b.subarray(4, 8).toString() === "ftyp") return "mp4";
    if (b[0] === 0x47) return "gif";
    if (b[0] === 0x89) return "png";
    if (b[0] === 0xff) return "jpeg";
    const ext = path.extname(abs).toLowerCase();
    if (ext === ".webm") return "webm";
    if (ext === ".m3u8") return "hls";
    if (ext === ".mp4" || ext === ".mov" || ext === ".m4v") return "mp4";
    if (ext === ".webp") return "webp";
    if (ext === ".gif") return "gif";
    if (ext === ".png") return "png";
    if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  } catch (e) {}
  return "other";
}

function enrich(rec) {
  const o = Object.assign({}, rec);
  if (rec.local_rel) {
    function locAbs(p) {
      if (!p) return null;
      const a = path.join(ROOT, p);
      if (fs.existsSync(a)) return a;
      const b = path.join(ROOT, p.replace(/^assets\//, "assets/"));
      if (fs.existsSync(b)) return b;
      return a;
    }
    const abs = locAbs(rec.local_rel);
    if (abs && fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_PREVIEW_BYTES) {
        console.warn("[build] demoting over-limit preview", rec.id, (stat.size / 1048576).toFixed(2) + "MiB");
        o.local_rel = null;
        o.local_kind = "other";
        o.size_bytes = stat.size;
      } else {
        o.local_kind = detectKind(abs);
        o.size_bytes = stat.size;
      }
    } else {
      o.local_kind = "other";
    }
  }
  return o;
}

// ---- Load source data ----
const mergedRaw = JSON.parse(readNoBom(path.join(ROOT, "data", "ms_prompts_merged.json")));
const merged = mergedRaw.map(function (x) { if (x.local_rel && x.local_rel.startsWith("assets/")) x.local_rel = x.local_rel.replace(/^motionsites_assets\//, "assets/"); return x; });

const t1 = JSON.parse(readNoBom(path.join(ROOT, "data", "ms_prompts_with_text.json")));
const t1map = new Map(t1.map(function (x) { return [x.id, x.prompt_text || ""]; }));

const root2 = path.join(ROOT, "sources", "akkikumar72", "liro-prompts");
if (fs.existsSync(root2)) {
  for (const dir of fs.readdirSync(root2)) {
    if (dir.toLowerCase() === "index.md") continue;
    const mp = path.join(root2, dir, "metadata.json");
    if (!fs.existsSync(mp)) continue;
    let m;
    try { m = JSON.parse(readNoBom(mp)).record; } catch (e) { continue; }
    if (!m || !m.id) continue;
    if (!t1map.has(m.id)) {
      const wp = path.join(root2, dir, "working-prompt.md");
      if (fs.existsSync(wp)) {
        const wk = readNoBom(wp);
        const idx = wk.indexOf("## Prompt");
        const body = idx < 0 ? wk : wk.slice(idx + "## Prompt".length).replace(/```[a-z]*\n([\s\S]*?)\n```/g, "$1").trim();
        if (body.length > 200) t1map.set(m.id, body);
      }
    }
  }
}

const sortedMeta = sortCatalog(merged);
const prompts = sortedMeta.map(function (x) { return Object.assign({}, x, { prompt_text: t1map.get(x.id) || "" }); });
const enriched = prompts.map(enrich);

const complete = enriched.filter(function (x) { return x.prompt_text && x.prompt_text.trim(); }).length;
const images = enriched.filter(function (x) { return x.local_kind === "webp" || x.local_kind === "gif" || x.local_kind === "png" || x.local_kind === "jpeg"; }).length;
const videos = enriched.filter(function (x) { return x.local_kind === "mp4" || x.local_kind === "webm" || x.local_kind === "hls"; }).length;
const noMedia = enriched.filter(function (x) { return !x.local_rel; }).length;
const community = enriched.filter(function (x) { return x.source_kind === "community"; }).length;
const motionsites = enriched.filter(function (x) { return (x.source_kind || "motionsites") === "motionsites"; }).length;
console.log("Records=" + enriched.length + " complete=" + complete + " images=" + images + " videos=" + videos + " concepts=" + noMedia + " motionsites=" + motionsites + " community=" + community);

// ---- Build the three progressive JSON files ----
const counts = {};
for (const r of enriched) counts[r.category] = (counts[r.category] || 0) + 1;
const topCats = Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 9).map(function (c) { return { category: c[0], count: c[1] }; });
const lite = { total: enriched.length, complete: complete, images: images, videos: videos, concepts: noMedia, motionsites: motionsites, community: community, topCategories: topCats, categories: counts, version: 2 };

const meta = enriched.map(function (r) { const o = {}; for (const k of Object.keys(r)) { if (k === "prompt_text") continue; o[k] = r[k]; } return o; });

const textMap = {};
for (const r of enriched) { if (r.prompt_text && r.prompt_text.trim()) textMap[r.id] = r.prompt_text; }

const dataDir = path.join(ROOT, "data");
fs.mkdirSync(dataDir, { recursive: true });

function writeJsonGz(name, obj) {
  const s = JSON.stringify(obj);
  const jsonPath = path.join(dataDir, name + ".json");
  const gzPath = path.join(dataDir, name + ".json.gz");
  fs.writeFileSync(jsonPath, s, "utf8");
  fs.writeFileSync(gzPath, zlib.gzipSync(Buffer.from(s, "utf8"), { level: 9 }));
  console.log("Wrote " + name + ".json  " + (s.length / 1024).toFixed(1) + " KB  (gzip " + (fs.statSync(gzPath).size / 1024).toFixed(1) + " KB)");
}

writeJsonGz("catalog-lite", lite);
writeJsonGz("catalog-meta", meta);
writeJsonGz("catalog-text", textMap);

// ---- Per-id prompt files (so detail-modal fetches one body, not the whole file) ----
const txtDir = path.join(dataDir, "catalog-text");
fs.mkdirSync(txtDir, { recursive: true });
const txtIndex = {};
for (const id of Object.keys(textMap)) {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  fs.writeFileSync(path.join(txtDir, safe + ".txt"), textMap[id], "utf8");
  txtIndex[id] = "catalog-text/" + safe + ".txt";
}
fs.writeFileSync(path.join(dataDir, "catalog-text-index.json"), JSON.stringify(txtIndex), "utf8");
console.log("Wrote catalog-text/  " + Object.keys(txtIndex).length + " files");

// ---- Static content pages: per-prompt detail pages + all.html + sitemap.xml ----
const SOURCE_LABELS = { motionsites: "MotionSites 公开库", community: "社区公开收藏", yilai: "yilai-ai 公开页面" };

function docNav(prefix) {
  return '<header class="site-head"><div class="inner">'
    + '<a class="brand" href="' + prefix + '"><span class="brand-dot"></span>MotionSites Prompts</a>'
    + '<nav class="site-nav">'
    + '<a href="' + prefix + 'all.html">全部提示词</a>'
    + '<a href="' + prefix + 'about.html">关于本站</a>'
    + '<a href="' + prefix + 'privacy.html">隐私政策</a>'
    + '<a href="' + prefix + 'contact.html">联系方式</a>'
    + '<a href="' + prefix + 'terms.html">使用条款</a>'
    + '<button class="theme-btn" type="button" data-theme-toggle aria-label="切换明暗主题">暗色</button>'
    + '</nav></div></header>';
}

function docFoot(prefix) {
  return '<footer class="site-foot"><nav>'
    + '<a href="' + prefix + 'all.html">全部提示词</a>'
    + '<a href="' + prefix + 'about.html">关于本站</a>'
    + '<a href="' + prefix + 'privacy.html">隐私政策</a>'
    + '<a href="' + prefix + 'contact.html">联系方式</a>'
    + '<a href="' + prefix + 'terms.html">使用条款</a>'
    + '</nav><div>© 2026 prompt-site.shop · 提示词版权归原作者所有</div></footer>';
}

function mediaBlock(rec, prefix) {
  if (!rec.local_rel) return "";
  const src = prefix + rec.local_rel;
  const alt = escHtml(rec.title + " 动效预览");
  if (rec.local_kind === "mp4" || rec.local_kind === "webm") {
    return '<div class="hero-media"><video src="' + src + '" autoplay muted loop playsinline preload="metadata"></video>'
      + '<div class="media-note">本地预览视频 · ' + escHtml(rec.local_kind) + '</div></div>';
  }
  if (rec.local_kind === "hls") {
    return '<div class="note-box">该条目的预览为流媒体（m3u8），无法直接内嵌播放，请在<a href="' + src + '">此链接</a>查看。</div>';
  }
  return '<div class="hero-media"><img src="' + src + '" alt="' + alt + '" loading="lazy">'
    + '<div class="media-note">本地预览图 · ' + escHtml(rec.local_kind) + '</div></div>';
}

function buildDetailPage(rec, related) {
  const slug = slugId(rec.id);
  const canonical = SITE_ORIGIN + "/p/" + slug + ".html";
  const text = (rec.prompt_text || "").trim();
  const cat = rec.category || "未分类";
  const hasOwnDesc = !!(rec.description && rec.description.trim() && rec.description.trim() !== rec.title.trim());
  const fallback = text
    ? text.replace(/\s+/g, " ").replace(/[`*#>|]+/g, " ").trim().slice(0, 150)
    : (rec.title + " 是 " + cat + " 分类下的动效 UI 提示词条目，原站暂未公开完整正文，可参考来源链接。");
  const desc = (hasOwnDesc ? rec.description.replace(/\s+/g, " ").slice(0, 155) : fallback);
  const descRaw = hasOwnDesc ? rec.description : "";
  const sourceLabel = SOURCE_LABELS[rec.source_kind] || "公开来源";
  const date = fmtDate(rec.created_at);

  let attr = "";
  if (rec.source_repo) attr += "源仓库：" + escHtml(rec.source_repo) + "<br>";
  if (rec.source_path) attr += "原始文件：<code>" + escHtml(rec.source_path) + "</code><br>";
  if (rec.source_license) attr += "许可证：" + escHtml(rec.source_license) + "<br>";
  if (rec.author) attr += "作者：" + escHtml(rec.author) + "<br>";
  if (rec.source_url) attr += '<a href="' + escHtml(rec.source_url) + '" rel="nofollow noopener" target="_blank">查看原始页面</a>';
  if (!attr) attr = "该条目来自公开提示词页面，原始出处信息未随页面提供。";

  const relatedHtml = related.length
    ? '<div class="related">' + related.map(function (r) {
      return '<a href="' + slugId(r.id) + '.html">' + escHtml(r.title) + '<small>' + escHtml(r.category || "未分类") + ' · ' + escHtml(r.type || "—") + '</small></a>';
    }).join("") + '</div>'
    : '<p class="muted">暂无同分类条目。</p>';

  const promptHtml = text
    ? '<div class="prompt-box"><button class="copy-btn" id="copy-btn" type="button">复制提示词</button><pre id="prompt-text">' + escHtml(text) + '</pre></div>'
    : '<div class="note-box">该条目暂无公开的完整正文，原站尚未发布或已下架。你可以参考上方的来源链接回到原始页面查看。</div>';

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    "name": rec.title,
    "description": (descRaw || fallback).slice(0, 300),
    "url": canonical,
    "inLanguage": "zh-CN",
    "genre": cat,
    "dateCreated": rec.created_at || undefined,
    "isPartOf": { "@type": "WebSite", "name": "MotionSites Prompts", "url": SITE_ORIGIN + "/" }
  };

  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n'
    + '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<title>' + escHtml(rec.title) + ' — ' + escHtml(cat) + ' 提示词 | MotionSites Prompts</title>\n'
    + '<meta name="description" content="' + escHtml(desc) + '">\n'
    + '<meta name="robots" content="index,follow,max-image-preview:large">\n'
    + '<meta name="google-adsense-account" content="' + ADSENSE_CLIENT + '">\n'
    + '<script src="../theme.js"></script>\n'
    + '<link rel="canonical" href="' + canonical + '">\n'
    + '<meta property="og:type" content="article">\n'
    + '<meta property="og:title" content="' + escHtml(rec.title) + ' — ' + escHtml(cat) + ' 提示词">\n'
    + '<meta property="og:description" content="' + escHtml(desc) + '">\n'
    + '<meta property="og:url" content="' + canonical + '">\n'
    + (rec.local_rel && (rec.local_kind === "webp" || rec.local_kind === "png" || rec.local_kind === "jpeg" || rec.local_kind === "gif")
      ? '<meta property="og:image" content="' + SITE_ORIGIN + "/" + rec.local_rel + '">\n' : '')
    + '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + ADSENSE_CLIENT + '" crossorigin="anonymous"></script>\n'
    + '<script type="application/ld+json">' + JSON.stringify(jsonLd) + '</script>\n'
    + '<link rel="stylesheet" href="../pages.css">\n</head>\n<body>\n'
    + docNav("../")
    + '<main class="wrap">'
    + '<div class="crumbs"><a href="../">首页</a> / <a href="../all.html">全部提示词</a> / <a href="../all.html#c-' + catSlug(cat) + '">' + escHtml(cat) + '</a></div>'
    + '<h1>' + escHtml(rec.title) + '</h1>'
    + '<div class="chip-row"><span class="chip">' + escHtml(cat) + '</span><span class="chip">' + escHtml(rec.type || "—") + '</span><span class="chip">' + escHtml(sourceLabel) + '</span>'
    + (rec.is_free === false ? '<span class="chip">付费条目</span>' : '') + '</div>'
    + '<div class="facts">' + (date ? '<span>收录时间：' + date + '</span>' : '') + '<span>正文：' + (text ? text.length.toLocaleString() + " 字符" : "未公开") + '</span></div>'
    + mediaBlock(rec, "../")
    + (descRaw ? '<h2>简介</h2><p>' + escHtml(descRaw) + '</p>' : '')
    + '<h2>完整提示词</h2>' + promptHtml
    + '<div class="note-box">把上面的提示词完整复制到支持长文本的 AI 工具中，再按需要替换品牌名、配色与文案。提示词描述的是整页结构与动效节奏，生成后建议在真实浏览器里检查首屏加载和移动端表现。</div>'
    + '<h2>来源与版权</h2><p>' + attr + '</p>'
    + '<p class="muted">提示词文本与预览素材的版权归原作者或原平台所有，本站仅作索引与归档。若你是权利人并希望移除本条内容，请通过<a href="../contact.html">联系方式</a>告知。</p>'
    + '<h2>同分类提示词</h2>' + relatedHtml
    + '<p class="home-link"><a href="../">← 返回提示词库</a></p>'
    + '</main>\n' + docFoot("../")
    + (text ? '<script>(function(){var b=document.getElementById("copy-btn"),t=document.getElementById("prompt-text");if(!b||!t)return;function done(){b.textContent="已复制";setTimeout(function(){b.textContent="复制提示词"},1600)}function fb(){var r=document.createRange();r.selectNodeContents(t);var s=window.getSelection();s.removeAllRanges();s.addRange(r);try{document.execCommand("copy");done()}catch(e){}}b.addEventListener("click",function(){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t.textContent).then(done,fb)}else{fb()}})})();</script>\n' : '')
    + '</body>\n</html>\n';
}

const pagesDir = path.join(ROOT, "p");
fs.rmSync(pagesDir, { recursive: true, force: true });
fs.mkdirSync(pagesDir, { recursive: true });

for (const rec of enriched) {
  const rel = enriched.filter(function (r) { return r.id !== rec.id && (r.category || "未分类") === (rec.category || "未分类"); }).slice(0, 6);
  fs.writeFileSync(path.join(pagesDir, slugId(rec.id) + ".html"), buildDetailPage(rec, rel), "utf8");
}
console.log("Wrote p/  " + enriched.length + " detail pages");

// ---- all.html: crawlable index of every prompt, grouped by category ----
const catMap = new Map();
for (const rec of enriched) {
  const c = rec.category || "未分类";
  if (!catMap.has(c)) catMap.set(c, []);
  catMap.get(c).push(rec);
}
const catList = Array.from(catMap.entries()).sort(function (a, b) { return b[1].length - a[1].length; });

const allBody = catList.map(function (entry) {
  const c = entry[0], items = entry[1];
  return '<section class="cat-list" id="c-' + catSlug(c) + '"><h3>' + escHtml(c) + ' <span class="muted" style="font-weight:400">（' + items.length + '）</span></h3><ul>'
    + items.map(function (r) {
      return '<li><a href="p/' + slugId(r.id) + '.html">' + escHtml(r.title) + '</a></li>';
    }).join("")
    + '</ul></section>';
}).join("\n");

const allHtml = '<!doctype html>\n<html lang="zh-CN">\n<head>\n'
  + '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n'
  + '<title>全部提示词（' + enriched.length + ' 条） — MotionSites Prompts</title>\n'
  + '<meta name="description" content="按分类浏览 MotionSites Prompts 收录的全部 ' + enriched.length + ' 条动效 UI 提示词，每条都有独立页面与完整正文。">\n'
  + '<meta name="robots" content="index,follow">\n'
  + '<meta name="google-adsense-account" content="' + ADSENSE_CLIENT + '">\n'
  + '<script src="/theme.js"></script>\n'
  + '<link rel="canonical" href="' + SITE_ORIGIN + '/all.html">\n'
  + '<link rel="stylesheet" href="/pages.css">\n</head>\n<body>\n'
  + docNav("/")
  + '<main class="wrap"><div class="crumbs"><a href="/">首页</a> / 全部提示词</div>'
  + '<h1>全部提示词</h1>'
  + '<p class="muted">共 ' + enriched.length + ' 条，分 ' + catList.length + ' 个分类。点击任意标题进入独立页面，可复制完整提示词。</p>'
  + '<div class="jump">' + catList.map(function (e) { return '<a href="#c-' + catSlug(e[0]) + '">' + escHtml(e[0]) + '</a>'; }).join("") + '</div>'
  + allBody
  + '<p class="home-link"><a href="/">← 返回提示词库</a></p></main>\n'
  + docFoot("/")
  + '</body>\n</html>\n';
fs.writeFileSync(path.join(ROOT, "all.html"), allHtml, "utf8");
console.log("Wrote all.html  " + enriched.length + " links");

// ---- sitemap.xml ----
const today = new Date().toISOString().slice(0, 10);
const staticUrls = [
  { loc: SITE_ORIGIN + "/", pr: "1.0" },
  { loc: SITE_ORIGIN + "/all.html", pr: "0.9" },
  { loc: SITE_ORIGIN + "/about.html", pr: "0.5" },
  { loc: SITE_ORIGIN + "/privacy.html", pr: "0.3" },
  { loc: SITE_ORIGIN + "/contact.html", pr: "0.4" },
  { loc: SITE_ORIGIN + "/terms.html", pr: "0.3" }
];
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + staticUrls.map(function (u) {
    return "  <url><loc>" + u.loc + "</loc><lastmod>" + today + "</lastmod><priority>" + u.pr + "</priority></url>";
  }).join("\n")
  + "\n" + enriched.map(function (r) {
    const d = fmtDate(r.created_at) || today;
    return "  <url><loc>" + SITE_ORIGIN + "/p/" + slugId(r.id) + ".html</loc><lastmod>" + d + "</lastmod><priority>0.7</priority></url>";
  }).join("\n")
  + "\n</urlset>\n";
fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap, "utf8");
console.log("Wrote sitemap.xml  " + (staticUrls.length + enriched.length) + " urls");


// ---- Generate index.html (no inlined DATA) ----
let html = readNoBom(path.join(ROOT, "ms_template.html"));
html = html.split("$" + "{enriched.length}").join(String(enriched.length));
html = html.replace("$" + "{complete}", String(complete)).replace("$" + "{images}", String(images)).replace("$" + "{videos}", String(videos)).replace("$" + "{noMedia}", String(noMedia)).replace("<script>__SCRIPT_BODY__</script>", "<script src=\"ms_script.js\" defer></script>");

const outPath = path.join(ROOT, "index.html");
fs.writeFileSync(outPath, html, "utf8");
console.log("Wrote " + outPath + " bytes " + html.length);
