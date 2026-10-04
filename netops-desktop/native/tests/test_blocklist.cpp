#include "netops/net/blocklist.hpp"

#include "netops/util.hpp"
#include "test_harness.hpp"

using namespace netops;
using namespace netops::net;

namespace {

Blocklist builtin_list() {
    Blocklist list;
    for (const std::string& pattern : Blocklist::builtin_patterns()) list.add_builtin(pattern);
    return list;
}

}  // namespace

NETOPS_TEST(blocklist_matches_builtin_hosts_and_subdomains) {
    const Blocklist list = builtin_list();
    const BlockVerdict direct = list.check("https://www.google-analytics.com/collect");
    EXPECT_TRUE(direct.blocked);
    EXPECT_EQ(direct.pattern, std::string("google-analytics.com"));
    EXPECT_EQ(direct.source, std::string("builtin"));

    const BlockVerdict subdomain = list.check("https://stats.doubleclick.net/pixel");
    EXPECT_TRUE(subdomain.blocked);
    EXPECT_EQ(subdomain.source, std::string("builtin"));

    EXPECT_FALSE(list.check("https://example.com/").blocked);
    EXPECT_FALSE(list.check("https://notgoogle-analytics.com.attacker.test/").blocked);
}

NETOPS_TEST(blocklist_matches_path_rules) {
    const Blocklist list = builtin_list();
    const BlockVerdict verdict = list.check("https://www.googletagmanager.com/gtm.js?id=GTM-1");
    EXPECT_TRUE(verdict.blocked);
    EXPECT_EQ(verdict.pattern, std::string("googletagmanager.com/gtm.js"));

    // the same path on an unrelated host is not the built-in rule's business
    EXPECT_FALSE(list.check("https://x.test/gtm.js?id=1").blocked);
}

NETOPS_TEST(blocklist_respects_suffix_rules) {
    Blocklist list;
    list.add_rule(".ads.example", "operator");
    EXPECT_TRUE(list.check("https://cdn.ads.example/x.js").blocked);
    EXPECT_FALSE(list.check("https://ads.example/x.js").blocked);
    EXPECT_FALSE(list.check("https://evil-ads.example/x.js").blocked);

    list.add_rule("re:tracker[0-9]", "operator");
    EXPECT_TRUE(list.check("https://tracker7.example/p").blocked);
    EXPECT_FALSE(list.check("https://tracking.example/p").blocked);

    list.add_rule("  192.0.2.0/24  ", "operator");
    EXPECT_TRUE(list.check("https://metrics.example/collect?ip=192.0.2.5").blocked);
}

NETOPS_TEST(blocklist_ignores_clean_urls) {
    const Blocklist list = builtin_list();
    EXPECT_FALSE(list.check("https://en.wikipedia.org/wiki/Main_Page").blocked);
    EXPECT_FALSE(list.check("about:blank").blocked);
    EXPECT_FALSE(list.check("").blocked);
    EXPECT_FALSE(list.check_host("example.com").blocked);
    EXPECT_TRUE(Blocklist().empty());
}

NETOPS_TEST(blocklist_json_lists_rules) {
    Blocklist list;
    list.add_builtin("doubleclick.net");
    list.add_rule("googletagmanager.com/gtm.js");
    list.add_rule(".ads.example");
    list.add_rule("re:pattern");

    const std::string json = list.to_json();
    EXPECT_CONTAINS(json, "\"pattern\": \"doubleclick.net\"");
    EXPECT_CONTAINS(json, "\"kind\": \"path\"");
    EXPECT_CONTAINS(json, "\"kind\": \"host_suffix\"");
    EXPECT_CONTAINS(json, "\"kind\": \"regex\"");
    EXPECT_CONTAINS(json, "\"source\": \"operator\"");
    EXPECT_EQ(list.size(), std::size_t{4});

    list.clear();
    EXPECT_TRUE(list.empty());
}
