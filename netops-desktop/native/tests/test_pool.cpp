#include "netops/proxy/pool.hpp"

#include "test_harness.hpp"

using namespace netops;
using namespace netops::proxy;

namespace {

std::vector<Upstream> make_pool(const std::vector<std::string>& specs) {
    std::vector<Upstream> upstreams;
    for (const std::string& spec : specs) {
        auto parsed = parse_upstream(spec);
        if (!parsed) throw test::Failure("cannot parse upstream: " + spec);
        upstreams.push_back(*parsed);
    }
    return upstreams;
}

Pool two_tier_pool() {
    Pool pool;
    pool.add_tier("lab", Strategy::RoundRobin, make_pool({"1.1.1.1:8080#tag=a", "1.1.1.2:8080#tag=b"}));
    pool.add_tier("backup", Strategy::Failover, make_pool({"2.2.2.2:1080#tag=tor"}));
    return pool;
}

}  // namespace

NETOPS_TEST(pool_parses_upstream_formats) {
    const auto plain = parse_upstream("127.0.0.1:8080");
    EXPECT_TRUE(plain.has_value());
    EXPECT_EQ(plain->host, std::string("127.0.0.1"));
    EXPECT_EQ(plain->port, std::uint16_t{8080});
    EXPECT_EQ(plain->kind, UpstreamKind::Http);

    const auto authed = parse_upstream("socks5://user:pass@127.0.0.1:1080#tag=tor");
    EXPECT_EQ(authed->kind, UpstreamKind::Socks5);
    EXPECT_EQ(authed->username, std::string("user"));
    EXPECT_EQ(authed->password, std::string("pass"));
    EXPECT_EQ(authed->tag, std::string("tor"));

    const auto tor = parse_upstream("tor#tag=local");
    EXPECT_EQ(tor->kind, UpstreamKind::Tor);
    EXPECT_EQ(tor->tag, std::string("local"));

    const auto direct = parse_upstream("direct");
    EXPECT_EQ(direct->kind, UpstreamKind::Direct);
    EXPECT_EQ(direct->display(), std::string("direct"));

    const auto hinted = parse_upstream("proxy.test:3128", "socks5");
    EXPECT_EQ(hinted->kind, UpstreamKind::Socks5);

    const auto ipv6 = parse_upstream("http://[2001:db8::1]:8080");
    EXPECT_EQ(ipv6->host, std::string("2001:db8::1"));

    // passwords never appear in the panel-facing string
    EXPECT_FALSE(authed->display().find("pass") != std::string::npos);
    EXPECT_CONTAINS(authed->display(), "user:***");
}

NETOPS_TEST(pool_rejects_broken_specs) {
    EXPECT_FALSE(parse_upstream("").has_value());
    EXPECT_FALSE(parse_upstream("no-port").has_value());
    EXPECT_FALSE(parse_upstream("host:0").has_value());
    EXPECT_FALSE(parse_upstream("host:99999").has_value());
    EXPECT_FALSE(parse_upstream(":8080").has_value());
    EXPECT_FALSE(parse_upstream("host:abc").has_value());
    EXPECT_FALSE(parse_upstream("wat://host:80").has_value());
    EXPECT_FALSE(parse_upstream("http://[2001:db8::1:80").has_value());
}

NETOPS_TEST(pool_round_robin_advances) {
    Pool pool = two_tier_pool();
    std::vector<std::string> seen;
    for (int i = 0; i < 4; ++i) {
        const Selection picked = pool.select();
        EXPECT_TRUE(picked.upstream != nullptr);
        seen.push_back(picked.upstream->tag);
    }
    EXPECT_EQ(seen[0], seen[2]);
    EXPECT_EQ(seen[1], seen[3]);
    EXPECT_TRUE(seen[0] != seen[1]);
    EXPECT_EQ(pool.requests(), std::uint64_t{4});
}

NETOPS_TEST(pool_sticky_is_deterministic) {
    Pool pool;
    pool.add_tier("sticky", Strategy::Sticky, make_pool({"1.1.1.1:8080", "1.1.1.2:8080",
                                                          "1.1.1.3:8080"}));
    const std::string first = pool.select("user-42").upstream->id;
    for (int i = 0; i < 5; ++i) {
        EXPECT_EQ(pool.select("user-42").upstream->id, first);
    }
    // the hash is stable across processes, so restarts keep sessions pinned
    EXPECT_EQ(pool.select("user-43").upstream->id, pool.select("user-43").upstream->id);
    EXPECT_EQ(first, pool.select("").upstream->id);
}

NETOPS_TEST(pool_least_used_prefers_idle) {
    Pool pool;
    pool.add_tier("least", Strategy::LeastUsed, make_pool({"1.1.1.1:8080", "1.1.1.2:8080"}));
    pool.note_success(pool.upstreams()[0].id, 100, 1.0);
    pool.note_success(pool.upstreams()[0].id, 100, 1.0);

    const Selection picked = pool.select();
    EXPECT_EQ(picked.upstream->id, pool.upstreams()[1].id);
    EXPECT_EQ(pool.upstreams()[0].requests, std::uint64_t{2});
    EXPECT_EQ(pool.upstreams()[0].success_rate(), 1.0);
}

NETOPS_TEST(pool_failover_prefers_healthy) {
    Pool pool;
    pool.add_tier("fo", Strategy::Failover, make_pool({"1.1.1.1:8080", "1.1.1.2:8080"}));
    pool.note_failure(pool.upstreams()[0].id, "timeout", 1.0);
    const Selection picked = pool.select();
    EXPECT_EQ(picked.upstream->id, pool.upstreams()[1].id);
    EXPECT_EQ(pool.upstreams()[0].health, Health::Unhealthy);
    EXPECT_EQ(pool.upstreams()[0].last_error, std::string("timeout"));
    EXPECT_EQ(pool.failures(), std::uint64_t{1});
}

NETOPS_TEST(pool_skips_unhealthy_upstreams) {
    Pool pool;
    pool.add_tier("rr", Strategy::RoundRobin, make_pool({"1.1.1.1:8080", "1.1.1.2:8080"}));
    pool.note_failure(pool.upstreams()[0].id, "reset", 1.0);
    for (int i = 0; i < 5; ++i) {
        EXPECT_EQ(pool.select().upstream->id, pool.upstreams()[1].id);
    }
    EXPECT_EQ(pool.select("anything").upstream->id, pool.upstreams()[1].id);

    // with every upstream down, the pool reports nothing rather than a bad pick
    pool.note_failure(pool.upstreams()[1].id, "reset", 1.0);
    EXPECT_TRUE(pool.select().upstream == nullptr);
}

NETOPS_TEST(pool_records_success_and_failure) {
    Pool pool;
    pool.add_tier("rr", Strategy::RoundRobin, make_pool({"1.1.1.1:8080"}));
    const std::string id = pool.upstreams()[0].id;

    pool.note_success(id, 2048, 100.0);
    pool.note_success(id, 512, 110.0);
    const Upstream* upstream = pool.find(id);
    EXPECT_TRUE(upstream != nullptr);
    EXPECT_EQ(upstream->requests, std::uint64_t{2});
    EXPECT_EQ(upstream->bytes_out, std::uint64_t{2560});
    EXPECT_EQ(upstream->health, Health::Healthy);
    EXPECT_EQ(upstream->last_checked, 110.0);

    pool.note_failure(id, "boom", 120.0);
    upstream = pool.find(id);
    EXPECT_EQ(upstream->health, Health::Unhealthy);
    EXPECT_EQ(upstream->success_rate(), 2.0 / 3.0);
    EXPECT_TRUE(pool.find("nope") == nullptr);
    EXPECT_TRUE(pool.find_mutable("nope") == nullptr);
}

NETOPS_TEST(pool_quarantine_hides_upstream) {
    Pool pool;
    pool.add_tier("rr", Strategy::RoundRobin, make_pool({"1.1.1.1:8080", "1.1.1.2:8080"}));
    pool.quarantine(pool.upstreams()[0].id, 999.0);
    EXPECT_FALSE(pool.upstreams()[0].usable());
    EXPECT_EQ(pool.select().upstream->id, pool.upstreams()[1].id);
    EXPECT_EQ(pool.healthy_count(), std::size_t{0});
}

NETOPS_TEST(pool_tier_management) {
    Pool pool = two_tier_pool();
    EXPECT_EQ(pool.tier_count(), std::size_t{2});
    EXPECT_EQ(pool.tier_names()[0], std::string("lab"));
    EXPECT_TRUE(pool.tier_index("lab").has_value());
    EXPECT_FALSE(pool.tier_index("missing").has_value());

    EXPECT_TRUE(pool.set_strategy("lab", Strategy::Random));
    EXPECT_FALSE(pool.set_strategy("missing", Strategy::Random));
    EXPECT_TRUE(pool.set_slots("lab", 1));
    EXPECT_EQ(pool.tier_size("lab"), std::size_t{1});
    EXPECT_FALSE(pool.set_slots("missing", 1));

    // re-adding the same name replaces its contents
    pool.add_tier("lab", Strategy::Sticky, make_pool({"9.9.9.9:8080"}));
    EXPECT_EQ(pool.size(), std::size_t{2});
    // the replaced tier's old upstreams are gone, the backup tier is untouched
    EXPECT_EQ(pool.find("9.9.9.9:8080"), nullptr);  // ids carry a hash, not the spec
    for (const Upstream& upstream : pool.upstreams()) {
        EXPECT_TRUE(upstream.host == "9.9.9.9" || upstream.host == "2.2.2.2");
    }
}

NETOPS_TEST(pool_remove_tier_drops_upstreams) {
    Pool pool = two_tier_pool();
    EXPECT_TRUE(pool.remove_tier("lab"));
    EXPECT_FALSE(pool.remove_tier("lab"));
    EXPECT_EQ(pool.tier_count(), std::size_t{1});
    EXPECT_EQ(pool.size(), std::size_t{1});
    EXPECT_EQ(pool.upstreams()[0].host, std::string("2.2.2.2"));
    EXPECT_EQ(pool.tier_names()[0], std::string("backup"));
    EXPECT_EQ(pool.tier_index("backup").value(), std::size_t{0});  // indices are rebuilt
    EXPECT_FALSE(pool.tier_index("lab").has_value());
}

NETOPS_TEST(pool_json_summary) {
    Pool pool = two_tier_pool();
    pool.note_success(pool.upstreams()[0].id, 10, 1.0);
    const std::string json = pool.to_json();
    EXPECT_CONTAINS(json, "\"upstreams\": 3");
    EXPECT_CONTAINS(json, "\"tiers\": 2");
    EXPECT_CONTAINS(json, "\"strategy\": \"round_robin\"");
    EXPECT_CONTAINS(json, "\"kind\": \"http\"");  // two_tier_pool() has no socks5 entry
    EXPECT_CONTAINS(json, "\"health\": \"healthy\"");
    EXPECT_CONTAINS(json, "\"success_rate\": 1");
    EXPECT_FALSE(json.find("\"upstream_list\": [\"") != std::string::npos);
}
