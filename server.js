import express from "express";
import * as cheerio from "cheerio";
import { Client } from "@notionhq/client";
import "dotenv/config";

const app = express();
app.use(express.json());
app.use(express.static("public"));

if (!process.env.NOTION_TOKEN) {
  console.warn(
    "[警告] NOTION_TOKEN が設定されていません。.env ファイルを作成してください(.env.example を参考に)。"
  );
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// ---- Notion DB キャッシュ ----
let groupCache = [];
let lastFetched = 0;
let isRefreshing = false;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10分

function extractPlainText(richTextArray) {
  if (!Array.isArray(richTextArray)) return "";
  return richTextArray.map((rt) => rt.plain_text || "").join("");
}

function pageToGroup(page) {
  const props = page.properties || {};

  const name = props["グループ名"]?.title
    ? extractPlainText(props["グループ名"].title)
    : "";
  const reading = props["グループ名（読み方）"]?.rich_text
    ? extractPlainText(props["グループ名（読み方）"].rich_text)
    : "";
  const photo = props["静止画"]?.select?.name || "";
  const video = props["動画"]?.select?.name || "";
  const note = props["備考"]?.rich_text
    ? extractPlainText(props["備考"].rich_text)
    : "";
  const xLink = props["公式Xリンク"]?.url || "";
  const checkedDate = props["レギュ確認日"]?.date?.start || "";
  const source1 =
    (props["ソース1"]?.rich_text &&
      extractPlainText(props["ソース1"].rich_text)) ||
    props["ソース1"]?.url ||
    "";
  const source2 =
    (props["ソース2"]?.rich_text &&
      extractPlainText(props["ソース2"].rich_text)) ||
    props["ソース2"]?.url ||
    "";

  return {
    name: name.trim(),
    reading: reading.trim(),
    photo,
    video,
    note,
    xLink,
    checkedDate,
    source1,
    source2,
    pageUrl: page.url,
  };
}

async function fetchAllGroups() {
  const groups = [];
  let cursor = undefined;

  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of res.results) {
      const g = pageToGroup(page);
      if (g.name) groups.push(g);
    }

    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return groups;
}

async function getGroups(forceRefresh = false) {
  const now = Date.now();

  // 明示的な再取得(「DBを再取得」ボタン)は、実際に新しいデータを取り終わるまで待つ
  if (forceRefresh) {
    groupCache = await fetchAllGroups();
    lastFetched = Date.now();
    isRefreshing = false;
    return groupCache;
  }

  // 初回(サーバー起動直後でキャッシュが空)は、待つしかない
  if (groupCache.length === 0) {
    groupCache = await fetchAllGroups();
    lastFetched = Date.now();
    return groupCache;
  }

  // キャッシュ期限切れ: 古いデータを即座に返しつつ、裏側で更新する(stale-while-revalidate)
  const isStale = now - lastFetched > CACHE_TTL_MS;
  if (isStale && !isRefreshing) {
    isRefreshing = true;
    fetchAllGroups()
      .then((fresh) => {
        groupCache = fresh;
        lastFetched = Date.now();
      })
      .catch((e) => {
        console.error("バックグラウンドでのDB再取得に失敗しました:", e);
      })
      .finally(() => {
        isRefreshing = false;
      });
  }

  return groupCache;
}

// ---- グループ名リスト照合用のヘルパー ----

function normalizeStr(s) {
  return (s || "").normalize("NFKC").trim();
}

// 改行、スラッシュ(前後スペース有無どちらも)、「、」「・」で分割する
// (スペースなしのスラッシュを含む名前は splitGroupList の時点では一旦壊れるが、
//  mergeKnownSplitNames で DB の実名と突き合わせて復元する)
function splitGroupList(text) {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[\/、・]/))
    .map((s) => normalizeStr(s))
    .filter(Boolean);
}

// "LilyS/ash" のように区切り文字と同じ記号を含むDB登録名が、分割によって
// "LilyS" "ash" のように壊れてしまった場合に、DBの実名と突き合わせて復元する
function mergeKnownSplitNames(tokens, groups) {
  if (!tokens || tokens.length < 2) return tokens || [];
  const dbNameSet = new Set(groups.map((g) => normalizeStr(g.name).toLowerCase()));
  const separators = ["/", "、", "・"];
  const result = [];
  let i = 0;
  while (i < tokens.length) {
    let merged = null;
    if (i + 1 < tokens.length) {
      for (const sep of separators) {
        const combined = `${tokens[i]}${sep}${tokens[i + 1]}`;
        if (dbNameSet.has(normalizeStr(combined).toLowerCase())) {
          merged = combined;
          break;
        }
      }
    }
    if (merged) {
      result.push(merged);
      i += 2;
    } else {
      result.push(tokens[i]);
      i += 1;
    }
  }
  return result;
}

// グループ名・読み仮名の索引を1回だけ作る(正規化も1回だけ計算しておく)
function buildGroupIndex(groups) {
  const byName = new Map();
  const byNameNoSpace = new Map();
  const byReading = new Map();
  const normalized = [];

  for (const g of groups) {
    const normName = normalizeStr(g.name).toLowerCase();
    if (normName && !byName.has(normName)) byName.set(normName, g);

    const noSpaceName = normName.replace(/\s+/g, "");
    if (noSpaceName && !byNameNoSpace.has(noSpaceName)) byNameNoSpace.set(noSpaceName, g);

    if (g.reading) {
      const normReading = normalizeStr(g.reading).toLowerCase();
      if (normReading && !byReading.has(normReading)) byReading.set(normReading, g);
    }
    normalized.push({ group: g, normName });
  }

  return { byName, byNameNoSpace, byReading, normalized };
}

// "かすみ草とステラ 1期生" "かすみ草とステラ(1期生)" のような「◯期生」の指定を取り除いて、
// 無印のグループ名に寄せるためのヘルパー
function stripGenerationSuffix(normToken) {
  return normToken.replace(/\s*\(?\d+期生\)?\s*$/, "").trim();
}

// ---- 「もしかして」候補用: 編集距離ベースの類似度 ----

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// 完全一致しなかった時だけ、8割以上似ている候補を最大2件まで探す
// (短すぎる文字列は誤爆しやすいので対象外にする)
function findSuggestions(normToken, index, limit = 2, threshold = 0.8) {
  if (normToken.length < 3) return [];
  const scored = [];
  for (const entry of index.normalized) {
    if (entry.normName.length < 3) continue;
    const sim = similarity(normToken, entry.normName);
    if (sim >= threshold) scored.push({ name: entry.group.name, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const seen = new Set();
  const result = [];
  for (const s of scored) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    result.push(s.name);
    if (result.length >= limit) break;
  }
  return result;
}

function matchListAgainstGroups(tokens, groups) {
  const index = buildGroupIndex(groups); // ここで1回だけDBを走査
  const results = [];
  const notFound = [];

  tokens.forEach((token, orderIndex) => {
    const normToken = normalizeStr(token).toLowerCase();
    if (!normToken) return;

    // 1) 「◯期生」の指定があれば、それを取り除いて無印グループに一致させる(最優先)
    //    ("かすみ草とステラ(1期生)" のように、そのままDBに存在するサブグループ名でも
    //     常に無印の方を優先する)
    let match = null;
    let matchType = "exact";
    const generationStripped = stripGenerationSuffix(normToken);
    const hasGenerationSuffix = generationStripped && generationStripped !== normToken;
    if (hasGenerationSuffix) {
      match =
        index.byName.get(generationStripped) ||
        index.byNameNoSpace.get(generationStripped.replace(/\s+/g, ""));
      matchType = "exact-base";
    }

    // 2) グループ名との完全一致(索引を引くだけ)
    if (!match) {
      match = index.byName.get(normToken);
      matchType = "exact";
    }

    // 3) 読み仮名との完全一致(索引を引くだけ)
    if (!match) {
      match = index.byReading.get(normToken);
      matchType = "exact-reading";
    }

    // 4) スペースの有無を無視した完全一致(例: "Lily S/ash" ↔ "LilyS/ash")
    if (!match) {
      match = index.byNameNoSpace.get(normToken.replace(/\s+/g, ""));
      matchType = "exact-nospace";
    }

    // 5) 部分一致(表記ゆれ対応のフォールバック。正規化済みの名前を使うので再計算はしない)
    if (!match) {
      const found = index.normalized.find(
        (entry) =>
          entry.normName.length >= 2 &&
          normToken.length >= 2 &&
          (entry.normName.includes(normToken) || normToken.includes(entry.normName))
      );
      if (found) match = found.group;
      matchType = "fuzzy";
    }

    if (match) {
      results.push({ ...match, query: token, matchType, pagePos: orderIndex });
    } else {
      notFound.push({
        name: token,
        pagePos: orderIndex,
        suggestions: findSuggestions(normToken, index),
      });
    }
  });

  // 重複除去(同名グループが複数レコードある場合は最初の1件を採用)
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    if (!seen.has(r.name)) {
      seen.add(r.name);
      unique.push(r);
    }
  }

  // 五十音順ではなく、入力した順番(=タイムテーブル順であることが多い)をそのまま保持する
  return { matched: unique, notFound };
}

// ---- API ----

// オフライン時にクライアント側でキャッシュして使うための、DB全件返却API
app.get("/api/groups", async (req, res) => {
  try {
    const groups = await getGroups();
    res.json({ ok: true, groups, dbTotal: groups.length, fetchedAt: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const groups = await getGroups(true);
    res.json({ ok: true, count: groups.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- チケットサイト別: 出演者名の抽出ルール ----
// (DBに登録済みかどうかの判定に使うだけで、DB自体は書き換えない)

function splitPerformerLine(line) {
  return line
    .split(/\s+\/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractTiget(rawText) {
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "出演者" || lines[i].trim() === "出演") {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) return splitPerformerLine(lines[j].trim());
      }
    }
  }
  return [];
}

function extractTicketDive(rawText, metaDesc) {
  // 1) meta description の【出演者】…パターンを優先(一番ノイズが少ない)
  const m = (metaDesc || "").match(/【出演者】([^【]+)/);
  if (m) return splitPerformerLine(m[1].trim());

  // 2) 本文の［出演者］見出しの次行にフォールバック
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^[［\[]出演者[］\]]$/.test(lines[i].trim())) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) return splitPerformerLine(lines[j].trim());
      }
    }
  }
  return [];
}

function extractTicketVillage(rawText) {
  const markerRe = /[◾◻■□]?\s*出演(?:者)?\s*[:：]/;
  const lines = rawText.split("\n");
  const idx = lines.findIndex((l) => markerRe.test(l));
  if (idx === -1) return [];

  const collected = [];
  const firstLineRest = lines[idx].replace(markerRe, "").trim();
  if (firstLineRest) collected.push(firstLineRest);

  for (let j = idx + 1; j < lines.length; j++) {
    const line = lines[j].trim();
    if (!line) continue;
    if (/^[◾◻■□]/.test(line)) break; // 次の項目(◾時間 など)に到達したら終了
    collected.push(line);
  }

  const names = [];
  for (const line of collected) {
    // "第1弾：" "第2弾：" のような接頭辞を除去
    const cleaned = line.replace(/^第[0-9０-９]+弾\s*[:：]\s*/, "");
    names.push(...splitPerformerLine(cleaned));
  }
  return names;
}

function extractLivePocket(rawText) {
  // 概要の「出演者」ラベルの右側(または直後の行)に掲載されている想定
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "出演者") {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) return splitPerformerLine(lines[j].trim());
      }
    }
    const inline = line.match(/^出演者\s*[:：]?\s*(.+)$/);
    if (inline && inline[1]) return splitPerformerLine(inline[1]);
  }
  return [];
}

function extractLtike(rawText) {
  // 「詳細」内の「出演：」以降、複数行にわたって続き、
  // 「※」で始まる注意書きなどに到達したら終了。
  // 「□：」のような回数区切りの記号だけの行は無視する。
  const lines = rawText.split("\n");
  const markerRe = /^出演\s*[:：]/;
  const idx = lines.findIndex((l) => markerRe.test(l.trim()));
  if (idx === -1) return [];

  const collected = [];
  for (let j = idx + 1; j < lines.length && collected.length < 400; j++) {
    const line = lines[j].trim();
    if (!line) continue;
    if (/^[※【]/.test(line)) break;
    if (/^-{3,}/.test(line)) break;
    const strippedForCheck = line.replace(/[:：]/g, "").trim();
    if (!/[a-zA-Z0-9ぁ-んァ-ヶー一-龠]/.test(strippedForCheck)) continue;
    collected.push(line);
  }

  const names = [];
  for (const line of collected) {
    names.push(...splitPerformerLine(line));
  }
  return names;
}

function extractCandidatesFromSite(hostname, rawText, metaDesc) {
  if (!hostname) return [];
  if (hostname === "livepocket.jp") return extractLivePocket(rawText);
  if (hostname === "ticketvillage.jp") return extractTicketVillage(rawText);
  if (hostname === "ticketdive.com") return extractTicketDive(rawText, metaDesc);
  if (hostname === "tiget.net") return extractTiget(rawText);
  if (hostname === "l-tike.com") return extractLtike(rawText);
  return [];
}

app.post("/api/lookup", async (req, res) => {
  const { url } = req.body || {};

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "有効なURLを入力してください" });
  }

  try {
    const pageResp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      redirect: "follow",
    });

    if (!pageResp.ok) {
      return res
        .status(400)
        .json({ ok: false, error: `ページ取得に失敗しました (HTTP ${pageResp.status})` });
    }

    const html = await pageResp.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, template").remove();
    const pageText = $("body").text().replace(/\s+/g, " ");
    // 全角/半角(英数字・記号・スペース)を区別せず照合できるよう正規化
    const normPageText = normalizeStr(pageText);
    const rawText = $("body")
      .text()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
    const metaDesc =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";
    const pageTitle = $("title").first().text().trim();
    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    let ogImage = $('meta[property="og:image"]').attr("content") || "";
    if (ogImage) {
      try {
        ogImage = new URL(ogImage, url).href; // 相対URLを絶対URLに解決
      } catch (e) {
        ogImage = "";
      }
    }

    // 日付らしき文字列をページ内から簡易的に検索(保証はできない)
    let eventDate = "";
    const dateMatch = rawText.match(
      /\d{4}[\/年]\s?\d{1,2}[\/月]\s?\d{1,2}日?(?:\([月火水木金土日]\))?/
    );
    if (dateMatch) eventDate = dateMatch[0];

    // 「会場：」「開催場所：」等のラベル近くから会場名を簡易的に取得(保証はできない)
    let venue = "";
    const venueLines = rawText.split("\n");
    for (let i = 0; i < venueLines.length; i++) {
      const m = venueLines[i].match(/^[◾◻■□]?\s*(?:会場|開催場所)\s*[:：]\s*(.*)$/);
      if (m) {
        venue = (m[1] || "").trim();
        if (!venue) {
          for (let j = i + 1; j < venueLines.length; j++) {
            if (venueLines[j].trim()) {
              venue = venueLines[j].trim();
              break;
            }
          }
        }
        break;
      }
    }

    const eventInfo = {
      title: ogTitle || pageTitle,
      image: ogImage,
      date: eventDate,
      venue,
    };

    let hostname = "";
    try {
      hostname = new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      // ignore
    }

    const groups = await getGroups();

    // グループ名がページ本文にそのまま含まれるかで判定(サイト構造に依存しない汎用方式)
    // ページ内で最初に登場する位置を記録し、その順番で並べる(タイムテーブル順に近づくことが多いため)
    const matched = [];
    for (const g of groups) {
      if (g.name && g.name.length >= 2) {
        const pos = normPageText.indexOf(normalizeStr(g.name));
        if (pos !== -1) {
          matched.push({ ...g, _pos: pos });
        }
      }
    }

    matched.sort((a, b) => a._pos - b._pos);

    // 重複除去(同名グループが複数レコードある場合は、ページ内で先に出現した1件を採用)
    const seen = new Set();
    const unique = [];
    for (const m of matched) {
      if (!seen.has(m.name)) {
        seen.add(m.name);
        const { _pos, ...rest } = m;
        unique.push({ ...rest, pagePos: _pos });
      }
    }

    // サイト別ルールでページ上の出演者名を抽出し、DB未登録のものだけ拾う(DBは変更しない)
    const rawCandidates = extractCandidatesFromSite(hostname, rawText, metaDesc);
    const candidates = mergeKnownSplitNames(rawCandidates, groups);
    const dbNameSet = new Set(groups.map((g) => normalizeStr(g.name).toLowerCase()));
    const unknownOnPage = [];
    const seenCandidate = new Set();
    for (const c of candidates) {
      const norm = normalizeStr(c).toLowerCase();
      if (!norm || seenCandidate.has(norm)) continue;
      seenCandidate.add(norm);
      if (!dbNameSet.has(norm)) {
        const pos = normPageText.indexOf(normalizeStr(c));
        unknownOnPage.push({ name: c, pagePos: pos === -1 ? Number.MAX_SAFE_INTEGER : pos });
      }
    }
    unknownOnPage.sort((a, b) => a.pagePos - b.pagePos);

    res.json({
      ok: true,
      url,
      pageTitle,
      eventInfo,
      matchedCount: unique.length,
      groups: unique,
      dbTotal: groups.length,
      unknownOnPage,
      siteRuleApplied: candidates.length > 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/lookup-list", async (req, res) => {
  const { text } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ ok: false, error: "グループ名を入力してください" });
  }

  try {
    const tokens = splitGroupList(text);

    if (tokens.length === 0) {
      return res.status(400).json({ ok: false, error: "グループ名を認識できませんでした" });
    }

    const groups = await getGroups();
    const mergedTokens = mergeKnownSplitNames(tokens, groups);
    const { matched, notFound } = matchListAgainstGroups(mergedTokens, groups);

    res.json({
      ok: true,
      tokenCount: mergedTokens.length,
      matchedCount: matched.length,
      groups: matched,
      notFound,
      dbTotal: groups.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`起動しました: http://localhost:${PORT}`);
});
