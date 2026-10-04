#include <filesystem>

#include "netops/net/url.hpp"
#include "test_harness.hpp"

using namespace netops;
using namespace netops::net;

namespace {

NormalisedUrl ok(std::string_view raw, const UrlPolicy& policy = UrlPolicy{}) {
    UrlError error;
    auto parsed = normalise_url(raw, policy, &error);
    if (!parsed) throw test::Failure("expected " + std::string(raw) + " to parse: " + error.message);
    return *parsed;
}

std::string refused(std::string_view raw, const UrlPolicy& policy = UrlPolicy{}) {
    UrlError error;
    if (normalise_url(raw, policy, &error).has_value()) {
        throw test::Failure("expected " + std::string(raw) + " to be refused");
    }
    return error.message;
}

}  // namespace

NETOPS_TEST(url_accepts_bare_hosts) {
    EXPECT_EQ(ok("example.com").url, std::string("https://example.com"));
    EXPECT_EQ(ok("  spaced.test  ").url, std::string("https://spaced.test"));
    EXPECT_EQ(ok("https://example.com/a?b=1#c").host, std::string("example.com"));
    EXPECT_EQ(ok("https://example.com/a?b=1#c").path, std::string("/a?b=1#c"));
    EXPECT_EQ(ok("EXAMPLE.COM").host, std::string("example.com"));
    EXPECT_EQ(ok("example.com").secure, true);
}

NETOPS_TEST(url_upgrades_http_when_https_only) {
    EXPECT_EQ(ok("http://plain.test").url, std::string("https://plain.test"));
    EXPECT_EQ(ok("http://plain.test").scheme, std::string("https"));

    UrlPolicy permissive;
    permissive.https_only = false;
    EXPECT_EQ(ok("http://plain.test", permissive).url, std::string("http://plain.test"));
    EXPECT_EQ(ok("http://plain.test", permissive).secure, false);
}

NETOPS_TEST(url_keeps_loopback_on_plain_http) {
    // The desktop shell serves its own control plane over http on 127.0.0.1 and
    // no public CA will sign that name, so https-only must not apply there.
    UrlPolicy strict;
    strict.https_only = true;

    EXPECT_EQ(ok("http://127.0.0.1:8787/", strict).url,
              std::string("http://127.0.0.1:8787/"));
    EXPECT_EQ(ok("http://127.0.0.1:8787/", strict).scheme, std::string("http"));
    EXPECT_EQ(ok("http://localhost:8787/", strict).scheme, std::string("http"));
    // ...but an unprefixed loopback name still defaults to https.
    EXPECT_EQ(ok("localhost:8787", strict).scheme, std::string("http"));

    // Public hosts are unaffected.
    EXPECT_EQ(ok("http://plain.test", strict).scheme, std::string("https"));
}

NETOPS_TEST(url_rejects_dangerous_schemes) {
    EXPECT_CONTAINS(refused("file:///etc/passwd"), "not allowed");
    EXPECT_CONTAINS(refused("javascript:alert(1)"), "not allowed");
    EXPECT_CONTAINS(refused("chrome://settings"), "not allowed");
    EXPECT_CONTAINS(refused("ws://example.com"), "not allowed");
    EXPECT_CONTAINS(refused(""), "required");
    EXPECT_CONTAINS(refused("about:config"), "about:blank");
    // about:blank is the new-tab page, so it stays allowed (trimmed or not).
    EXPECT_EQ(ok("about:blank").scheme, std::string("about"));
    EXPECT_EQ(ok(" about:blank ").url, std::string("about:blank"));
}

NETOPS_TEST(url_rejects_embedded_credentials) {
    EXPECT_CONTAINS(refused("https://user:pass@example.com"), "credentials");
    EXPECT_CONTAINS(refused("https://user@example.com"), "credentials");
    EXPECT_CONTAINS(refused("https://example.com/a b"), "illegal characters");
    EXPECT_CONTAINS(refused("https://exa\"mple.com"), "illegal characters");
}

NETOPS_TEST(url_parses_port_and_path) {
    EXPECT_EQ(ok("https://example.com:8443/x").port, 8443);
    EXPECT_EQ(ok("example.com:8080").port, 8080);
    EXPECT_EQ(ok("example.com:8080").host, std::string("example.com"));
    EXPECT_EQ(ok("example.com:8080").url, std::string("https://example.com:8080"));
    EXPECT_CONTAINS(refused("https://example.com:99999"), "invalid port");
    EXPECT_CONTAINS(refused("https://example.com:abc"), "invalid port");
    EXPECT_CONTAINS(refused("https://"), "no host");
    EXPECT_EQ(ok("https://example.com").path, std::string("/"));
}

NETOPS_TEST(url_handles_ipv6_literals) {
    const NormalisedUrl parsed = ok("https://[2001:db8::1]:443/x");
    EXPECT_EQ(parsed.host, std::string("[2001:db8::1]"));
    EXPECT_EQ(parsed.port, 443);
    EXPECT_CONTAINS(refused("https://[2001:db8::1"), "malformed");
}

NETOPS_TEST(url_limits_data_urls) {
    EXPECT_EQ(ok("data:text/html,<h1>hi</h1>").scheme, std::string("data"));
    // a nested scheme inside the payload must not confuse scheme detection
    EXPECT_EQ(ok("data:text/html,<a href='https://x.test'>y</a>").scheme, std::string("data"));
    EXPECT_CONTAINS(refused("data:image/png;base64,AAA"), "only data:text/html");

    UrlPolicy policy;
    policy.max_data_url_length = 16;
    EXPECT_CONTAINS(refused("data:text/html,aaaaaaaaaaaaaaaaaaaa", policy), "longer than");

    UrlPolicy disabled;
    disabled.allow_data_html = false;
    EXPECT_CONTAINS(refused("data:text/html,x", disabled), "disabled");
}

NETOPS_TEST(host_validation_blocks_private_ranges) {
    HostPolicy policy;
    EXPECT_TRUE(validate_hostname("example.com", policy).has_value());
    EXPECT_FALSE(validate_hostname("127.0.0.1", policy).has_value());
    EXPECT_FALSE(validate_hostname("10.1.2.3", policy).has_value());
    EXPECT_FALSE(validate_hostname("192.168.1.5", policy).has_value());
    EXPECT_FALSE(validate_hostname("172.16.0.9", policy).has_value());
    EXPECT_FALSE(validate_hostname("169.254.1.1", policy).has_value());
    EXPECT_FALSE(validate_hostname("localhost", policy).has_value());
    EXPECT_FALSE(validate_hostname("printer.local", policy).has_value());
    EXPECT_FALSE(validate_hostname("db.internal", policy).has_value());

    UrlError error;
    validate_hostname("192.168.1.5", policy, &error);
    EXPECT_CONTAINS(error.message, "private");
}

NETOPS_TEST(host_validation_allows_private_when_opted_in) {
    HostPolicy policy;
    policy.allow_private = true;
    EXPECT_TRUE(validate_hostname("127.0.0.1", policy).has_value());
    EXPECT_TRUE(validate_hostname("192.168.1.5", policy).has_value());
    EXPECT_TRUE(validate_hostname("localhost", policy).has_value());

    HostPolicy localhost_only;
    localhost_only.allow_localhost = true;
    EXPECT_TRUE(validate_hostname("localhost", localhost_only).has_value());
    EXPECT_FALSE(validate_hostname("10.0.0.1", localhost_only).has_value());

    EXPECT_FALSE(validate_hostname("", policy).has_value());
    EXPECT_FALSE(validate_hostname("-bad.test", policy).has_value());
    EXPECT_FALSE(validate_hostname("bad-.test", policy).has_value());
    EXPECT_FALSE(validate_hostname("a..b.test", policy).has_value());
    EXPECT_TRUE(validate_hostname("xn--bcher-kva.example", policy).has_value());
}

NETOPS_TEST(url_should_block_helper) {
    UrlPolicy policy;
    EXPECT_TRUE(should_block("javascript:alert(1)", policy));
    EXPECT_FALSE(should_block("https://example.com", policy));
    EXPECT_TRUE(is_private_ipv4("10.0.0.1"));
    EXPECT_FALSE(is_private_ipv4("11.0.0.1"));
    EXPECT_TRUE(is_loopback("127.0.0.1"));
    EXPECT_TRUE(is_loopback("localhost"));
}
