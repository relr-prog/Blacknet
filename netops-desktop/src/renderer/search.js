"use strict";

// The results page. It has no bridge: the main process pushes the merged list in
// as data by calling window.__blacknetSearch.render(payload), and everything
// else this page does, it does by itself.
//
// Every value that comes from a source is written with textContent, never with
// innerHTML. A search result is untrusted text - a title or snippet controlled
// by whatever page the source indexed - and building nodes rather than HTML is
// what stops it from becoming markup on this page.

const SOURCE_LABELS = {
  wikipedia: "Wikipedia",
  hackernews: "Hacker News",
  stackoverflow: "Stack Overflow",
  github: "GitHub",
};

const params = new URLSearchParams(window.location.search);
const input = document.getElementById("q");
const form = document.getElementById("form");
const list = document.getElementById("results");
const meta = document.getElementById("meta");
const empty = document.getElementById("empty");
const sources = document.getElementById("sources");

let current = params.get("q") || "";
let lastToken = 0;
input.value = current;
if (current) document.title = `${current} - BlackNet Search`;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const next = input.value.trim();
  if (!next || next === current) return;
  // The shell reads the query back off the address on a same-document
  // navigation. Writing the hash is the whole submission: no bridge needed.
  window.location.hash = `q=${encodeURIComponent(next)}`;
});

function labelOf(id) {
  return SOURCE_LABELS[id] || id;
}

function buildResult(result) {
  const item = document.createElement("li");
  item.className = "result";

  const link = document.createElement("a");
  link.href = result.url;
  link.textContent = result.title;
  item.append(link);

  const where = document.createElement("span");
  where.className = "where";
  where.textContent = labelOf(result.source);
  link.after(where);

  const url = document.createElement("span");
  url.className = "url";
  url.textContent = result.url;
  item.append(url);

  if (result.snippet) {
    const snippet = document.createElement("p");
    snippet.className = "snippet";
    snippet.textContent = result.snippet;
    item.append(snippet);
  }
  return item;
}

function render(payload) {
  if (!payload) return;
  // Answers can arrive out of order when the operator edits the query quickly.
  // The shell stamps each one, so an older answer never overwrites a newer one.
  const token = Number(payload.token);
  if (Number.isFinite(token) && token < lastToken) return;
  if (Number.isFinite(token)) lastToken = token;

  current = payload.query || "";
  input.value = current;
  document.title = current ? `${current} - BlackNet Search` : "BlackNet Search";

  const results = Array.isArray(payload.results) ? payload.results : [];
  list.textContent = "";
  for (const result of results) list.append(buildResult(result));

  meta.textContent = results.length
    ? `${results.length} result${results.length === 1 ? "" : "s"} for \u201c${current}\u201d`
    : (payload.answered && payload.answered.length
      ? `No results for \u201c${current}\u201d`
      : `Nothing answered for \u201c${current}\u201d`);

  empty.hidden = results.length > 0;
  empty.textContent = payload.answered && payload.answered.length
    ? "No source matched this query. Try different wording."
    : "No source could be reached. The shell searches public APIs, so check the connection.";

  const answered = (payload.answered || []).map(labelOf);
  const failed = (payload.failed || []).map((row) => labelOf(row.source));
  const parts = [];
  if (answered.length) parts.push(`answered by ${answered.join(", ")}`);
  if (failed.length) parts.push(`no answer from ${failed.join(", ")}`);
  sources.textContent = parts.join(" \u00b7 ");
}

window.__blacknetSearch = { render };
