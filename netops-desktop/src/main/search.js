"use strict";

// BlackNet's own search: a small meta-search that runs in the main process.
//
// There is no third-party engine behind the address bar and no API key. A query
// fans out to a fixed set of public, keyless, documented JSON APIs; each answer
// is parsed into the same result shape; the merged list is de-duplicated and
// ranked here; and only the final list ever reaches the page. The page itself
// gets no bridge - it is handed the results as data.
//
// Coverage is honest: this searches the sources listed below, not "the whole
// web". Indexing the whole web would mean scraping a commercial engine, which is
// exactly the dependency this module exists to remove. Adding a source is adding
// one entry to SOURCES.
//
// Everything here is pure and synchronous except search(): parsing and ranking
// take text and return data, and fetching is injected, so the whole thing is
// exercised by node:test without a network or an Electron shell.

// One request per source. request() builds the URL (and any required headers);
// parse() turns the raw body into rows of { title, url, snippet }. A source that
// throws anywhere is that source failing - never the whole search.
const SOURCES = {
  wikipedia: {
    id: "wikipedia",
    label: "Wikipedia",
    weight: 3,
    request(query, limit) {
      return {
        url: `https://en.wikipedia.org/w/api.php?${query_string({
          action: "query",
          list: "search",
          srsearch: query,
          srlimit: String(limit),
          format: "json",
          origin: "*",
        })}`,
      };
    },
    parse(body) {
      const data = parseJson(body);
      const rows = data && data.query && data.query.search;
      if (!Array.isArray(rows)) return [];
      return rows.map((row) => ({
        title: row && row.title,
        url: row && row.pageid != null
          ? `https://en.wikipedia.org/?curid=${encodeURIComponent(row.pageid)}`
          : "",
        snippet: strip_tags(row && row.snippet),
      }));
    },
  },

  hackernews: {
    id: "hackernews",
    label: "Hacker News",
    weight: 2,
    request(query, limit) {
      return {
        url: `https://hn.algolia.com/api/v1/search?${query_string({
          query,
          tags: "story",
          hitsPerPage: String(limit),
        })}`,
      };
    },
    parse(body) {
      const data = parseJson(body);
      const hits = data && data.hits;
      if (!Array.isArray(hits)) return [];
      return hits.map((hit) => {
        const text = hit && (hit.story_text || hit.comment_text);
        const points = hit && hit.points != null
          ? `${hit.points} points, ${hit.num_comments ?? 0} comments on Hacker News`
          : "";
        return {
          title: hit && (hit.title || hit.story_title),
          url: (hit && safe_url(hit.url)) || (hit && hit.objectID
            ? `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`
            : ""),
          snippet: text ? strip_tags(text) : points,
        };
      });
    },
  },

  stackoverflow: {
    id: "stackoverflow",
    label: "Stack Overflow",
    weight: 2,
    request(query, limit) {
      return {
        url: `https://api.stackexchange.com/2.3/search/advanced?${query_string({
          order: "desc",
          sort: "relevance",
          q: query,
          site: "stackoverflow",
          pagesize: String(limit),
          filter: "default",
        })}`,
      };
    },
    parse(body) {
      const data = parseJson(body);
      const items = data && data.items;
      if (!Array.isArray(items)) return [];
      return items.map((item) => ({
        title: item && item.title,
        url: item && item.link,
        snippet: strip_tags((item && (item.excerpt || item.body)) || ""),
      }));
    },
  },

  github: {
    id: "github",
    label: "GitHub",
    weight: 2,
    request(query, limit) {
      return {
        url: `https://api.github.com/search/repositories?${query_string({
          q: query,
          per_page: String(limit),
        })}`,
        headers: { Accept: "application/vnd.github+json" },
      };
    },
    parse(body) {
      const data = parseJson(body);
      const items = data && data.items;
      if (!Array.isArray(items)) return [];
      return items.map((item) => ({
        title: item && (item.full_name || item.name),
        url: item && item.html_url,
        snippet: item && item.description,
      }));
    },
  },
};

const SOURCE_IDS = Object.keys(SOURCES);

// Result text is capped so a hostile or broken upstream cannot hand the page a
// megabyte of "title" to lay out.
const MAX_TITLE = 300;
const MAX_SNIPPET = 400;

function query_string(values) {
  return new URLSearchParams(values).toString();
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// Only http(s) results are kept. A compromised or careless upstream returning
// "javascript:..." as a result URL must never become a link the operator can
// click, and a file: or data: result is not a search result at all.
function safe_url(value) {
  if (typeof value !== "string") return "";
  const url = value.trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&rsquo;": "\u2019",
  "&lsquo;": "\u2018",
  "&ldquo;": "\u201c",
  "&rdquo;": "\u201d",
};

// Snippets arrive as markup (Wikipedia, Stack Exchange). The page renders text
// with textContent, so tags must be stripped here rather than escaped later.
function strip_tags(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

function clamp_text(value, max) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function tokenize(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// The identity two results share when they point at the same page. The query and
// fragment are dropped so an article linked as ?utm=... and bare collapse to one
// entry; the path is kept, because that is what makes two pages different.
function result_key(url) {
  return url
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function score_of(result, tokens) {
  const title = result.title.toLowerCase();
  const snippet = result.snippet.toLowerCase();
  let score = result.weight;
  for (const token of tokens) {
    if (title.includes(token)) score += 3;
    else if (snippet.includes(token)) score += 1;
  }
  return score;
}

// De-duplicate across sources, rank, and cap. Rows carry a stable insertion
// order, so equal scores keep the source-table order rather than shuffling run
// to run - a results list that reorders itself between two identical searches is
// a bug, not a feature.
function merge(raw, query, limit) {
  const tokens = tokenize(query);
  const seen = new Set();
  const ranked = [];

  raw.forEach((row, order) => {
    const key = result_key(row.url);
    if (seen.has(key)) return;
    seen.add(key);
    ranked.push({ row, order, score: score_of(row, tokens) });
  });

  ranked.sort((a, b) => (b.score - a.score) || (a.order - b.order));

  return ranked.slice(0, limit).map(({ row }) => ({
    title: row.title,
    url: row.url,
    snippet: row.snippet,
    source: row.source,
  }));
}

// Runs one source, bounded by timeoutMs, and converts its raw rows into the
// common shape. Never throws: a failure is returned as { id, error }.
async function run_source(source, query, { fetchImpl, perSource, timeoutMs }) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const request = source.request(query, perSource);
    const init = { method: "GET" };
    if (request.headers) init.headers = request.headers;
    if (controller) init.signal = controller.signal;

    const response = await fetchImpl(request.url, init);
    const status = response && response.status;
    if (status && (status < 200 || status >= 300)) throw new Error(`HTTP ${status}`);

    const body = await response.text();
    const rows = source.parse(body) || [];
    const results = [];
    for (const row of rows) {
      const url = safe_url(row && row.url);
      const title = clamp_text(row && row.title, MAX_TITLE);
      if (!url || !title) continue;
      results.push({
        title,
        url,
        snippet: clamp_text(row && row.snippet, MAX_SNIPPET),
        source: source.id,
        weight: source.weight,
      });
    }
    return { id: source.id, results };
  } catch (error) {
    return { id: source.id, error: (error && error.message) || String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The one entry point. fetchImpl is Electron's session fetch in the shell (so
// the tab's proxy applies) and a stub in the tests. Returns a plain object:
//   { query, results, answered, failed, tookMs }
// It resolves even when every source fails - the page shows the failure list.
async function search(query, options = {}) {
  const {
    fetchImpl,
    order,
    limit = 10,
    perSource = 8,
    timeoutMs = 6000,
  } = options;

  const q = typeof query === "string" ? query.trim() : "";
  const summary = { query: q, results: [], answered: [], failed: [], tookMs: 0 };
  if (!q || typeof fetchImpl !== "function") return summary;

  const ids = (order || SOURCE_IDS).filter((id) => Object.hasOwn(SOURCES, id));
  const started = Date.now();

  const settled = await Promise.all(
    ids.map((id) => run_source(SOURCES[id], q, { fetchImpl, perSource, timeoutMs })),
  );

  const raw = [];
  for (const item of settled) {
    if (item.error) summary.failed.push({ source: item.id, error: item.error });
    else {
      summary.answered.push(item.id);
      raw.push(...item.results);
    }
  }

  summary.results = merge(raw, q, limit);
  summary.tookMs = Date.now() - started;
  return summary;
}

module.exports = {
  SOURCES,
  SOURCE_IDS,
  search,
  merge,
  safe_url,
  strip_tags,
  clamp_text,
  tokenize,
  result_key,
};
