// URL admission control for the built-in browser.
//
// This is the single place that decides what the browser is allowed to load.
// The panel front end, the tab manager and the native proxy all ask it first.
#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace netops::net {

struct UrlPolicy {
    bool https_only = true;
    std::size_t max_url_length = 2048;
    std::size_t max_data_url_length = 8192;
    bool allow_data_html = true;
};

struct NormalisedUrl {
    std::string url;
    std::string scheme;
    std::string host;
    int port = 0;
    std::string path;
    bool secure = false;  // https, or an engine-internal page
};

struct UrlError {
    std::string message;
};

// Normalises user input into something safe to navigate to.
// Returns the parsed URL, or an error explaining the refusal.
std::optional<NormalisedUrl> normalise_url(std::string_view raw, const UrlPolicy& policy,
                                           UrlError* error = nullptr);

// Hostname validation: labels, length, and the private ranges that must be
// refused unless the operator opted in.
struct HostPolicy {
    bool allow_private = false;
    bool allow_localhost = false;
};

std::optional<std::string> validate_hostname(std::string_view host, const HostPolicy& policy,
                                             UrlError* error = nullptr);

bool is_private_ipv4(std::string_view host);
bool is_loopback(std::string_view host);

// Convenience: what does the URL checker say about this string?
bool should_block(std::string_view url, const UrlPolicy& policy);

}  // namespace netops::net
