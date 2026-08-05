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
  if (forceRefresh || groupCache.length === 0 || now - lastFetched > CACHE_TTL_MS) {
    groupCache = await fetchAllGroups();
    lastFetched = now;
  }
  return groupCache;
}

// ---- グループ名リスト照合用のヘルパー ----

function normalizeStr(s) {
  return (s || "").normalize("NFKC").trim();
}

// 改行、または前後にスペースを伴う " / " で分割する
// (例: "LilyS/ash" のようにスペースなしのスラッシュを含む名前は壊さない)
function splitGroupList(text) {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/\s+\/\s+/))
    .map((s) => normalizeStr(s))
    .filter(Boolean);
}

// "LilyS/ash" のようにスラッシュを含むDB登録名が、サイト側の表記ゆれで
// "LilyS" "ash" のように分割されてしまった場合に、DBの実名と突き合わせて復元する
function mergeKnownSlashNames(tokens, groups) {
  if (!tokens || tokens.length < 2) return tokens || [];
  const dbNameSet = new Set(groups.map((g) => normalizeStr(g.name).toLowerCase()));
  const result = [];
  let i = 0;
  while (i < tokens.length) {
    if (i + 1 < tokens.length) {
      const combined = `${tokens[i]}/${tokens[i + 1]}`;
      if (dbNameSet.has(normalizeStr(combined).toLowerCase())) {
        result.push(combined);
        i += 2;
        continue;
      }
    }
    result.push(tokens[i]);
    i += 1;
  }
  return result;
}

function matchListAgainstGroups(tokens, groups) {
  const results = [];
  const notFound = [];

  for (const token of tokens) {
    const normToken = normalizeStr(token).toLowerCase();
    if (!normToken) continue;

    // 1) グループ名との完全一致
    let match = groups.find(
      (g) => normalizeStr(g.name).toLowerCase() === normToken
    );
    let matchType = "exact";

    // 2) 読み仮名との完全一致
    if (!match) {
      match = groups.find(
        (g) => g.reading && normalizeStr(g.reading).toLowerCase() === normToken
      );
      matchType = "exact-reading";
    }

    // 3) 部分一致(表記ゆれ対応のフォールバック)
    if (!match) {
      match = groups.find((g) => {
        const gn = normalizeStr(g.name).toLowerCase();
        return (
          gn.length >= 2 &&
          normToken.length >= 2 &&
          (gn.includes(normToken) || normToken.includes(gn))
        );
      });
      matchType = "fuzzy";
    }

    if (match) {
      results.push({ ...match, query: token, matchType });
    } else {
      notFound.push(token);
    }
  }

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
    const candidates = mergeKnownSlashNames(rawCandidates, groups);
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
    const mergedTokens = mergeKnownSlashNames(tokens, groups);
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
