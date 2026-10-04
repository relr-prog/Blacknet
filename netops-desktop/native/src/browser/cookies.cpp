#include "netops/browser/cookies.hpp"

#include <algorithm>
#include <filesystem>

namespace netops::browser {

CookieView redact(const Cookie& cookie) {
    CookieView view;
    view.name = cookie.name;
    view.domain = cookie.domain;
    view.path = cookie.path;
    view.same_site = cookie.same_site;
    view.size = cookie.value.size();
    view.value_preview = cookie.value.empty() ? "" : cookie.value.substr(0, 4) + "…";
    view.expires = cookie.expires;
    view.session = cookie.session();
    view.http_only = cookie.http_only;
    view.secure = cookie.secure;
    return view;
}

void CookieJar::ingest(const std::vector<Cookie>& cookies) { cookies_ = cookies; }

void CookieJar::clear() { cookies_.clear(); }

std::vector<const Cookie*> CookieJar::select(std::string_view domain) const {
    std::vector<const Cookie*> out;
    const std::string needle = lower(domain);
    for (const Cookie& cookie : cookies_) {
        if (needle.empty() || contains(lower(cookie.domain), needle)) out.push_back(&cookie);
    }
    return out;
}

CookieReport CookieJar::report(double now, std::string_view domain_filter,
                               bool include_expired) const {
    CookieReport report;
    const std::string needle = lower(domain_filter);

    for (const Cookie& cookie : cookies_) {
        if (!needle.empty() && !contains(lower(cookie.domain), needle)) continue;

        CookieView view = redact(cookie);
        view.expired = !cookie.session() && cookie.expires < now;
        if (view.expired && !include_expired) {
            // still counted in the totals so the panel can show stale entries
            ++report.expired_count;
        }
        if (view.expired && !include_expired) continue;

        ++report.total;
        if (cookie.session()) ++report.session_cookies;
        if (cookie.http_only) ++report.http_only;
        if (cookie.secure) ++report.secure;
        if (!starts_with(cookie.domain, ".")) ++report.third_party;
        report.cookies.push_back(std::move(view));
    }

    std::vector<DomainCount> counts;
    for (const CookieView& view : report.cookies) {
        auto it = std::find_if(counts.begin(), counts.end(),
                               [&](const DomainCount& entry) { return entry.domain == view.domain; });
        if (it == counts.end()) {
            counts.push_back({view.domain, 1});
        } else {
            ++it->count;
        }
    }
    std::sort(counts.begin(), counts.end(),
              [](const DomainCount& a, const DomainCount& b) {
                  if (a.count != b.count) return a.count > b.count;
                  return a.domain < b.domain;
              });
    if (counts.size() > 50) counts.resize(50);
    report.domains = std::move(counts);
    return report;
}

std::string CookieReport::to_json() const {
    JsonWriter json;
    json.begin_object();
    json.field("count", static_cast<std::int64_t>(total));
    json.field("session_cookies", static_cast<std::int64_t>(session_cookies));
    json.field("http_only", static_cast<std::int64_t>(http_only));
    json.field("secure", static_cast<std::int64_t>(secure));
    json.field("third_party", static_cast<std::int64_t>(third_party));
    json.field("expired", static_cast<std::int64_t>(expired_count));

    json.key("cookies").begin_array();
    for (const CookieView& view : cookies) {
        json.begin_object();
        json.field("name", view.name);
        json.field("domain", view.domain);
        json.field("path", view.path);
        json.field("same_site", view.same_site);
        json.field("value_preview", view.value_preview);
        json.field("size", static_cast<std::int64_t>(view.size));
        json.field("expires", view.expires);
        json.field("session", view.session);
        json.field("http_only", view.http_only);
        json.field("secure", view.secure);
        json.field("expired", view.expired);
        json.end_object();
    }
    json.end_array();

    json.key("domains").begin_array();
    for (const DomainCount& entry : domains) {
        json.begin_object();
        json.field("domain", entry.domain);
        json.field("count", static_cast<std::int64_t>(entry.count));
        json.end_object();
    }
    json.end_array();
    json.end_object();
    return json.str();
}

}  // namespace netops::browser
