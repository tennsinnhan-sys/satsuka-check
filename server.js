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

app.post("/api/refresh", async (req, res) => {
  try {
    const groups = await getGroups(true);
    res.json({ ok: true, count: groups.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

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
    const pageTitle = $("title").first().text().trim();

    const groups = await getGroups();

    // グループ名がページ本文にそのまま含まれるかで判定(サイト構造に依存しない汎用方式)
    // ページ内で最初に登場する位置を記録し、その順番で並べる(タイムテーブル順に近づくことが多いため)
    const matched = [];
    for (const g of groups) {
      if (g.name && g.name.length >= 2) {
        const pos = pageText.indexOf(g.name);
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
        unique.push(rest);
      }
    }

    res.json({
      ok: true,
      url,
      pageTitle,
      matchedCount: unique.length,
      groups: unique,
      dbTotal: groups.length,
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
    const { matched, notFound } = matchListAgainstGroups(tokens, groups);

    res.json({
      ok: true,
      tokenCount: tokens.length,
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
