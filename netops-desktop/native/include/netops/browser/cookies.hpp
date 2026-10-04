// Cookie management: ingest, redact, group and clear.
//
// Cookie values are secrets, so the view the panel receives never contains
// them: only a short preview and the length.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "netops/util.hpp"

namespace netops::browser {

struct Cookie {
    std::string name;
    std::string value;
    std::string domain;
    std::string path = "/";
    std::string same_site;
    double expires = -1;  // -1 means session cookie
    bool http_only = false;
    bool secure = false;

    bool session() const { return expires <= 0; }
    double expires_in(double now) const { return session() ? -1 : expires - now; }
};

struct CookieView {
    std::string name;
    std::string domain;
    std::string path;
    std::string same_site;
    std::string value_preview;  // first 4 characters plus an ellipsis
    std::size_t size = 0;
    double expires = -1;
    bool session = false;
    bool http_only = false;
    bool secure = false;
    bool expired = false;
};

struct DomainCount {
    std::string domain;
    std::size_t count = 0;
};

struct CookieReport {
    std::vector<CookieView> cookies;
    std::vector<DomainCount> domains;
    std::size_t total = 0;
    std::size_t session_cookies = 0;
    std::size_t http_only = 0;
    std::size_t secure = 0;
    std::size_t third_party = 0;
    std::size_t expired_count = 0;

    std::string to_json() const;
};

class CookieJar {
public:
    void ingest(const std::vector<Cookie>& cookies);
    void clear();
    std::size_t size() const { return cookies_.size(); }

    CookieReport report(double now, std::string_view domain_filter = {},
                        bool include_expired = false) const;

    // Which cookies belong to a domain, for "clear these cookies only".
    std::vector<const Cookie*> select(std::string_view domain) const;

private:
    std::vector<Cookie> cookies_;
};

CookieView redact(const Cookie& cookie);

}  // namespace netops::browser
