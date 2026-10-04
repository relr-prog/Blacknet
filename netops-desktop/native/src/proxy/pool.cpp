#include "netops/proxy/pool.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <random>
#include <unordered_set>

namespace netops::proxy {
namespace {

// Lower is better: failover strategies walk the tiers in this order.
int health_rank(Health health) {
    switch (health) {
        case Health::Healthy: return 0;
        case Health::Unknown: return 1;
        case Health::Degraded: return 2;
        case Health::Unhealthy: return 3;
        case Health::Quarantined: return 4;
    }
    return 5;
}

std::uint64_t parse_number(std::string_view text, std::uint64_t fallback) {
    if (text.empty()) return fallback;
    std::uint64_t value = 0;
    for (const char c : text) {
        if (!std::isdigit(static_cast<unsigned char>(c))) return fallback;
        value = value * 10 + static_cast<std::uint64_t>(c - '0');
    }
    return value;
}

}  // namespace

std::string_view kind_name(UpstreamKind kind) {
    switch (kind) {
        case UpstreamKind::Http: return "http";
        case UpstreamKind::Https: return "https";
        case UpstreamKind::Socks5: return "socks5";
        case UpstreamKind::Direct: return "direct";
        case UpstreamKind::Tor: return "tor";
    }
    return "http";
}

std::optional<UpstreamKind> parse_kind(std::string_view text) {
    const std::string value = lower(trim(text));
    if (value == "http") return UpstreamKind::Http;
    if (value == "https") return UpstreamKind::Https;
    if (value == "socks5" || value == "socks") return UpstreamKind::Socks5;
    if (value == "direct" || value == "none") return UpstreamKind::Direct;
    if (value == "tor") return UpstreamKind::Tor;
    return std::nullopt;
}

std::string_view health_name(Health health) {
    switch (health) {
        case Health::Unknown: return "unknown";
        case Health::Healthy: return "healthy";
        case Health::Degraded: return "degraded";
        case Health::Unhealthy: return "unhealthy";
        case Health::Quarantined: return "quarantined";
    }
    return "unknown";
}

std::optional<Health> parse_health(std::string_view text) {
    const std::string value = lower(trim(text));
    if (value == "unknown") return Health::Unknown;
    if (value == "healthy" || value == "up") return Health::Healthy;
    if (value == "degraded") return Health::Degraded;
    if (value == "unhealthy" || value == "down") return Health::Unhealthy;
    if (value == "quarantined") return Health::Quarantined;
    return std::nullopt;
}

std::string_view strategy_name(Strategy strategy) {
    switch (strategy) {
        case Strategy::RoundRobin: return "round_robin";
        case Strategy::Random: return "random";
        case Strategy::LeastUsed: return "least_used";
        case Strategy::Sticky: return "sticky";
        case Strategy::Failover: return "failover";
    }
    return "round_robin";
}

std::optional<Strategy> parse_strategy(std::string_view text) {
    const std::string value = lower(trim(text));
    if (value == "round_robin" || value == "roundrobin" || value == "rr") return Strategy::RoundRobin;
    if (value == "random") return Strategy::Random;
    if (value == "least_used" || value == "leastused") return Strategy::LeastUsed;
    if (value == "sticky") return Strategy::Sticky;
    if (value == "failover") return Strategy::Failover;
    return std::nullopt;
}

bool Upstream::usable() const {
    return health != Health::Unhealthy && health != Health::Quarantined;
}

double Upstream::success_rate() const {
    const std::uint64_t total = requests + failures;
    if (total == 0) return 1.0;
    return static_cast<double>(requests) / static_cast<double>(total);
}

std::string Upstream::display() const {
    if (kind == UpstreamKind::Direct) return "direct";
    if (kind == UpstreamKind::Tor) return "tor:" + host + ":" + std::to_string(port);
    std::string out = std::string(kind_name(kind)) + "://" + host + ":" + std::to_string(port);
    if (!username.empty()) out = std::string(kind_name(kind)) + "://" + username + ":***@" + host +
                                 ":" + std::to_string(port);
    if (!tag.empty()) out += "#" + tag;
    return out;
}

std::string Upstream::to_json() const {
    JsonWriter json;
    json.begin_object();
    json.field("id", id);
    json.field("host", host);
    json.field("port", static_cast<std::int64_t>(port));
    json.field("kind", std::string(kind_name(kind)));
    json.field("display", display());
    json.field("tag", tag);
    json.field("health", std::string(health_name(health)));
    json.field("country", country);
    json.field("exit_ip", exit_ip);
    json.field("latency_ms", static_cast<std::int64_t>(latency_ms));
    json.field("requests", static_cast<std::int64_t>(requests));
    json.field("failures", static_cast<std::int64_t>(failures));
    json.field("bytes_in", static_cast<std::int64_t>(bytes_in));
    json.field("bytes_out", static_cast<std::int64_t>(bytes_out));
    json.field("success_rate", success_rate());
    json.field("last_checked", last_checked);
    json.field("last_error", last_error);
    json.field("authenticated", !username.empty());
    json.end_object();
    return json.str();
}

std::optional<Upstream> parse_upstream(std::string_view text, std::string_view kind_hint) {
    std::string spec = trim(text);
    if (spec.empty()) return std::nullopt;

    Upstream upstream;
    std::string tag;

    // fragment: #tag=lab
    const std::size_t hash = spec.find('#');
    if (hash != std::string::npos) {
        tag = spec.substr(hash + 1);
        spec = spec.substr(0, hash);
        if (starts_with(tag, "tag=")) tag = tag.substr(4);
    }

    std::string scheme;
    const std::size_t scheme_end = spec.find("://");
    if (scheme_end != std::string::npos) {
        scheme = lower(spec.substr(0, scheme_end));
        spec = spec.substr(scheme_end + 3);
    }

    // bare kind names: "direct", "tor", "socks5" (port filled from defaults)
    if (scheme.empty() && spec.find(':') == std::string::npos) {
        if (const std::optional<UpstreamKind> bare = parse_kind(spec); bare.has_value()) {
            Upstream named;
            named.kind = *bare;
            named.host = lower(spec);
            named.port = named.kind == UpstreamKind::Tor ? 9050 : 0;
            named.tag = tag;
            named.id = std::string(kind_name(named.kind)) + "-" + to_hex(fnv1a(named.display()));
            return named;
        }
        return std::nullopt;
    }

    std::string credentials;
    const std::size_t at = spec.rfind('@');
    if (at != std::string::npos) {
        credentials = spec.substr(0, at);
        spec = spec.substr(at + 1);
    }

    std::string host;
    std::string port;
    if (!spec.empty() && spec.front() == '[') {  // IPv6 literal
        const std::size_t close = spec.find(']');
        if (close == std::string::npos) return std::nullopt;
        host = spec.substr(1, close - 1);
        if (close + 1 < spec.size() && spec[close + 1] == ':') {
            port = spec.substr(close + 2);
        }
    } else {
        const std::size_t colon = spec.rfind(':');
        if (colon == std::string::npos) return std::nullopt;
        host = spec.substr(0, colon);
        port = spec.substr(colon + 1);
    }

    const std::uint64_t parsed_port = parse_number(port, 0);
    if (parsed_port == 0 || parsed_port > 65535) return std::nullopt;
    if (host.empty()) return std::nullopt;

    upstream.host = host;
    upstream.port = static_cast<std::uint16_t>(parsed_port);
    upstream.tag = tag;

    if (!credentials.empty()) {
        const std::size_t split = credentials.find(':');
        if (split == std::string::npos) {
            upstream.username = credentials;
        } else {
            upstream.username = credentials.substr(0, split);
            upstream.password = credentials.substr(split + 1);
        }
    }

    // A bare "host:port" has no scheme to go on: treat it as a plain HTTP proxy,
    // which is what the pool config has always meant by it. An explicit scheme
    // we do not understand is still an error.
    std::optional<UpstreamKind> kind;
    if (!scheme.empty()) {
        kind = parse_kind(scheme);
    } else if (!trim(kind_hint).empty()) {
        kind = parse_kind(kind_hint);
    }
    if (!scheme.empty() || !trim(kind_hint).empty()) {
        if (!kind) return std::nullopt;
    }
    upstream.kind = kind.value_or(UpstreamKind::Http);

    upstream.id = std::string(kind_name(upstream.kind)) + "-" + to_hex(fnv1a(upstream.display()));
    return upstream;
}

void Pool::prune_orphans() {
    std::unordered_set<std::string> referenced;
    for (const Tier& tier : tiers_) {
        referenced.insert(tier.upstream_ids.begin(), tier.upstream_ids.end());
    }
    upstreams_.erase(std::remove_if(upstreams_.begin(), upstreams_.end(),
                                    [&](const Upstream& upstream) {
                                        return !referenced.contains(upstream.id);
                                    }),
                     upstreams_.end());
}

std::string Pool::add_tier(std::string name, Strategy strategy, std::vector<Upstream> upstreams) {
    if (name.empty()) name = "tier-" + std::to_string(tiers_.size() + 1);
    if (const auto existing = tier_index_.find(name); existing != tier_index_.end()) {
        Tier& tier = tiers_[existing->second];
        tier.strategy = strategy;
        tier.upstream_ids.clear();
        cursors_[existing->second] = 0;

        for (Upstream& upstream : upstreams) {
            tier.upstream_ids.push_back(upstream.id);
            upstreams_.push_back(std::move(upstream));
        }
        prune_orphans();
        return name;
    }

    Tier tier;
    tier.name = name;
    tier.strategy = strategy;
    for (Upstream& upstream : upstreams) {
        tier.upstream_ids.push_back(upstream.id);
        upstreams_.push_back(std::move(upstream));
    }
    tiers_.push_back(std::move(tier));
    tier_index_[name] = tiers_.size() - 1;
    cursors_.push_back(0);
    return name;
}

bool Pool::remove_tier(std::string_view name) {
    const auto it = tier_index_.find(std::string(name));
    if (it == tier_index_.end()) return false;
    const std::size_t index = it->second;
    const std::vector<std::string> ids = tiers_[index].upstream_ids;

    std::vector<Upstream> kept;
    for (const Upstream& upstream : upstreams_) {
        if (std::find(ids.begin(), ids.end(), upstream.id) == ids.end()) {
            kept.push_back(upstream);
        }
    }
    upstreams_ = std::move(kept);

    tiers_.erase(tiers_.begin() + static_cast<std::ptrdiff_t>(index));
    cursors_.erase(cursors_.begin() + static_cast<std::ptrdiff_t>(index));
    tier_index_.clear();
    for (std::size_t i = 0; i < tiers_.size(); ++i) tier_index_[tiers_[i].name] = i;
    return true;
}

bool Pool::set_strategy(std::string_view name, Strategy strategy) {
    const auto it = tier_index_.find(std::string(name));
    if (it == tier_index_.end()) return false;
    tiers_[it->second].strategy = strategy;
    return true;
}

bool Pool::set_slots(std::string_view name, std::size_t slots) {
    const auto it = tier_index_.find(std::string(name));
    if (it == tier_index_.end() || tiers_[it->second].upstream_ids.empty()) return false;
    if (slots == 0) return false;
    if (slots < tiers_[it->second].upstream_ids.size()) {
        tiers_[it->second].upstream_ids.resize(slots);
        prune_orphans();
    } else {
        tiers_[it->second].upstream_ids.resize(slots);
    }
    return true;
}

std::optional<std::size_t> Pool::tier_index(std::string_view name) const {
    const auto it = tier_index_.find(std::string(name));
    if (it == tier_index_.end()) return std::nullopt;
    return it->second;
}

std::size_t Pool::tier_size(std::string_view name) const {
    const auto it = tier_index_.find(std::string(name));
    if (it == tier_index_.end()) return 0;
    return tiers_[it->second].upstream_ids.size();
}

std::vector<std::string> Pool::tier_names() const {
    std::vector<std::string> names;
    names.reserve(tiers_.size());
    for (const Tier& tier : tiers_) names.push_back(tier.name);
    return names;
}

const Upstream* Pool::find(std::string_view id) const {
    for (const Upstream& upstream : upstreams_) {
        if (upstream.id == id) return &upstream;
    }
    return nullptr;
}

Upstream* Pool::find_mutable(std::string_view id) {
    for (Upstream& upstream : upstreams_) {
        if (upstream.id == id) return &upstream;
    }
    return nullptr;
}

Selection Pool::select(std::string_view sticky_key) const {
    requests_.fetch_add(1, std::memory_order_relaxed);

    for (std::size_t tier = 0; tier < tiers_.size(); ++tier) {
        const Tier& config = tiers_[tier];
        if (config.upstream_ids.empty()) continue;

        std::vector<const Upstream*> candidates;
        for (const std::string& id : config.upstream_ids) {
            if (const Upstream* upstream = find(id); upstream && upstream->usable()) {
                candidates.push_back(upstream);
            }
        }
        if (candidates.empty()) continue;

        std::size_t pick = 0;
        switch (config.strategy) {
            case Strategy::RoundRobin: {
                pick = cursors_[tier] % candidates.size();
                cursors_[tier] = (cursors_[tier] + 1) % candidates.size();
                break;
            }
            case Strategy::Sticky: {
                const std::uint64_t hash = fnv1a(sticky_key.empty() ? config.name : sticky_key);
                pick = static_cast<std::size_t>(hash % candidates.size());
                break;
            }
            case Strategy::Random: {
                std::random_device device;
                pick = static_cast<std::size_t>(device() % candidates.size());
                break;
            }
            case Strategy::LeastUsed: {
                pick = 0;
                for (std::size_t i = 1; i < candidates.size(); ++i) {
                    if (candidates[i]->requests < candidates[pick]->requests) pick = i;
                }
                break;
            }
            case Strategy::Failover: {
                pick = 0;
                for (std::size_t i = 1; i < candidates.size(); ++i) {
                    if (health_rank(candidates[i]->health) < health_rank(candidates[pick]->health)) {
                        pick = i;
                    }
                }
                break;
            }
        }
        return {candidates[pick], tier, std::string(strategy_name(config.strategy))};
    }
    return {};
}

void Pool::note_success(std::string_view id, std::uint64_t bytes, double now) {
    if (Upstream* upstream = find_mutable(id)) {
        ++upstream->requests;
        upstream->bytes_out += bytes;
        upstream->health = Health::Healthy;
        upstream->last_checked = now;
        upstream->last_error.clear();
    }
}

void Pool::note_failure(std::string_view id, std::string_view error, double now) {
    failures_.fetch_add(1, std::memory_order_relaxed);
    if (Upstream* upstream = find_mutable(id)) {
        ++upstream->failures;
        upstream->health = Health::Unhealthy;
        upstream->last_checked = now;
        upstream->last_error = std::string(error).substr(0, 200);
    }
}

void Pool::quarantine(std::string_view id, double until) {
    if (Upstream* upstream = find_mutable(id)) {
        upstream->health = Health::Quarantined;
        upstream->last_checked = until;
        upstream->last_error = "quarantined";
    }
}

std::size_t Pool::healthy_count() const {
    std::size_t count = 0;
    for (const Upstream& upstream : upstreams_) {
        if (upstream.health == Health::Healthy) ++count;
    }
    return count;
}

std::string Pool::to_json() const {
    JsonWriter json;
    json.begin_object();
    json.field("upstreams", static_cast<std::int64_t>(upstreams_.size()));
    json.field("tiers", static_cast<std::int64_t>(tiers_.size()));
    json.field("healthy", static_cast<std::int64_t>(healthy_count()));
    json.field("requests", static_cast<std::int64_t>(requests()));
    json.field("failures", static_cast<std::int64_t>(failures()));

    json.key("tier_list").begin_array();
    for (const Tier& tier : tiers_) {
        json.begin_object();
        json.field("name", tier.name);
        json.field("strategy", std::string(strategy_name(tier.strategy)));
        json.field("size", static_cast<std::int64_t>(tier.upstream_ids.size()));
        json.end_object();
    }
    json.end_array();

    json.key("upstream_list").begin_array();
    for (const Upstream& upstream : upstreams_) json.raw(upstream.to_json());
    json.end_array();
    json.end_object();
    return json.str();
}

}  // namespace netops::proxy
