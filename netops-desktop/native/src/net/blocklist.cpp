#include "netops/net/blocklist.hpp"

#include "netops/net/url.hpp"
#include "netops/util.hpp"

namespace netops::net {

const std::vector<std::string>& Blocklist::builtin_patterns() {
    static const std::vector<std::string> patterns = {
        "doubleclick.net",
        "googlesyndication.com/pagead",
        "google-analytics.com",
        "googleadservices.com",
        "googletagmanager.com/gtm.js",
        "analytics.tiktok.com",
        "connect.facebook.net",
        "facebook.com/tr",
        "bat.bing.com",
        "analytics.yahoo.com",
        "scorecardresearch.com",
        "quantserve.com",
        "hotjar.com",
        "fullstory.com",
        "mixpanel.com",
        "segment.io",
        "segment.com/api",
        "amplitude.com",
        "branch.io",
        "crazyegg.com",
        "optimizely.com",
        "sentry.io/api",
        "newrelic.com",
        "nr-data.net",
        "clarity.ms",
        "yandex.ru/metrika",
        "mc.yandex.ru",
        "adservice.google",
        "ads-twitter.com",
        "adnxs.com",
        "rubiconproject.com",
        "pubmatic.com",
        "openx.net",
        "criteo.com",
        "taboola.com",
        "outbrain.com",
        "snapchat.com/tr",
        "tiktok.com/api",
        "hotjar.io",
        "fingerprintjs.com",
        "bugsnag.com",
        "intercom.io",
        "driftt.com",
        "zendesk.com/embed",
        "onetrust.com",
        "cookiebot.com",
        "cookielaw.org",
        "usercentrics.eu",
        "cloudflareinsights.com",
        "speedcurve.com",
        "loggly.com",
        "datadoghq.com",
        "statuspage.io",
        "mapbox.com",
        "googleapis.com/recaptcha",
        "hcaptcha.com",
    };
    return patterns;
}

bool Blocklist::parse_ipv4(std::string_view text, std::array<std::uint32_t, 4>& out) {
    std::size_t index = 0;
    for (std::size_t part = 0; part < 4; ++part) {
        if (part > 0) {
            if (index >= text.size() || text[index] != '.') return false;
            ++index;
        }
        std::uint32_t value = 0;
        std::size_t digits = 0;
        while (index < text.size() && std::isdigit(static_cast<unsigned char>(text[index]))) {
            value = value * 10 + static_cast<std::uint32_t>(text[index] - '0');
            if (value > 255) return false;
            ++index;
            ++digits;
        }
        if (digits == 0) return false;
        out[part] = value;
    }
    return index == text.size();
}

bool Blocklist::looks_like_cidr(std::string_view pattern) {
    const std::size_t slash = pattern.find('/');
    if (slash == std::string_view::npos) return false;
    std::array<std::uint32_t, 4> ignored{};
    if (!parse_ipv4(pattern.substr(0, slash), ignored)) return false;
    const std::string length = std::string(pattern.substr(slash + 1));
    if (length.empty() || length.size() > 2) return false;
    for (const char c : length) {
        if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    }
    const int bits = std::stoi(length);
    return bits >= 0 && bits <= 32;
}

bool Blocklist::cidr_contains(std::string_view pattern, std::string_view address) {
    const std::size_t slash = pattern.find('/');
    if (slash == std::string_view::npos) return false;

    std::array<std::uint32_t, 4> network{};
    std::array<std::uint32_t, 4> candidate{};
    if (!parse_ipv4(pattern.substr(0, slash), network)) return false;
    if (!parse_ipv4(address, candidate)) return false;

    const int bits = std::stoi(std::string(pattern.substr(slash + 1)));
    std::uint32_t mask = bits == 0 ? 0u : (0xffffffffu << (32 - bits));
    std::uint32_t network_value = (network[0] << 24) | (network[1] << 16) | (network[2] << 8) | network[3];
    std::uint32_t candidate_value =
        (candidate[0] << 24) | (candidate[1] << 16) | (candidate[2] << 8) | candidate[3];
    return (network_value & mask) == (candidate_value & mask);
}

void Blocklist::clear() {
    rules_.clear();
    regexes_.clear();
    host_index_.clear();
    host_rules_.clear();
}

void Blocklist::add_builtin(std::string_view pattern) {
    add_rule(pattern, "builtin");
}

void Blocklist::add_rule(std::string_view pattern, std::string_view source) {
    const std::string value = lower(trim(pattern));
    if (value.empty()) return;

    BlockRule rule;
    rule.source = std::string(source);
    if (starts_with(value, "re:")) {
        rule.kind = RuleKind::Regex;
        rule.pattern = value.substr(3);
    } else if (looks_like_cidr(value)) {
        rule.kind = RuleKind::Cidr;
        rule.pattern = value;
    } else if (value.front() == '.') {
        rule.kind = RuleKind::HostSuffix;
        rule.pattern = value.substr(1);
    } else if (value.find('/') != std::string::npos) {
        rule.kind = RuleKind::Path;
        rule.pattern = value;
    } else {
        rule.kind = RuleKind::Host;
        rule.pattern = value;
    }

    if (rule.kind == RuleKind::Host || rule.kind == RuleKind::HostSuffix) {
        // host matching is the hot path: index it
        if (host_index_.find(rule.pattern) == host_index_.end()) {
            host_index_[rule.pattern] = host_rules_.size();
            BlockRule indexed = rule;
            host_rules_.push_back(indexed);
        }
    }
    rules_.push_back(std::move(rule));
    compile_regexes();
}

void Blocklist::compile_regexes() {
    regexes_.assign(rules_.size(), nullptr);
    for (std::size_t i = 0; i < rules_.size(); ++i) {
        if (rules_[i].kind != RuleKind::Regex) continue;
        try {
            regexes_[i] = std::make_shared<const std::regex>(rules_[i].pattern,
                                                             std::regex::ECMAScript | std::regex::icase);
        } catch (const std::regex_error&) {
            // An operator typo must not take the whole browser down: keep the
            // rule visible in the JSON dump, but never match on it.
            regexes_[i].reset();
        }
    }
}

BlockVerdict Blocklist::check_host(std::string_view host) const {
    const std::string value = lower(host);
    if (value.empty()) return {};

    for (const BlockRule& rule : host_rules_) {
        if (rule.kind == RuleKind::Host) {
            // exact host or any subdomain, but never "notdoubleclick.net"
            if (value == rule.pattern || ends_with(value, "." + rule.pattern)) {
                return {true, rule.pattern, rule.source};
            }
        } else if (rule.kind == RuleKind::HostSuffix) {
            if (ends_with(value, "." + rule.pattern)) {
                return {true, rule.pattern, rule.source};
            }
        }
    }

    for (std::size_t i = 0; i < rules_.size(); ++i) {
        if (rules_[i].kind != RuleKind::Regex || !regexes_[i]) continue;
        if (std::regex_search(value, *regexes_[i])) {
            return {true, rules_[i].pattern, rules_[i].source};
        }
    }
    return {};
}

BlockVerdict Blocklist::check(std::string_view url) const {
    const std::string value = lower(url);
    if (value.empty()) return {};

    UrlPolicy policy;
    policy.allow_data_html = true;
    UrlError error;
    const std::optional<NormalisedUrl> parsed = normalise_url(value, policy, &error);
    if (parsed) {
        const BlockVerdict host_verdict = check_host(parsed->host);
        if (host_verdict.blocked) return host_verdict;
    }

    for (std::size_t i = 0; i < rules_.size(); ++i) {
        const BlockRule& rule = rules_[i];
        // Path rules are matched against the whole URL so that they cover both
        // "host/path" built-ins and bare path fragments. Host rules are handled
        // by check_host() above: substring matching them here produced false
        // positives such as "notdoubleclick.net".
        if (rule.kind == RuleKind::Path && contains(value, rule.pattern)) {
            return {true, rule.pattern, rule.source};
        }
        if (rule.kind == RuleKind::Cidr) {
            // Block beacons that carry an address anywhere in the URL
            // (query strings, referrers and beacon paths all end up here).
            std::string::size_type cursor = 0;
            while ((cursor = value.find_first_of("0123456789", cursor)) != std::string::npos) {
                std::string::size_type end = cursor;
                while (end < value.size() &&
                       (std::isdigit(static_cast<unsigned char>(value[end])) || value[end] == '.')) {
                    ++end;
                }
                if (cidr_contains(rule.pattern, std::string_view(value).substr(cursor, end - cursor))) {
                    return {true, rule.pattern, rule.source};
                }
                cursor = end;
            }
        }
        if (rule.kind == RuleKind::Regex && regexes_[i] && std::regex_search(value, *regexes_[i])) {
            return {true, rule.pattern, rule.source};
        }
    }
    return {};
}

std::string Blocklist::to_json() const {
    JsonWriter json;
    json.begin_array();
    for (const BlockRule& rule : rules_) {
        json.begin_object();
        json.field("pattern", rule.pattern);
        json.field("source", rule.source);
        const char* kind = "host";
        switch (rule.kind) {
            case RuleKind::Host: kind = "host"; break;
            case RuleKind::HostSuffix: kind = "host_suffix"; break;
            case RuleKind::Path: kind = "path"; break;
            case RuleKind::Regex: kind = "regex"; break;
            case RuleKind::Cidr: kind = "cidr"; break;
        }
        json.field("kind", kind);
        json.end_object();
    }
    json.end_array();
    return json.str();
}

}  // namespace netops::net
