#include "netops/net/url.hpp"

#include <cctype>
#include <vector>

#include "netops/util.hpp"

namespace netops::net {
namespace {

bool is_scheme_char(char c) {
    return std::isalnum(static_cast<unsigned char>(c)) || c == '+' || c == '.' || c == '-';
}

// scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
std::optional<std::string> scheme_of(std::string_view url) {
    const std::size_t colon = url.find(':');
    if (colon == std::string_view::npos || colon == 0) return std::nullopt;
    for (std::size_t i = 0; i < colon; ++i) {
        if (!is_scheme_char(url[i])) return std::nullopt;
    }
    if (!std::isalpha(static_cast<unsigned char>(url[0]))) return std::nullopt;

    // "example.com:8080" is a host and a port, not a scheme, even though dots
    // are legal scheme characters. Only accept a scheme when the URL is either
    // "scheme://..." or an opaque scheme that is not followed by digits.
    const std::string_view tail = url.substr(colon + 1);
    const bool hierarchical = starts_with(tail, "//");
    const bool opaque = !tail.empty() && !std::isdigit(static_cast<unsigned char>(tail.front()));
    if (!hierarchical && !opaque) return std::nullopt;

    return lower(url.substr(0, colon));
}

bool has_illegal_characters(std::string_view url) {
    for (const char c : url) {
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '<' || c == '>' ||
            c == '"' || c == '\'' || c == '`') {
            return true;
        }
    }
    return false;
}

std::optional<int> parse_port(std::string_view text) {
    if (text.empty()) return std::nullopt;
    int value = 0;
    for (const char c : text) {
        if (!std::isdigit(static_cast<unsigned char>(c))) return std::nullopt;
        value = value * 10 + (c - '0');
        if (value > 65535) return std::nullopt;
    }
    return value;
}

bool is_ipv4_literal(std::string_view host) {
    int dots = 0;
    for (const char c : host) {
        if (c == '.') ++dots;
        else if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    }
    return dots == 3;
}

// Pull "host[:port]" or "[v6][:port]" out of an authority string.
bool split_authority(std::string_view authority, std::string& host, int& port,
                     std::string& error) {
    host.clear();
    port = 0;
    if (authority.empty()) {
        error = "URL has no host";
        return false;
    }

    if (authority.front() == '[') {  // IPv6 literal
        const std::size_t close = authority.find(']');
        if (close == std::string_view::npos) {
            error = "malformed IPv6 host";
            return false;
        }
        host = std::string(authority.substr(0, close + 1));
        if (close + 1 < authority.size()) {
            if (authority[close + 1] != ':') {
                error = "malformed IPv6 host";
                return false;
            }
            const std::optional<int> parsed = parse_port(authority.substr(close + 2));
            if (!parsed) {
                error = "invalid port";
                return false;
            }
            port = *parsed;
        }
        return true;
    }

    const std::size_t colon = authority.rfind(':');
    if (colon != std::string_view::npos) {
        const std::optional<int> parsed = parse_port(authority.substr(colon + 1));
        if (!parsed) {
            error = "invalid port";
            return false;
        }
        port = *parsed;
        host = std::string(authority.substr(0, colon));
    } else {
        host = std::string(authority);
    }
    return true;
}

}  // namespace

bool is_loopback(std::string_view host) {
    const std::string value = lower(host);
    return value == "localhost" || starts_with(value, "127.") || value == "::1";
}

bool is_private_ipv4(std::string_view host) {
    if (!is_ipv4_literal(host)) return false;
    unsigned a = 0;
    unsigned b = 0;
    int octets = 0;
    std::size_t index = 0;
    unsigned value = 0;
    unsigned* target = &a;
    while (index <= host.size()) {
        if (index == host.size() || host[index] == '.') {
            if (value > 255) return false;
            if (octets == 1) b = value;
            if (octets == 0) a = value;
            ++octets;
            value = 0;
            target = nullptr;
            (void)target;
        } else {
            value = value * 10 + static_cast<unsigned>(host[index] - '0');
            if (value > 255) return false;
        }
        ++index;
    }
    if (octets != 4) return false;
    if (a == 10) return true;
    if (a == 127) return true;
    if (a == 0) return true;
    if (a == 169 && b == 254) return true;
    if (a == 172 && b >= 16 && b <= 31) return true;
    if (a == 192 && b == 168) return true;
    if (a == 100 && b >= 64 && b <= 127) return true;
    return false;
}

std::optional<NormalisedUrl> normalise_url(std::string_view raw, const UrlPolicy& policy,
                                           UrlError* error) {
    const auto fail = [&](std::string message) -> std::optional<NormalisedUrl> {
        if (error) *error = UrlError{std::move(message)};
        return std::nullopt;
    };

    const std::string input = trim(raw);
    if (input.empty()) return fail("URL is required");
    if (input.size() > policy.max_url_length) {
        return fail("URL is longer than " + std::to_string(policy.max_url_length) + " characters");
    }

    const std::optional<std::string> maybe_scheme = scheme_of(input);
    const std::string scheme = maybe_scheme.value_or("https");

    if (scheme == "data") {
        if (!policy.allow_data_html) return fail("data: URLs are disabled");
        const std::string lowered = lower(input);
        if (!starts_with(lowered, "data:text/html,") && !starts_with(lowered, "data:text/plain,")) {
            return fail("only data:text/html and data:text/plain are allowed");
        }
        if (input.size() > policy.max_data_url_length) {
            return fail("data URL is longer than " +
                        std::to_string(policy.max_data_url_length) + " characters");
        }
        NormalisedUrl out;
        out.url = input;
        out.scheme = scheme;
        out.secure = false;
        return out;
    }

    if (scheme == "about") {
        if (lower(input) != "about:blank") return fail("only about:blank is allowed");
        NormalisedUrl out;
        out.url = "about:blank";
        out.scheme = scheme;
        out.secure = true;
        return out;
    }

    if (scheme != "http" && scheme != "https") {
        return fail("scheme '" + scheme + "' is not allowed");
    }

    std::string url = input;
    if (!maybe_scheme) {
        // No scheme was typed, so the default depends on the host: a bare
        // "localhost:8787" is the local control plane and only speaks http,
        // while a bare public name gets https-first.
        std::string host;
        int port = 0;
        std::string parse_error;
        const std::size_t cut = input.find_first_of("/?#");
        const std::string_view authority = std::string_view(input).substr(0, cut);
        const bool loopback = split_authority(authority, host, port, parse_error) &&
                              is_loopback(lower(host));
        url = (loopback ? "http://" : "https://") + url;
    }
    if (has_illegal_characters(url)) return fail("URL contains illegal characters");

    // Everything after "://" is the authority, then the path/query/fragment.
    const std::size_t scheme_separator = url.find("://");
    if (scheme_separator == std::string::npos) return fail("URL has no host");
    const std::string_view after_scheme(url.data() + scheme_separator + 3,
                                        url.size() - scheme_separator - 3);
    const std::size_t authority_end = [&]() -> std::size_t {
        const std::size_t slash = after_scheme.find('/');
        const std::size_t query = after_scheme.find('?');
        const std::size_t hash = after_scheme.find('#');
        std::size_t best = std::string_view::npos;
        for (const std::size_t pos : {slash, query, hash}) {
            if (pos != std::string_view::npos && pos < best) best = pos;
        }
        return best == std::string_view::npos ? after_scheme.size() : best;
    }();

    std::string_view authority = after_scheme.substr(0, authority_end);
    std::string_view rest = after_scheme.substr(authority_end);
    if (authority.empty()) return fail("URL has no host");

    // userinfo is a phishing trick in the authority bar: refuse it outright
    if (authority.find('@') != std::string_view::npos) {
        return fail("URLs with embedded credentials are not allowed");
    }

    std::string host;
    int port = 0;
    {
        std::string parse_error;
        if (!split_authority(authority, host, port, parse_error)) return fail(parse_error);
    }

    const std::string lowered_host = lower(host);
    if (lowered_host.empty()) return fail("URL has no host");
    if (lowered_host.find(' ') != std::string::npos) return fail("invalid host");

    // Upgrade http -> https, now that the host is known. Loopback is exempt: the
    // desktop shell serves its own control plane over plain http on 127.0.0.1,
    // and no public CA will ever sign that name.
    if (scheme == "http" && policy.https_only && !is_loopback(lowered_host)) {
        url = "https://" + url.substr(std::string_view("http://").size());
    }

    NormalisedUrl out;
    out.url = url;
    // Report the scheme actually being fetched: an http:// URL was just
    // upgraded to https, so out.scheme must follow the rewrite.
    out.scheme = lower(url.substr(0, url.find("://")));
    out.host = lowered_host;
    out.port = port;
    out.path = std::string(rest.empty() ? "/" : rest);
    out.secure = (scheme == "https");
    return out;
}

std::optional<std::string> validate_hostname(std::string_view host, const HostPolicy& policy,
                                             UrlError* error) {
    const auto fail = [&](std::string message) -> std::optional<std::string> {
        if (error) *error = UrlError{std::move(message)};
        return std::nullopt;
    };

    const std::string value = lower(host);
    if (value.empty()) return fail("host is required");
    if (value.size() > 253) return fail("host is longer than 253 characters");
    if (value.front() == '.' || value.back() == '.') return fail("host has an empty label");

    if (value.front() == '[') return value;  // IPv6 literals are opt-in targets

    if (is_ipv4_literal(value)) {
        if (!policy.allow_private && (is_private_ipv4(value) || is_loopback(value))) {
            return fail("private and loopback addresses are blocked by policy");
        }
        return value;
    }

    for (const std::string& label : split(value, '.')) {
        if (label.empty()) return fail("host has an empty label");
        if (label.size() > 63) return fail("host label is longer than 63 characters");
        if (label.front() == '-' || label.back() == '-') {
            return fail("host label may not start or end with a hyphen");
        }
        for (const char c : label) {
            const bool ok = std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_';
            if (!ok) return fail("host label contains an invalid character");
        }
    }

    if (is_loopback(value) && !policy.allow_localhost && !policy.allow_private) {
        return fail("localhost is blocked by policy");
    }
    if (!policy.allow_private && ends_with(value, ".local")) {
        return fail("mDNS names are blocked by policy");
    }
    if (!policy.allow_private && (ends_with(value, ".internal") || ends_with(value, ".lan"))) {
        return fail("internal hostnames are blocked by policy");
    }
    return value;
}

bool should_block(std::string_view url, const UrlPolicy& policy) {
    UrlError error;
    return !normalise_url(url, policy, &error).has_value();
}

}  // namespace netops::net
