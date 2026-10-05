"use strict";

// What a site actually asked for, and what it cost.
//
// This is the honest version of a tracker counter. A badge that says "37 blocked"
// invites the question "blocked what, and did anything get through?", and the
// truthful answer needs more than a number: it needs to separate third-party
// requests from the site's own, name the rules that fired, and say how much data
// was involved. All of that is cheap to count here and impossible to recover
// later.
//
// Two rules shape the design:
//
//   * Nothing is persisted. A tracker ledger that survives a restart is a list of
//     the sites a person visits, written to disk - exactly the kind of history a
//     privacy browser should not keep. It lives in memory and dies with the app.
//   * Hosts are counted, never full URLs. A URL carries paths and query strings,
//     which is where identifiers live. example.com/tracking?id=12345 would turn
//     this into a behavioural profile; example.com does not.

// Registrable-ish suffixes, so www.example.co.uk and example.co.uk are one site
// rather than two. Deliberately short: a long list is a common source of
// misattribution, and a slightly-too-broad grouping here only affects a counter.
const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp", "com.au",
  "net.au", "org.au", "co.nz", "com.br", "com.cn", "com.mx", "co.in", "co.za",
]);

const MAX_HOSTS_PER_TAB = 500;
const MAX_HOSTS_TOTAL = 2000;

// Takes a host or a full URL. Being handed a URL is easy to do by accident and
// the failure is silent rather than loud: "https://example.com/news" splits on
// the dots into "https://example" + "com/news", which matches nothing, so every
// one of the site's own requests is scored as third-party.
function registrable(host) {
  const name = String(host || "")
    .includes("://")
    ? hostOf(host)
    : String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  const cleaned = name.replace(/\.$/, "");
  if (!cleaned || cleaned === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(cleaned)) return cleaned;
  const labels = cleaned.split(".");
  if (labels.length <= 2) return cleaned;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_SUFFIX.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".");
  return lastTwo;
}

// The score is a judgement, so it is stated as one: a weighted penalty per
// finding, floored at 0. The weights are the arguable part and are kept in one
// object so they can be argued with in one place.
const WEIGHTS = {
  tracker: 12, // a known tracking endpoint
  thirdParty: 4, // a third party we did not recognise
  insecure: 15, // served over plain http
  fingerprint: 18, // a known fingerprinting surface
  mixedContent: 10, // https page pulling http sub-resources
};

function emptyHost() {
  return {
    requests: 0,
    blocked: 0,
    thirdParty: 0,
    thirdPartyBlocked: 0,
    bytes: 0,
    insecure: 0,
    rules: {},
  };
}

function emptyTab() {
  return {
    requests: 0,
    blocked: 0,
    bytes: 0,
    // The host of the top-level document. Recorded from the main-frame request
    // rather than inferred from whichever host happened to be seen first: the
    // first subresource is usually a tracker, and grading a site on the score of
    // its own trackers is exactly backwards.
    site: "",
    sites: {},
    order: [],
  };
}

class Ledger {
  #tabs = new Map();
  #totals = { requests: 0, blocked: 0, bytes: 0, sites: 0 };

  constructor({ maxHostsPerTab = MAX_HOSTS_PER_TAB, maxHostsTotal = MAX_HOSTS_TOTAL } = {}) {
    this.maxHostsPerTab = maxHostsPerTab;
    this.maxHostsTotal = maxHostsTotal;
  }

  reset(tabId) {
    if (tabId === undefined) this.#tabs.clear();
    else this.#tabs.delete(tabId);
  }

  // One call per request, for both allowed and blocked. `site` is the tab's own
  // top-level origin, which is what makes a request third-party or not.
  record(tabId, { url, site = "", blocked = false, rule = null, bytes = 0, insecure = false, mainFrame = false } = {}) {
    const tab = this.#tab(tabId);
    const host = registrable(hostOf(url));
    if (!host) {
      // A document with no host of its own (a data: URL, say) still owns the page,
      // so its "site" is whatever host ends up doing the requesting.
      if (mainFrame) tab.site = "";
      return null;
    }

    if (mainFrame) tab.site = host;
    tab.requests += 1;
    this.#totals.requests += 1;
    if (bytes > 0) {
      tab.bytes += bytes;
      this.#totals.bytes += bytes;
    }

    const entry = this.#host(tab, host, insecure);
    entry.requests += 1;

    const siteHost = registrable(hostOf(site));
    const thirdParty = Boolean(siteHost) && siteHost !== host;
    if (thirdParty) {
      entry.thirdParty += 1;
      if (blocked) entry.thirdPartyBlocked += 1;
    }
    if (insecure) entry.insecure += 1;

    if (blocked) {
      tab.blocked += 1;
      this.#totals.blocked += 1;
      entry.blocked += 1;
      // The rule name is what makes a count actionable. Anything unrecognised is
      // bucketed rather than dropped, so the breakdown always adds up.
      const key = rule || "unclassified";
      entry.rules[key] = (entry.rules[key] || 0) + 1;
    }
    return entry;
  }

  #tab(id) {
    let tab = this.#tabs.get(id);
    if (!tab) {
      tab = emptyTab();
      this.#tabs.set(id, tab);
    }
    return tab;
  }

  #host(tab, host, insecure) {
    let entry = tab.sites[host];
    if (!entry) {
      entry = emptyHost();
      tab.sites[host] = entry;
      tab.order.push(host);
      this.#totals.sites += 1;
      // Bounded, because a page pulling from a thousand distinct hosts is
      // either an attack or a bug and must not be allowed to grow the map.
      while (tab.order.length > this.maxHostsPerTab) {
        delete tab.sites[tab.order.shift()];
      }
    }
    if (insecure) entry.insecure = Math.max(entry.insecure, 1);
    return entry;
  }

  // The per-tab view the toolbar badge and the report both read.
  summary(tabId) {
    const tab = this.#tabs.get(tabId);
    if (!tab) return { requests: 0, blocked: 0, bytes: 0, trackers: 0, sites: 0, top: [] };
    const top = tab.order
      .map((host) => ({ host, ...tab.sites[host] }))
      .filter((entry) => entry.blocked > 0 || entry.thirdParty > 0)
      .sort((a, b) => b.blocked - a.blocked || b.thirdParty - a.thirdParty)
      .slice(0, 10);
    return {
      requests: tab.requests,
      blocked: tab.blocked,
      bytes: tab.bytes,
      // "Trackers" means requests we actively refused, which is a defensible
      // number in a way "requests that looked like tracking" is not.
      trackers: tab.blocked,
      sites: tab.order.length,
      top,
    };
  }

  // The badge's view: the page's own grade and its totals, with no per-host list.
  // This runs on every tab broadcast, so it stays O(1) rather than walking hosts.
  glance(tabId) {
    const tab = this.#tabs.get(tabId);
    const primary = this.#primary(tab);
    if (!primary) {
      return {
        requests: 0, blocked: 0, bytes: 0, trackers: 0,
        site: null, score: 100, grade: "excellent", penalties: [],
      };
    }
    const result = score(primary);
    return {
      requests: tab.requests,
      blocked: tab.blocked,
      bytes: tab.bytes,
      trackers: tab.blocked,
      site: primary.host,
      score: result.score,
      grade: result.grade,
      penalties: result.penalties,
    };
  }

  // The host that owns the page, as an entry with a host attached so it can be
  // scored like any other. Falls back to the first host seen, which is what a page
  // with no origin of its own (a data: URL) has to be judged by.
  #primary(tab) {
    if (!tab) return null;
    if (tab.site && tab.sites[tab.site]) return { host: tab.site, ...tab.sites[tab.site] };
    if (!tab.order.length) return null;
    const host = tab.order[0];
    return { host, ...tab.sites[host] };
  }

  // Every host this tab talked to, scored. `top` is the display list and drops
  // clean hosts on purpose; this does not, because a site with nothing against it
  // still deserves to be reported as clean rather than simply absent.
  sites(tabId) {
    const tab = this.#tabs.get(tabId);
    if (!tab) return [];
    return tab.order.map((host) => {
      const entry = tab.sites[host];
      const result = score(entry);
      return {
        host,
        requests: entry.requests,
        blocked: entry.blocked,
        thirdParty: entry.thirdParty,
        bytes: entry.bytes,
        insecure: entry.insecure,
        rules: entry.rules,
        score: result.score,
        grade: result.grade,
        penalties: result.penalties,
      };
    });
  }

  // The score for the page the user is actually looking at: the top-level site,
  // judged on everything that page caused. Off-site hosts are listed so the
  // number can be explained, but they do not dilute the site's own grade.
  report(tabId) {
    const tab = this.#tabs.get(tabId);
    const primary = this.#primary(tab);
    if (!primary) {
      return {
        requests: 0, blocked: 0, bytes: 0, trackers: 0,
        site: null, score: 100, grade: "excellent", penalties: [], sites: [],
      };
    }
    const result = score(primary);
    const all = this.sites(tabId);
    // The page's own host is listed even when it made no subresource requests, so
    // the report always shows what it graded rather than only its neighbours.
    const sites = all.some((entry) => entry.host === primary.host)
      ? all
      : [{ ...primary, score: result.score, grade: result.grade, penalties: result.penalties }, ...all];
    return {
      requests: tab.requests,
      blocked: tab.blocked,
      bytes: tab.bytes,
      trackers: tab.blocked,
      site: primary.host,
      score: result.score,
      grade: result.grade,
      penalties: result.penalties,
      sites: sites.sort((a, b) => b.requests - a.requests).slice(0, 25),
    };
  }

  totals() {
    return { ...this.#totals };
  }

  export() {
    const tabs = {};
    for (const [id, tab] of this.#tabs) {
      tabs[id] = {
        requests: tab.requests,
        blocked: tab.blocked,
        bytes: tab.bytes,
        sites: Object.fromEntries(
          Object.entries(tab.sites).map(([host, entry]) => [host, entry]),
        ),
      };
    }
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      totals: this.totals(),
      tabs,
    };
  }
}

// 0-100, higher is better. Every penalty is reported alongside the score so the
// number is never the whole answer - a score with no reasons is a vibe.
function score(entry) {
  const penalties = [];
  const add = (key, count, weight) => {
    if (count > 0) penalties.push({ key, count, weight, cost: Math.min(count * weight, 100) });
  };
  add("trackers", entry.blocked, WEIGHTS.tracker);
  add("thirdParty", entry.thirdParty - entry.thirdPartyBlocked, WEIGHTS.thirdParty);
  add("insecure", entry.insecure, WEIGHTS.insecure);
  add("mixedContent", entry.insecure, WEIGHTS.mixedContent);

  const cost = penalties.reduce((sum, item) => sum + item.cost, 0);
  return {
    score: Math.max(0, Math.min(100, 100 - cost)),
    grade: grade(100 - cost),
    penalties,
  };
}

function grade(value) {
  if (value >= 90) return "excellent";
  if (value >= 75) return "good";
  if (value >= 50) return "fair";
  if (value >= 25) return "poor";
  return "bad";
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
}

module.exports = {
  Ledger,
  registrable,
  score,
  grade,
  hostOf,
  WEIGHTS,
  emptyHost,
};
