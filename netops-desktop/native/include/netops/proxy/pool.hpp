// Rotating proxy data plane.
//
// This is the hot path: for every request the gateway needs an upstream that
// is healthy, sticky for the caller, and drawn from the configured tier. All of
// that bookkeeping lives here, lock-free per call, so the socket layer only has
// to move bytes.
#pragma once

#include <atomic>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "netops/util.hpp"

namespace netops::proxy {

enum class UpstreamKind { Http, Https, Socks5, Direct, Circuit };
enum class Health { Unknown, Healthy, Degraded, Unhealthy, Quarantined };
enum class Strategy { RoundRobin, Random, LeastUsed, Sticky, Failover };

std::string_view kind_name(UpstreamKind kind);
std::optional<UpstreamKind> parse_kind(std::string_view text);
std::string_view health_name(Health health);
std::optional<Health> parse_health(std::string_view text);
std::string_view strategy_name(Strategy strategy);
std::optional<Strategy> parse_strategy(std::string_view text);

struct Upstream {
    std::string id;          // stable handle used by the panel
    std::string host;
    std::uint16_t port = 0;
    UpstreamKind kind = UpstreamKind::Http;
    std::string username;
    std::string password;
    std::string tag;

    Health health = Health::Unknown;
    std::string country;
    std::string exit_ip;
    std::uint64_t latency_ms = 0;
    std::uint64_t requests = 0;
    std::uint64_t failures = 0;
    std::uint64_t bytes_in = 0;
    std::uint64_t bytes_out = 0;
    double last_checked = 0;  // unix seconds
    std::string last_error;

    bool usable() const;
    double success_rate() const;
    std::string display() const;
    std::string to_json() const;
};

struct Tier {
    std::string name;
    Strategy strategy = Strategy::RoundRobin;
    std::vector<std::string> upstream_ids;
};

struct Selection {
    const Upstream* upstream = nullptr;
    std::size_t tier_index = 0;
    std::string reason;  // why this upstream was chosen
};

// Parses the same "host:port:user:pass#tag=lab" format the IP rotator accepts.
std::optional<Upstream> parse_upstream(std::string_view text, std::string_view kind_hint = {});

class Pool {
public:
    Pool() = default;
    Pool(const Pool&) = delete;            // atomics make copying meaningless
    Pool& operator=(const Pool&) = delete;
    // std::atomic is not movable, so transfers copy the counters across explicitly.
    Pool(Pool&& other) noexcept
        : upstreams_(std::move(other.upstreams_)),
          tiers_(std::move(other.tiers_)),
          tier_index_(std::move(other.tier_index_)),
          cursors_(std::move(other.cursors_)),
          requests_(other.requests_.load()),
          failures_(other.failures_.load()) {}

    Pool& operator=(Pool&& other) noexcept {
        if (this == &other) return *this;
        upstreams_ = std::move(other.upstreams_);
        tiers_ = std::move(other.tiers_);
        tier_index_ = std::move(other.tier_index_);
        cursors_ = std::move(other.cursors_);
        requests_.store(other.requests_.load());
        failures_.store(other.failures_.load());
        return *this;
    }

    // --- configuration -----------------------------------------------------
    std::string add_tier(std::string name, Strategy strategy, std::vector<Upstream> upstreams);
    bool remove_tier(std::string_view name);
    bool set_strategy(std::string_view name, Strategy strategy);
    bool set_slots(std::string_view name, std::size_t slots);
    std::optional<std::size_t> tier_index(std::string_view name) const;
    std::size_t tier_size(std::string_view name) const;
    std::vector<std::string> tier_names() const;

    std::size_t size() const { return upstreams_.size(); }
    std::size_t tier_count() const { return tiers_.size(); }
    const std::vector<Upstream>& upstreams() const { return upstreams_; }
    const Upstream* find(std::string_view id) const;
    Upstream* find_mutable(std::string_view id);

    // --- data plane --------------------------------------------------------
    Selection select(std::string_view sticky_key = {}) const;
    void note_success(std::string_view id, std::uint64_t bytes, double now);
    void note_failure(std::string_view id, std::string_view error, double now);
    void quarantine(std::string_view id, double until);

    // --- reporting ---------------------------------------------------------
    std::uint64_t requests() const { return requests_.load(); }
    std::uint64_t failures() const { return failures_.load(); }
    std::size_t healthy_count() const;
    std::string to_json() const;

private:
    // Every upstream must belong to exactly one tier. Resizing a tier's slot
    // list or replacing a tier can orphan entries, so drop them explicitly
    // instead of letting size()/to_json() drift.
    void prune_orphans();

    std::vector<Upstream> upstreams_;
    std::vector<Tier> tiers_;
    std::map<std::string, std::size_t> tier_index_;
    mutable std::vector<std::size_t> cursors_;
    mutable std::atomic<std::uint64_t> requests_{0};
    mutable std::atomic<std::uint64_t> failures_{0};
};

}  // namespace netops::proxy
