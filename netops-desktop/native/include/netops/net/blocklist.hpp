// Request blocking: a compiled matcher for trackers, ad hosts and extra rules.
//
// Patterns are supplied by the operator (netops.toml [browser] blocklist plus
// the built-in list). A bare host matches the host and its subdomains; a
// pattern containing '/' also has to match the path.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <regex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace netops::net {

enum class RuleKind {
    Host,       // doubleclick.net
    HostSuffix, // .doubleclick.net
    Path,       // googletagmanager.com/gtm.js
    Regex,      // re:.*\badserver\b.*
    Cidr,       // 192.0.2.0/24
};

struct BlockRule {
    RuleKind kind = RuleKind::Host;
    std::string pattern;  // lowercased
    std::string source;   // "builtin" or "operator"
};

struct BlockVerdict {
    bool blocked = false;
    std::string pattern;  // which rule matched
    std::string source;
};

class Blocklist {
public:
    void add_builtin(std::string_view pattern);
    void add_rule(std::string_view pattern, std::string_view source = "operator");
    void clear();
    bool empty() const { return rules_.empty(); }

    BlockVerdict check(std::string_view url) const;
    BlockVerdict check_host(std::string_view host) const;

    std::size_t size() const { return rules_.size(); }
    const std::vector<BlockRule>& rules() const { return rules_; }
    std::string to_json() const;

    // The built-in list, kept in one place so the tests can assert its size.
    static const std::vector<std::string>& builtin_patterns();

private:
    // Regexes are compiled once when the rule is added: matching runs on every
    // request, and re-compiling a std::regex per call is expensive.
    void compile_regexes();
    static bool cidr_contains(std::string_view pattern, std::string_view address);
    static bool parse_ipv4(std::string_view text, std::array<std::uint32_t, 4>& out);
    static bool looks_like_cidr(std::string_view pattern);

    std::vector<BlockRule> rules_;
    std::vector<std::shared_ptr<const std::regex>> regexes_;  // parallel to rules_
    std::unordered_map<std::string, std::size_t> host_index_;  // host -> rule index
    std::vector<BlockRule> host_rules_;
};

}  // namespace netops::net
