// Node bindings for the native engine.
//
// The Electron main process owns the browser, so this is the boundary it talks
// to: URL admission, request blocking, cookie and cache accounting, theme
// compilation and the rotating proxy pool.
#include <napi.h>

#include <memory>
#include <string>
#include <vector>

#include "netops/browser/cache_index.hpp"
#include "netops/browser/cookies.hpp"
#include "netops/browser/theme.hpp"
#include "netops/net/blocklist.hpp"
#include "netops/net/url.hpp"
#include "netops/proxy/pool.hpp"
#include "netops/util.hpp"

namespace {

using netops::net::Blocklist;
using netops::net::HostPolicy;
using netops::net::UrlPolicy;
using netops::browser::Cookie;
using netops::browser::CookieJar;
using netops::browser::Theme;
using netops::browser::ThemeMode;
using netops::proxy::Pool;
using netops::proxy::Upstream;

std::string string_or(const Napi::Object& object, const char* key, const std::string& fallback = {}) {
    if (!object.Has(key)) return fallback;
    Napi::Value value = object.Get(key);
    if (!value.IsString()) return fallback;
    return value.As<Napi::String>().Utf8Value();
}

bool bool_or(const Napi::Object& object, const char* key, bool fallback) {
    if (!object.Has(key)) return fallback;
    Napi::Value value = object.Get(key);
    return value.IsBoolean() ? static_cast<bool>(value.As<Napi::Boolean>()) : fallback;
}

double double_or(const Napi::Object& object, const char* key, double fallback) {
    if (!object.Has(key)) return fallback;
    Napi::Value value = object.Get(key);
    return value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : fallback;
}

int64_t int_or(const Napi::Object& object, const char* key, int64_t fallback) {
    if (!object.Has(key)) return fallback;
    Napi::Value value = object.Get(key);
    return value.IsNumber() ? value.As<Napi::Number>().Int64Value() : fallback;
}

// ---------------------------------------------------------------------- url
Napi::Value NormaliseUrl(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        throw Napi::TypeError::New(env, "normaliseUrl(url, options?)");
    }
    const std::string raw = info[0].As<Napi::String>().Utf8Value();

    UrlPolicy policy;
    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object options = info[1].As<Napi::Object>();
        policy.https_only = bool_or(options, "httpsOnly", policy.https_only);
        policy.allow_data_html = bool_or(options, "allowDataHtml", policy.allow_data_html);
        policy.max_url_length = static_cast<std::size_t>(
            int_or(options, "maxUrlLength", static_cast<int64_t>(policy.max_url_length)));
        policy.max_data_url_length = static_cast<std::size_t>(
            int_or(options, "maxDataUrlLength", static_cast<int64_t>(policy.max_data_url_length)));
    }

    netops::net::UrlError error;
    const auto parsed = netops::net::normalise_url(raw, policy, &error);
    if (!parsed) {
        Napi::Object result = Napi::Object::New(env);
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("error", Napi::String::New(env, error.message));
        return result;
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, true));
    result.Set("url", Napi::String::New(env, parsed->url));
    result.Set("scheme", Napi::String::New(env, parsed->scheme));
    result.Set("host", Napi::String::New(env, parsed->host));
    result.Set("port", Napi::Number::New(env, parsed->port));
    result.Set("path", Napi::String::New(env, parsed->path));
    result.Set("secure", Napi::Boolean::New(env, parsed->secure));
    return result;
}

Napi::Value ValidateHost(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        throw Napi::TypeError::New(env, "validateHost(host, options?)");
    }
    const std::string host = info[0].As<Napi::String>().Utf8Value();

    HostPolicy policy;
    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object options = info[1].As<Napi::Object>();
        policy.allow_private = bool_or(options, "allowPrivate", false);
        policy.allow_localhost = bool_or(options, "allowLocalhost", false);
    }

    netops::net::UrlError error;
    const auto validated = netops::net::validate_hostname(host, policy, &error);
    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, validated.has_value()));
    if (validated) {
        result.Set("host", Napi::String::New(env, *validated));
    } else {
        result.Set("error", Napi::String::New(env, error.message));
    }
    return result;
}

// ----------------------------------------------------------------- blocklist
class BlocklistWrapper : public Napi::ObjectWrap<BlocklistWrapper> {
public:
    // node-addon-api constructs wrappers through this constructor.
    explicit BlocklistWrapper(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<BlocklistWrapper>(info) {
        if (info.Length() > 0 && info[0].IsObject()) {
            const Napi::Object options = info[0].As<Napi::Object>();
            if (options.Has("includeBuiltin") &&
                options.Get("includeBuiltin").As<Napi::Boolean>().Value()) {
                for (const std::string& pattern : Blocklist::builtin_patterns()) {
                    list_.add_builtin(pattern);
                }
            }
            if (options.Has("extra") && options.Get("extra").IsArray()) {
                const Napi::Array extra = options.Get("extra").As<Napi::Array>();
                for (uint32_t i = 0; i < extra.Length(); ++i) {
                    list_.add_rule(extra.Get(i).As<Napi::String>().Utf8Value(), "operator");
                }
            }
        }
    }

    static Napi::Function Init(Napi::Env env) {
        return DefineClass(env, "Blocklist",
                           {
                                InstanceMethod("addBuiltin", &BlocklistWrapper::AddBuiltin),
                                InstanceMethod("addRule", &BlocklistWrapper::AddRule),
                                InstanceMethod("clear", &BlocklistWrapper::Clear),
                                InstanceMethod("check", &BlocklistWrapper::Check),
                                InstanceMethod("checkHost", &BlocklistWrapper::CheckHost),
                                InstanceMethod("size", &BlocklistWrapper::Size),
                                InstanceMethod("toJSON", &BlocklistWrapper::ToJson),
                            });
    }

    void AddBuiltin(const Napi::CallbackInfo& info) {
        list_.add_builtin(info[0].As<Napi::String>().Utf8Value());
    }

    void AddRule(const Napi::CallbackInfo& info) {
        const std::string pattern = info[0].As<Napi::String>().Utf8Value();
        const std::string source = info.Length() > 1 && info[1].IsString()
                                       ? info[1].As<Napi::String>().Utf8Value()
                                       : "operator";
        list_.add_rule(pattern, source);
    }

    void Clear(const Napi::CallbackInfo& info) { list_.clear(); }

    Napi::Value Check(const Napi::CallbackInfo& info) {
        const auto verdict =
            list_.check(info[0].As<Napi::String>().Utf8Value());
        Napi::Object result = Napi::Object::New(info.Env());
        result.Set("blocked", Napi::Boolean::New(info.Env(), verdict.blocked));
        result.Set("pattern", Napi::String::New(info.Env(), verdict.pattern));
        result.Set("source", Napi::String::New(info.Env(), verdict.source));
        return result;
    }

    Napi::Value CheckHost(const Napi::CallbackInfo& info) {
        const auto verdict = list_.check_host(info[0].As<Napi::String>().Utf8Value());
        Napi::Object result = Napi::Object::New(info.Env());
        result.Set("blocked", Napi::Boolean::New(info.Env(), verdict.blocked));
        result.Set("pattern", Napi::String::New(info.Env(), verdict.pattern));
        result.Set("source", Napi::String::New(info.Env(), verdict.source));
        return result;
    }

    Napi::Value Size(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), static_cast<double>(list_.size()));
    }

    Napi::Value ToJson(const Napi::CallbackInfo& info) {
        return Napi::String::New(info.Env(), list_.to_json());
    }

    Blocklist list_;
};

// ------------------------------------------------------------------- cookies
class CookieJarWrapper : public Napi::ObjectWrap<CookieJarWrapper> {
public:
    // node-addon-api constructs wrappers through this constructor.
    explicit CookieJarWrapper(const Napi::CallbackInfo& info) : Napi::ObjectWrap<CookieJarWrapper>(info) {}
    static Napi::Function Init(Napi::Env env) {
        return DefineClass(env, "CookieJar",
                           {
                               InstanceMethod("ingest", &CookieJarWrapper::Ingest),
                               InstanceMethod("clear", &CookieJarWrapper::Clear),
                               InstanceMethod("size", &CookieJarWrapper::Size),
                               InstanceMethod("report", &CookieJarWrapper::Report),
                               InstanceMethod("select", &CookieJarWrapper::Select),
                           });
    }


    void Ingest(const Napi::CallbackInfo& info) {
        std::vector<Cookie> cookies;
        const Napi::Array rows = info[0].As<Napi::Array>();
        for (uint32_t i = 0; i < rows.Length(); ++i) {
            const Napi::Object row = rows.Get(i).As<Napi::Object>();
            Cookie cookie;
            cookie.name = string_or(row, "name");
            cookie.value = string_or(row, "value");
            cookie.domain = string_or(row, "domain");
            cookie.path = string_or(row, "path", "/");
            cookie.same_site = string_or(row, "sameSite");
            cookie.expires = double_or(row, "expires", -1);
            cookie.http_only = bool_or(row, "httpOnly", false);
            cookie.secure = bool_or(row, "secure", false);
            cookies.push_back(std::move(cookie));
        }
        jar_.ingest(cookies);
    }

    void Clear(const Napi::CallbackInfo& info) { jar_.clear(); }

    Napi::Value Size(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), static_cast<double>(jar_.size()));
    }

    Napi::Value Report(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        std::string domain;
        bool include_expired = false;
        double now = static_cast<double>(time(nullptr));
        if (info.Length() > 0 && info[0].IsObject()) {
            const Napi::Object options = info[0].As<Napi::Object>();
            domain = string_or(options, "domain");
            include_expired = bool_or(options, "includeExpired", false);
            now = double_or(options, "now", now);
        }
        const auto report = jar_.report(now, domain, include_expired);

        Napi::Object result = Napi::Object::New(env);
        result.Set("count", Napi::Number::New(env, static_cast<double>(report.total)));
        result.Set("sessionCookies", Napi::Number::New(env, static_cast<double>(report.session_cookies)));
        result.Set("httpOnly", Napi::Number::New(env, static_cast<double>(report.http_only)));
        result.Set("secure", Napi::Number::New(env, static_cast<double>(report.secure)));
        result.Set("thirdParty", Napi::Number::New(env, static_cast<double>(report.third_party)));
        result.Set("expired", Napi::Number::New(env, static_cast<double>(report.expired_count)));

        Napi::Array cookies = Napi::Array::New(env, report.cookies.size());
        for (std::size_t i = 0; i < report.cookies.size(); ++i) {
            const auto& view = report.cookies[i];
            Napi::Object row = Napi::Object::New(env);
            row.Set("name", Napi::String::New(env, view.name));
            row.Set("domain", Napi::String::New(env, view.domain));
            row.Set("path", Napi::String::New(env, view.path));
            row.Set("sameSite", Napi::String::New(env, view.same_site));
            row.Set("valuePreview", Napi::String::New(env, view.value_preview));
            row.Set("size", Napi::Number::New(env, static_cast<double>(view.size)));
            row.Set("expires", Napi::Number::New(env, view.expires));
            row.Set("session", Napi::Boolean::New(env, view.session));
            row.Set("httpOnly", Napi::Boolean::New(env, view.http_only));
            row.Set("secure", Napi::Boolean::New(env, view.secure));
            row.Set("expired", Napi::Boolean::New(env, view.expired));
            cookies.Set(static_cast<uint32_t>(i), row);
        }
        result.Set("cookies", cookies);

        Napi::Array domains = Napi::Array::New(env, report.domains.size());
        for (std::size_t i = 0; i < report.domains.size(); ++i) {
            Napi::Object row = Napi::Object::New(env);
            row.Set("domain", Napi::String::New(env, report.domains[i].domain));
            row.Set("count", Napi::Number::New(env, static_cast<double>(report.domains[i].count)));
            domains.Set(static_cast<uint32_t>(i), row);
        }
        result.Set("domains", domains);
        return result;
    }

    Napi::Value Select(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        const auto matches = jar_.select(info[0].As<Napi::String>().Utf8Value());
        Napi::Array out = Napi::Array::New(env, matches.size());
        for (std::size_t i = 0; i < matches.size(); ++i) {
            Napi::Object row = Napi::Object::New(env);
            row.Set("name", Napi::String::New(env, matches[i]->name));
            row.Set("domain", Napi::String::New(env, matches[i]->domain));
            row.Set("path", Napi::String::New(env, matches[i]->path));
            out.Set(static_cast<uint32_t>(i), row);
        }
        return out;
    }

    CookieJar jar_;
};

// --------------------------------------------------------------------- cache
class CacheIndexWrapper : public Napi::ObjectWrap<CacheIndexWrapper> {
public:
    // node-addon-api constructs wrappers through this constructor.
    explicit CacheIndexWrapper(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<CacheIndexWrapper>(info),
          index_(info[0].As<Napi::String>().Utf8Value()) {}

    static Napi::Function Init(Napi::Env env) {
        return DefineClass(env, "CacheIndex",
                           {
                               InstanceMethod("scan", &CacheIndexWrapper::Scan),
                               InstanceMethod("clear", &CacheIndexWrapper::Clear),
                           });
    }

private:
    Napi::Value Scan(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        const auto report = index_.scan();
        Napi::Object result = Napi::Object::New(env);
        result.Set("profile", Napi::String::New(env, report.profile));
        result.Set("totalBytes", Napi::Number::New(env, static_cast<double>(report.total_bytes)));
        result.Set("files", Napi::Number::New(env, static_cast<double>(report.files)));
        result.Set("cacheBytes", Napi::Number::New(env, static_cast<double>(report.cache_bytes)));

        Napi::Array files = Napi::Array::New(env, report.largest_cache_files.size());
        for (std::size_t i = 0; i < report.largest_cache_files.size(); ++i) {
            Napi::Object row = Napi::Object::New(env);
            row.Set("path", Napi::String::New(env, report.largest_cache_files[i].path));
            row.Set("bytes",
                    Napi::Number::New(env, static_cast<double>(report.largest_cache_files[i].bytes)));
            files.Set(static_cast<uint32_t>(i), row);
        }
        result.Set("largestCacheFiles", files);
        return result;
    }

    Napi::Value Clear(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        const auto cleared = index_.clear();
        Napi::Object result = Napi::Object::New(env);
        result.Set("ok", Napi::Boolean::New(env, cleared.errors.empty()));
        result.Set("filesRemoved", Napi::Number::New(env, static_cast<double>(cleared.files_removed)));
        result.Set("bytesFreed",
                   Napi::Number::New(env, static_cast<double>(cleared.bytes_freed)));
        result.Set("totalBefore",
                   Napi::Number::New(env, static_cast<double>(cleared.total_before)));
        return result;
    }

    netops::browser::CacheIndex index_;
};

// --------------------------------------------------------------------- theme
Napi::Value BuildTheme(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Theme theme;
    if (info.Length() > 0 && info[0].IsObject()) {
        const Napi::Object patch = info[0].As<Napi::Object>();
        const std::string name = string_or(patch, "name");
        if (!name.empty()) theme.name = name;
        if (patch.Has("mode")) {
            const auto mode = netops::browser::parse_mode(string_or(patch, "mode"));
            if (!mode) {
                Napi::Object error = Napi::Object::New(env);
                error.Set("ok", Napi::Boolean::New(env, false));
                error.Set("error", Napi::String::New(env, "theme.mode must be dark, light or auto"));
                return error;
            }
            theme.mode = *mode;
        }
        if (patch.Has("colors") && patch.Get("colors").IsObject()) {
            const Napi::Object colors = patch.Get("colors").As<Napi::Object>();
            Napi::Array keys = colors.GetPropertyNames();
            for (uint32_t i = 0; i < keys.Length(); ++i) {
                theme.colors[keys.Get(i).As<Napi::String>().Utf8Value()] =
                    colors.Get(keys.Get(i)).As<Napi::String>().Utf8Value();
            }
        }
        theme.font_family = string_or(patch, "fontFamily");
        if (patch.Has("fontSize")) theme.font_size = int_or(patch, "fontSize", 0);
        if (patch.Has("lineHeight")) theme.line_height = double_or(patch, "lineHeight", 0);
        if (patch.Has("maxWidth")) theme.max_width = int_or(patch, "maxWidth", 0);
        theme.hide_images = bool_or(patch, "hideImages", theme.hide_images);
        theme.hide_ads = bool_or(patch, "hideAds", theme.hide_ads);
        theme.dim_videos = bool_or(patch, "dimVideos", theme.dim_videos);
        theme.reader_mode = bool_or(patch, "readerMode", theme.reader_mode);
        theme.force_dark = bool_or(patch, "forceDark", theme.force_dark);
    }

    if (const auto problem = theme.validate()) {
        Napi::Object error = Napi::Object::New(env);
        error.Set("ok", Napi::Boolean::New(env, false));
        error.Set("error", Napi::String::New(env, *problem));
        return error;
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, true));
    result.Set("name", Napi::String::New(env, theme.name));
    result.Set("mode", Napi::String::New(env, std::string(mode_name(theme.mode))));
    result.Set("css", Napi::String::New(env, theme.to_css()));
    result.Set("json", Napi::String::New(env, theme.to_json()));

    Napi::Object colors = Napi::Object::New(env);
    for (const auto& [key, value] : theme.colors) {
        colors.Set(key, Napi::String::New(env, value));
    }
    result.Set("colors", colors);

    Napi::Object presets = Napi::Object::New(env);
    for (const auto& [key, palette] : netops::browser::theme_presets()) {
        Napi::Object entry = Napi::Object::New(env);
        entry.Set("bg", Napi::String::New(env, palette.bg));
        entry.Set("fg", Napi::String::New(env, palette.fg));
        entry.Set("accent", Napi::String::New(env, palette.accent));
        entry.Set("muted", Napi::String::New(env, palette.muted));
        entry.Set("link", Napi::String::New(env, palette.link));
        presets.Set(key, entry);
    }
    result.Set("presets", presets);
    return result;
}

// ---------------------------------------------------------------------- pool
class PoolWrapper : public Napi::ObjectWrap<PoolWrapper> {
public:
    // node-addon-api constructs wrappers through this constructor.
    explicit PoolWrapper(const Napi::CallbackInfo& info) : Napi::ObjectWrap<PoolWrapper>(info) {}
    static Napi::Function Init(Napi::Env env) {
        return DefineClass(env, "Pool",
                           {
                               InstanceMethod("addTier", &PoolWrapper::AddTier),
                               InstanceMethod("removeTier", &PoolWrapper::RemoveTier),
                               InstanceMethod("setStrategy", &PoolWrapper::SetStrategy),
                               InstanceMethod("setSlots", &PoolWrapper::SetSlots),
                               InstanceMethod("tierNames", &PoolWrapper::TierNames),
                               InstanceMethod("select", &PoolWrapper::Select),
                               InstanceMethod("noteSuccess", &PoolWrapper::NoteSuccess),
                               InstanceMethod("noteFailure", &PoolWrapper::NoteFailure),
                               InstanceMethod("quarantine", &PoolWrapper::Quarantine),
                               InstanceMethod("upstreamCount", &PoolWrapper::UpstreamCount),
                               InstanceMethod("stats", &PoolWrapper::Stats),
                               InstanceMethod("listUpstreams", &PoolWrapper::ListUpstreams),
                           });
    }

private:
    Napi::Value AddTier(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        const Napi::Object options = info[0].As<Napi::Object>();
        const std::string name = string_or(options, "name");
        const auto strategy = netops::proxy::parse_strategy(
            string_or(options, "strategy", "round_robin"));
        if (!strategy) {
            throw Napi::Error::New(env, "unknown strategy");
        }

        std::vector<Upstream> upstreams;
        if (options.Has("upstreams") && options.Get("upstreams").IsArray()) {
            const Napi::Array rows = options.Get("upstreams").As<Napi::Array>();
            const std::string kind = string_or(options, "kind");
            for (uint32_t i = 0; i < rows.Length(); ++i) {
                const Napi::Value row = rows.Get(i);
                const std::string spec =
                    row.IsString() ? row.As<Napi::String>().Utf8Value() : DescribeObject(row.ToObject());
                auto parsed = netops::proxy::parse_upstream(spec, kind);
                if (!parsed) {
                    throw Napi::Error::New(env, "cannot parse upstream: " + spec);
                }
                upstreams.push_back(*parsed);
            }
        }

        const std::string created = pool_.add_tier(name, *strategy, std::move(upstreams));
        return Napi::String::New(env, created);
    }

    static std::string DescribeObject(const Napi::Object& row) {
        std::string spec = string_or(row, "host");
        if (!spec.empty()) {
            spec += ":" + std::to_string(int_or(row, "port", 0));
            const std::string scheme = string_or(row, "kind");
            if (!scheme.empty() && scheme != "http") spec = scheme + "://" + spec;
        }
        const std::string tag = string_or(row, "tag");
        if (!tag.empty()) spec += "#tag=" + tag;
        return spec;
    }

    Napi::Value RemoveTier(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(),
                                  pool_.remove_tier(info[0].As<Napi::String>().Utf8Value()));
    }

    Napi::Value SetStrategy(const Napi::CallbackInfo& info) {
        const auto strategy =
            netops::proxy::parse_strategy(info[0].As<Napi::String>().Utf8Value());
        if (!strategy) return Napi::Boolean::New(info.Env(), false);
        return Napi::Boolean::New(
            info.Env(), pool_.set_strategy(info[1].As<Napi::String>().Utf8Value(), *strategy));
    }

    Napi::Value SetSlots(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(
            info.Env(),
            pool_.set_slots(info[0].As<Napi::String>().Utf8Value(),
                            static_cast<std::size_t>(int_or(info[1].ToObject(), "slots", 0))));
    }

    Napi::Value TierNames(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        const auto names = pool_.tier_names();
        Napi::Array out = Napi::Array::New(env, names.size());
        for (std::size_t i = 0; i < names.size(); ++i) {
            out.Set(static_cast<uint32_t>(i), Napi::String::New(env, names[i]));
        }
        return out;
    }

    Napi::Value Select(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        const std::string sticky =
            info.Length() > 0 && info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : "";
        const auto picked = pool_.select(sticky);
        if (!picked.upstream) return env.Null();

        Napi::Object result = Napi::Object::New(env);
        result.Set("id", Napi::String::New(env, picked.upstream->id));
        result.Set("host", Napi::String::New(env, picked.upstream->host));
        result.Set("port", Napi::Number::New(env, picked.upstream->port));
        result.Set("kind", Napi::String::New(env, std::string(netops::proxy::kind_name(picked.upstream->kind))));
        result.Set("display", Napi::String::New(env, picked.upstream->display()));
        result.Set("tier", Napi::Number::New(env, static_cast<double>(picked.tier_index)));
        result.Set("reason", Napi::String::New(env, picked.reason));
        return result;
    }

    Napi::Value NoteSuccess(const Napi::CallbackInfo& info) {
        const std::string id = info[0].As<Napi::String>().Utf8Value();
        const uint64_t bytes = static_cast<uint64_t>(int_or(info[1].ToObject(), "bytes", 0));
        pool_.note_success(id, bytes, static_cast<double>(time(nullptr)));
        return info.Env().Undefined();
    }

    Napi::Value NoteFailure(const Napi::CallbackInfo& info) {
        const std::string id = info[0].As<Napi::String>().Utf8Value();
        const std::string error = info.Length() > 1 && info[1].IsString()
                                      ? info[1].As<Napi::String>().Utf8Value()
                                      : "unknown";
        pool_.note_failure(id, error, static_cast<double>(time(nullptr)));
        return info.Env().Undefined();
    }

    Napi::Value Quarantine(const Napi::CallbackInfo& info) {
        pool_.quarantine(info[0].As<Napi::String>().Utf8Value(), static_cast<double>(time(nullptr)));
        return info.Env().Undefined();
    }

    Napi::Value UpstreamCount(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), static_cast<double>(pool_.size()));
    }

    Napi::Value Stats(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        Napi::Object result = Napi::Object::New(env);
        result.Set("upstreams", Napi::Number::New(env, static_cast<double>(pool_.size())));
        result.Set("tiers", Napi::Number::New(env, static_cast<double>(pool_.tier_count())));
        result.Set("healthy", Napi::Number::New(env, static_cast<double>(pool_.healthy_count())));
        result.Set("requests", Napi::Number::New(env, static_cast<double>(pool_.requests())));
        result.Set("failures", Napi::Number::New(env, static_cast<double>(pool_.failures())));
        return result;
    }

    Napi::Value ListUpstreams(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        Napi::Array out = Napi::Array::New(env, pool_.size());
        uint32_t index = 0;
        for (const auto& upstream : pool_.upstreams()) {
            Napi::Object row = Napi::Object::New(env);
            row.Set("id", Napi::String::New(env, upstream.id));
            row.Set("host", Napi::String::New(env, upstream.host));
            row.Set("port", Napi::Number::New(env, upstream.port));
            row.Set("kind", Napi::String::New(env, std::string(netops::proxy::kind_name(upstream.kind))));
            row.Set("display", Napi::String::New(env, upstream.display()));
            row.Set("tag", Napi::String::New(env, upstream.tag));
            row.Set("health", Napi::String::New(env, std::string(netops::proxy::health_name(upstream.health))));
            row.Set("requests", Napi::Number::New(env, static_cast<double>(upstream.requests)));
            row.Set("failures", Napi::Number::New(env, static_cast<double>(upstream.failures)));
            row.Set("successRate", Napi::Number::New(env, upstream.success_rate()));
            row.Set("lastError", Napi::String::New(env, upstream.last_error));
            out.Set(index++, row);
        }
        return out;
    }

    Pool pool_;
};

Napi::Value Version(const Napi::CallbackInfo& info) {
    Napi::Object result = Napi::Object::New(info.Env());
    result.Set("name", Napi::String::New(info.Env(), "netops_native"));
    result.Set("runtime", Napi::String::New(info.Env(), "c++20"));
    result.Set("trackerPatterns",
               Napi::Number::New(info.Env(),
                                 static_cast<double>(Blocklist::builtin_patterns().size())));
    result.Set("themePresets",
               Napi::Number::New(info.Env(),
                                 static_cast<double>(netops::browser::theme_presets().size())));
    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("version", Napi::String::New(env, "netops-native c++20"));
    exports.Set("normaliseUrl", Napi::Function::New(env, NormaliseUrl));
    exports.Set("validateHost", Napi::Function::New(env, ValidateHost));
    exports.Set("Blocklist", BlocklistWrapper::Init(env));
    exports.Set("CookieJar", CookieJarWrapper::Init(env));
    exports.Set("CacheIndex", CacheIndexWrapper::Init(env));
    exports.Set("Pool", PoolWrapper::Init(env));
    exports.Set("buildTheme", Napi::Function::New(env, BuildTheme));
    return exports;
}

}  // namespace

NODE_API_MODULE(netops_native, Init)
