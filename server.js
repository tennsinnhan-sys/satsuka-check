import * as cheerio from "cheerio";

// ExpressとPI依存(body-parser -> iconv-lite)がCloudflare Workersのバンドルと
// 衝突する既知の問題があるため、Expressは使わずFetch APIベースの最小限の
// ルーター/req-resシムを自前で用意する。ハンドラの書き方(req.body / res.json など)は
// Express時代とほぼ同じにして、既存ロジックへの変更を最小限にしている。
const routes = [];
function get(path, handler) {
  routes.push({ method: "GET", path, handler });
}
function post(path, handler) {
  routes.push({ method: "POST", path, handler });
}
function createRes() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  let statusCode = 200;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(obj) {
      resolve(
        new Response(JSON.stringify(obj), {
          status: statusCode,
          headers: { "content-type": "application/json; charset=utf-8" },
        })
      );
    },
  };
  return { res, promise };
}

if (!process.env.NOTION_TOKEN) {
  console.warn(
    "[警告] NOTION_TOKEN が設定されていません。`wrangler secret put NOTION_TOKEN` で設定してください(ローカル開発時は .dev.vars ファイルでも可)。"
  );
}

const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = "2022-06-28";

// ---- 検索履歴(Cloudflare KVにサーバー側保存。全端末で共通の履歴になる) ----
const HISTORY_MAX = 30;
const HISTORY_KV_KEYS = { url: "history:url", list: "history:list" };

async function loadHistoryKV(env, kind) {
  if (!env.HISTORY_KV) return [];
  const arr = await env.HISTORY_KV.get(HISTORY_KV_KEYS[kind], "json");
  return Array.isArray(arr) ? arr : [];
}

async function saveHistoryKV(env, kind, list) {
  if (!env.HISTORY_KV) return;
  await env.HISTORY_KV.put(HISTORY_KV_KEYS[kind], JSON.stringify(list.slice(0, HISTORY_MAX)));
}

// @notionhq/client SDKがCloudflare Workers上で原因不明のエラー
// ("Cannot read properties of undefined (reading 'call')")を起こすため、
// SDKを使わずNotionのREST APIを直接fetchで呼び出す(利用箇所はデータベース照会1箇所のみ)。
async function notionDatabaseQuery(cursor) {
  const resp = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Notion API エラー (HTTP ${resp.status}): ${errText}`);
  }
  return resp.json();
}

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
    const res = await notionDatabaseQuery(cursor);

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
get("/api/groups", async (req, res) => {
  try {
    const groups = await getGroups();
    res.json({ ok: true, groups, dbTotal: groups.length, fetchedAt: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

post("/api/refresh", async (req, res) => {
  try {
    const groups = await getGroups(true);
    res.json({ ok: true, count: groups.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- 検索履歴API(サーバー側=Cloudflare KVに保存。全端末で共通) ----
get("/api/history", async (req, res, env) => {
  try {
    const [url, list] = await Promise.all([
      loadHistoryKV(env, "url"),
      loadHistoryKV(env, "list"),
    ]);
    res.json({ ok: true, url, list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

post("/api/history/add", async (req, res, env) => {
  try {
    const { kind, entry } = req.body || {};
    if (kind !== "url" && kind !== "list") {
      return res.status(400).json({ ok: false, error: "kindが不正です" });
    }
    if (!entry || typeof entry !== "object") {
      return res.status(400).json({ ok: false, error: "entryが不正です" });
    }
    const list = await loadHistoryKV(env, kind);
    const dedupeKey = kind === "url" ? entry.url : entry.text;
    const existing = list.find((it) => (kind === "url" ? it.url : it.text) === dedupeKey);
    const filtered = list.filter((it) => (kind === "url" ? it.url : it.text) !== dedupeKey);
    const mergedEntry = { ...entry };
    // 並び順(order)が明示的に送られなかった場合は、既存の保存済み並び順を引き継ぐ
    // (タイムテーブル順の入れ替えが、通常の再検索のたびに消えてしまわないようにするため)
    if (mergedEntry.order === undefined && existing && existing.order) {
      mergedEntry.order = existing.order;
    }
    filtered.unshift({ ...mergedEntry, ts: Date.now() });
    const capped = filtered.slice(0, HISTORY_MAX);
    await saveHistoryKV(env, kind, capped);
    res.json({ ok: true, list: capped });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

post("/api/history/remove", async (req, res, env) => {
  try {
    const { kind, ts } = req.body || {};
    if (kind !== "url" && kind !== "list") {
      return res.status(400).json({ ok: false, error: "kindが不正です" });
    }
    const list = (await loadHistoryKV(env, kind)).filter((it) => it.ts !== ts);
    await saveHistoryKV(env, kind, list);
    res.json({ ok: true, list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

post("/api/history/clear", async (req, res, env) => {
  try {
    const { kind } = req.body || {};
    if (kind !== "url" && kind !== "list") {
      return res.status(400).json({ ok: false, error: "kindが不正です" });
    }
    await saveHistoryKV(env, kind, []);
    res.json({ ok: true, list: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- チケットサイト別: 出演者名の抽出ルール ----
// (DBに登録済みかどうかの判定に使うだけで、DB自体は書き換えない)

function splitPerformerLine(line) {
  // スペースあり(" / ")・なし("/")どちらのスラッシュ区切りにも対応。
  // "22/7" のようにスラッシュを含む名前は、この時点では一旦壊れるが、
  // mergeKnownSplitNames で DB の実名と突き合わせて復元する。
  return line
    .split(/\s*\/\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractTiget(rawText) {
  const lines = rawText.split("\n").map((l) => l.trim());

  const isHeaderLine = (l) =>
    l === "出演者" || l === "出演" || /^[【\[]出演(者)?[】\]]/.test(l);

  const headerIdx = lines.findIndex(isHeaderLine);
  if (headerIdx === -1) return [];

  const names = [];
  // 最初に確定した形式("numbered"=「1.グループ名」/ "slash"=スラッシュ区切り)を
  // 以後も使い続ける。無関係な行(主催者表記など)を誤って取り込まないため。
  let mode = null;

  for (let j = headerIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (!line) {
      if (mode) break; // リスト開始後の空行で打ち切り
      continue;
    }

    const numberedMatch = line.match(/^\d+\.\s*(.+)$/);
    const additionalMatch = line.match(/^追加(出演)?[:：]\s*(.+)$/);

    if (mode === null) {
      if (numberedMatch) {
        mode = "numbered";
        names.push(numberedMatch[1].trim());
        continue;
      }
      if (additionalMatch) {
        mode = "slash";
        names.push(...splitPerformerLine(additionalMatch[2].trim()));
        continue;
      }
      if (line.includes("/")) {
        mode = "slash";
        names.push(...splitPerformerLine(line));
        continue;
      }
      // 見出し直後がどのパターンにも合わなければ抽出失敗として終了
      break;
    }

    if (mode === "numbered") {
      if (numberedMatch) {
        names.push(numberedMatch[1].trim());
        continue;
      }
      break; // 番号なし行が来たらリストの終わり
    }

    // mode === "slash"
    if (additionalMatch) {
      names.push(...splitPerformerLine(additionalMatch[2].trim()));
      continue;
    }
    if (/^[■●]/.test(line)) break;
    if (line.includes("/")) {
      names.push(...splitPerformerLine(line));
      continue;
    }
    break; // スラッシュを含まない行が来たらリストの終わり
  }

  return names;
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

post("/api/lookup", async (req, res) => {
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
    // スペースの有無だけが違う表記ゆれ(例: "SAI ²Rium" ↔ "SAI²Rium")を許容するための空白除去版
    const normPageTextNoSpace = normPageText.replace(/\s+/g, "");
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
    const groupIndex = buildGroupIndex(groups);

    // グループ名がページ本文にそのまま含まれるかで判定(サイト構造に依存しない汎用方式)
    // ページ内で最初に登場する位置を記録し、その順番で並べる(タイムテーブル順に近づくことが多いため)
    const matched = [];
    for (const g of groups) {
      if (g.name && g.name.length >= 1) {
        const normName = normalizeStr(g.name);
        let pos = normPageText.indexOf(normName);
        if (pos === -1) {
          // スペースの有無だけが違う表記ゆれを許容(例: "SAI ²Rium" ↔ "SAI²Rium")
          const noSpaceName = normName.replace(/\s+/g, "");
          if (noSpaceName.length >= 2) {
            pos = normPageTextNoSpace.indexOf(noSpaceName); // 並び順用の概算位置
          }
        }
        if (pos !== -1) {
          matched.push({ ...g, _pos: pos });
        }
      }
    }

    matched.sort((a, b) => a._pos - b._pos);

    // 重複除去(同名グループが複数レコードある場合は、ページ内で先に出現した1件を採用)
    // name をキーにした Map にしておき、「◯期生」付き候補で見つかった場合に
    // 無印グループの重複表示を後から差し替えられるようにする
    const uniqueMap = new Map();
    for (const m of matched) {
      if (!uniqueMap.has(m.name)) {
        const { _pos, ...rest } = m;
        uniqueMap.set(m.name, { ...rest, pagePos: _pos });
      }
    }

    // サイト別ルールでページ上の出演者名を抽出し、DB未登録のものだけ拾う(DBは変更しない)
    const rawCandidates = extractCandidatesFromSite(hostname, rawText, metaDesc);
    const candidates = mergeKnownSplitNames(rawCandidates, groups);
    const dbNameSet = new Set(groups.map((g) => normalizeStr(g.name).toLowerCase()));
    const dbNameSetNoSpace = new Set(
      groups.map((g) => normalizeStr(g.name).toLowerCase().replace(/\s+/g, ""))
    );
    const unknownOnPage = [];
    const seenCandidate = new Set();
    for (const c of candidates) {
      const norm = normalizeStr(c).toLowerCase();
      if (!norm || seenCandidate.has(norm)) continue;
      seenCandidate.add(norm);
      if (dbNameSet.has(norm) || dbNameSetNoSpace.has(norm.replace(/\s+/g, ""))) continue; // すでに matched 側に入っている

      const pos = normPageText.indexOf(normalizeStr(c));
      const pagePos = pos === -1 ? Number.MAX_SAFE_INTEGER : pos;

      // 「かすみ草とステラ 4期生」のように「◯期生」付きで、無印の方がDBにある場合は、
      // 無印グループ単体の表示は消し、このサフィックス付き表示名で1件にまとめる
      const stripped = stripGenerationSuffix(norm);
      const hasGenerationSuffix = stripped && stripped !== norm;
      const baseGroup = hasGenerationSuffix
        ? groupIndex.byName.get(stripped) ||
          groupIndex.byNameNoSpace.get(stripped.replace(/\s+/g, ""))
        : null;

      if (baseGroup) {
        uniqueMap.delete(baseGroup.name);
        uniqueMap.set(c, { ...baseGroup, name: c, pagePos });
      } else {
        unknownOnPage.push({ name: c, pagePos, suggestions: findSuggestions(norm, groupIndex) });
      }
    }
    unknownOnPage.sort((a, b) => a.pagePos - b.pagePos);

    const unique = Array.from(uniqueMap.values()).sort((a, b) => a.pagePos - b.pagePos);

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

post("/api/lookup-list", async (req, res) => {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = routes.find((r) => r.method === request.method && r.path === url.pathname);

    if (!route) {
      // "/api/*" 以外はwrangler.jsoncのrun_worker_first設定により
      // 本来ここに来ないが、念のためAssetsへフォールバックする
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not Found", { status: 404 });
    }

    let body = {};
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch (e) {
        body = {};
      }
    }
    const req = { body, headers: Object.fromEntries(request.headers), method: request.method };
    const { res, promise } = createRes();
    route.handler(req, res, env);
    return promise;
  },
};
