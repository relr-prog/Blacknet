#include "netops/browser/cookies.hpp"

#include "test_harness.hpp"

using namespace netops;
using namespace netops::browser;

namespace {

Cookie make(std::string name, std::string value, std::string domain, double expires = -1) {
    Cookie cookie;
    cookie.name = std::move(name);
    cookie.value = std::move(value);
    cookie.domain = std::move(domain);
    cookie.expires = expires;
    return cookie;
}

std::vector<Cookie> sample() {
    return {
        make("session", "super-secret-token", ".example.com"),
        make("pref", "dark", ".example.com", 4102444800.0),
        make("analytics", "ga-value", "tracker.test"),
        make("http_only", "hidden", ".example.com"),
    };
}

}  // namespace

NETOPS_TEST(cookies_are_redacted_in_the_report) {
    CookieJar jar;
    jar.ingest(sample());
    const CookieReport report = jar.report(1000.0);

    EXPECT_EQ(report.total, std::size_t{4});
    EXPECT_EQ(report.session_cookies, std::size_t{3});
    EXPECT_EQ(report.secure, std::size_t{0});

    const CookieView session = report.cookies.front();
    EXPECT_EQ(session.name, std::string("session"));
    EXPECT_EQ(session.value_preview, std::string("supe…"));
    EXPECT_EQ(session.size, std::size_t{18});  // length of "super-secret-token"
    EXPECT_EQ(session.session, true);

    for (const CookieView& cookie : report.cookies) {
        // four characters plus a three-byte UTF-8 ellipsis
        EXPECT_TRUE(cookie.value_preview.size() <= 7);
    }
}

NETOPS_TEST(cookies_group_by_domain) {
    CookieJar jar;
    jar.ingest(sample());
    const CookieReport report = jar.report(1000.0);

    EXPECT_EQ(report.domains.size(), std::size_t{2});
    EXPECT_EQ(report.domains[0].domain, std::string(".example.com"));
    EXPECT_EQ(report.domains[0].count, std::size_t{3});
    EXPECT_EQ(report.domains[1].domain, std::string("tracker.test"));
    EXPECT_EQ(report.third_party, std::size_t{1});
}

NETOPS_TEST(cookies_filter_by_domain_and_expiry) {
    CookieJar jar;
    jar.ingest({make("old", "v", ".a.test", 10.0), make("new", "v", ".b.test", 5000.0),
                make("session", "v", ".a.test")});

    const CookieReport expired_hidden = jar.report(1000.0, {}, false);
    EXPECT_EQ(expired_hidden.total, std::size_t{2});
    EXPECT_EQ(expired_hidden.expired_count, std::size_t{1});

    const CookieReport with_expired = jar.report(1000.0, {}, true);
    EXPECT_EQ(with_expired.total, std::size_t{3});
    EXPECT_EQ(with_expired.cookies.front().expired, true);

    EXPECT_EQ(jar.report(1000.0, "a.test", false).total, std::size_t{1});
    EXPECT_EQ(jar.report(1000.0, "nothing.test", false).total, std::size_t{0});
}

NETOPS_TEST(cookies_select_for_clearing) {
    CookieJar jar;
    jar.ingest(sample());
    EXPECT_EQ(jar.select(".example.com").size(), std::size_t{3});
    EXPECT_EQ(jar.select("tracker.test").size(), std::size_t{1});
    EXPECT_EQ(jar.select("").size(), std::size_t{4});
    EXPECT_EQ(jar.select("nothing.test").size(), std::size_t{0});

    jar.clear();
    EXPECT_EQ(jar.size(), std::size_t{0});
}

NETOPS_TEST(cookie_report_json_has_no_values) {
    CookieJar jar;
    jar.ingest(sample());
    const std::string json = jar.report(1000.0).to_json();

    EXPECT_FALSE(json.find("super-secret-token") != std::string::npos);
    EXPECT_FALSE(json.find("ga-value") != std::string::npos);
    EXPECT_CONTAINS(json, "\"value_preview\": \"supe…\"");
    EXPECT_CONTAINS(json, "\"count\": 3");
    EXPECT_CONTAINS(json, "\"http_only\"");
}
