#include "netops/browser/theme.hpp"

#include <cctype>
#include <cstdio>

#include "netops/util.hpp"

namespace netops::browser {
namespace {

bool is_hex_colour(std::string_view value) {
    if (value.empty() || value.front() != '#') return false;
    if (value.size() != 4 && value.size() != 7 && value.size() != 9) return false;
    for (std::size_t i = 1; i < value.size(); ++i) {
        if (!std::isxdigit(static_cast<unsigned char>(value[i]))) return false;
    }
    return true;
}

// font-family ends up inside a CSS declaration: keep it to inert characters.
bool is_safe_font(std::string_view value) {
    if (value.empty() || value.size() > 80) return false;
    for (const char c : value) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) || c == ' ' || c == ',' ||
                        c == '\'' || c == '"' || c == '(' || c == ')' || c == '-';
        if (!ok) return false;
    }
    return true;
}

std::string format_double(double value) {
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%.2f", value);
    return buffer;
}

// The surface rules shared by every mode: colours, links and code blocks.
std::string surface_css(const ThemePalette& palette) {
    std::string css;
    css += "html,body{background:" + palette.bg + "!important;color:" + palette.fg + "!important}\n";
    css += "a,a:link,a:visited{color:" + palette.link + "!important}\n";
    css += "button,input,select,textarea{border-color:" + palette.muted + "!important}\n";
    css += "::selection{background:" + palette.accent + "!important;color:" + palette.bg +
           "!important}\n";
    css += "code,pre,kbd{background:" + palette.fg + "33!important;color:" + palette.fg +
           "!important}\n";
    return css;
}

}  // namespace

const std::map<std::string, ThemePalette>& theme_presets() {
    static const std::map<std::string, ThemePalette> presets = {
        // BlackNet Opsi A (deep slate dark, night) and Opsi B (warm off-white, day):
        // no pure black and no pure white, so page text neither blooms nor glares.
        {"midnight", {"#1e222a", "#e1e4ea", "#569cd6", "#a9b2c0", "#4a8cc4"}},
        {"paper", {"#f4f5f7", "#1f2937", "#0d9488", "#566173", "#0a6e66"}},
        {"forest", {"#0f1a14", "#dff3e5", "#34d399", "#7ea894", "#a3e635"}},
        {"sunset", {"#1a1016", "#ffe9e3", "#fb923c", "#b08999", "#f472b6"}},
        {"contrast", {"#000000", "#ffffff", "#ffff00", "#cccccc", "#00ffff"}},
        {"sepia", {"#f4ecd8", "#3b2f2f", "#8b5a2b", "#7a6a5a", "#8b4513"}},
    };
    return presets;
}

std::optional<ThemeMode> parse_mode(std::string_view text) {
    const std::string value = lower(text);
    if (value == "dark") return ThemeMode::Dark;
    if (value == "light") return ThemeMode::Light;
    if (value == "auto") return ThemeMode::Auto;
    return std::nullopt;
}

const char* mode_name(ThemeMode mode) {
    switch (mode) {
        case ThemeMode::Dark: return "dark";
        case ThemeMode::Light: return "light";
        case ThemeMode::Auto: return "auto";
    }
    return "dark";
}

std::optional<std::string> Theme::validate() const {
    if (theme_presets().find(name) == theme_presets().end()) {
        return "theme.name must be one of: " + [] {
            std::string names;
            for (const auto& [key, _] : theme_presets()) {
                if (!names.empty()) names += ", ";
                names += key;
            }
            return names;
        }();
    }
    if (font_size && (*font_size < 10 || *font_size > 32)) {
        return "theme.font_size must be between 10 and 32";
    }
    if (line_height && (*line_height < 1.0 || *line_height > 2.5)) {
        return "theme.line_height must be between 1.0 and 2.5";
    }
    if (max_width && (*max_width < 480 || *max_width > 2560)) {
        return "theme.max_width must be between 480 and 2560";
    }
    for (const auto& [key, value] : colors) {
        if (!is_hex_colour(value)) {
            return "theme colour " + key + "=" + value + " must be a hex colour";
        }
    }
    if (!font_family.empty() && !is_safe_font(font_family)) {
        return "theme.font_family may only contain letters, spaces and punctuation";
    }
    return std::nullopt;
}

std::optional<Theme> Theme::merge(const Theme& patch) const {
    Theme out = *this;
    if (!patch.name.empty()) out.name = patch.name;
    if (patch.colors.empty() == false) {
        for (const auto& [key, value] : patch.colors) out.colors[key] = value;
    }
    if (!patch.font_family.empty()) out.font_family = patch.font_family;
    if (patch.font_size) out.font_size = patch.font_size;
    if (patch.line_height) out.line_height = patch.line_height;
    if (patch.max_width) out.max_width = patch.max_width;
    if (patch.hide_images) out.hide_images = true;
    if (patch.hide_ads) out.hide_ads = true;
    if (patch.dim_videos) out.dim_videos = true;
    if (patch.reader_mode) out.reader_mode = true;
    if (patch.force_dark) out.force_dark = true;
    return out;
}

std::string Theme::to_css() const {
    ThemePalette palette = theme_presets().at("midnight");
    if (const auto it = theme_presets().find(name); it != theme_presets().end()) {
        palette = it->second;
    }
    for (const auto& [key, value] : colors) {
        if (key == "bg") palette.bg = value;
        else if (key == "fg") palette.fg = value;
        else if (key == "accent") palette.accent = value;
        else if (key == "muted") palette.muted = value;
        else if (key == "link") palette.link = value;
    }

    std::string css;
    if (mode == ThemeMode::Auto) {
        // "auto" has to follow the OS setting, so both palettes ship and the
        // media query picks one. The dark half uses the preset as-is; the light
        // half swaps the surfaces so the accent stays readable on white.
        ThemePalette light = palette;
        light.bg = "#f4f5f7";  // Opsi B background
        light.fg = "#1f2937";  // Opsi B text
        light.muted = "#566173";
        light.accent = "#0d9488";
        light.link = "#0a6e66";
        css += "@media (prefers-color-scheme: dark){\n" + surface_css(palette) + "}\n";
        css += "@media (prefers-color-scheme: light){\n" + surface_css(light) + "}\n";
    } else {
        css += surface_css(palette);
    }

    if (!font_family.empty()) {
        css += "html,body,input,button,textarea,select{font-family:" + font_family +
               "!important}\n";
    }
    if (font_size) {
        css += "html{font-size:" + std::to_string(*font_size) + "px!important}\n";
    }
    if (line_height) {
        css += "body{line-height:" + format_double(*line_height) + "!important}\n";
    }
    if (max_width) {
        css += "body>*{max-width:" + std::to_string(*max_width) +
               "px!important;margin-left:auto!important;margin-right:auto!important}\n";
    }
    if (hide_images) {
        css +=
            "img,picture,video,svg.image{visibility:hidden!important;max-height:1px!important}\n";
    }
    if (dim_videos) {
        css += "video{opacity:.45!important}video:hover{opacity:1!important}\n";
    }
    if (hide_ads) {
        css +=
            "[id*='banner'],[class*='ad-'],[class*='advert'],[id*='-ad-'],"
            "[class*='sponsored'],iframe[src*='doubleclick'],iframe[src*='adsystem']"
            "{display:none!important}\n";
    }
    if (reader_mode) {
        css +=
            "body>*:not(main):not(article):not(#content):not(.post):not([role=main])"
            "{display:none!important}\n"
            "body{max-width:720px!important;margin:2rem auto!important;padding:0 1rem!important;"
            "background:#fdfdfb!important;color:#161616!important;font-size:18px!important;"
            "line-height:1.7!important;font-family:Georgia,serif!important}\n";
    }
    if (force_dark && (mode == ThemeMode::Dark || mode == ThemeMode::Auto)) {
        css +=
            "img,video,canvas,svg,iframe,embed,object,input,textarea,select,"
            "button,.btn,.card,.panel,.modal{filter:invert(0.92) hue-rotate(180deg)!important}\n";
    }
    return css;
}

std::string Theme::to_json() const {
    JsonWriter json;
    json.begin_object();
    json.field("name", name);
    json.field("mode", std::string(mode_name(mode)));
    json.key("colors").begin_object();
    for (const auto& [key, value] : colors) json.field(key, value);
    json.end_object();
    json.field("font_family", font_family);
    if (font_size) json.field("font_size", *font_size);
    else json.key("font_size").null_value();
    if (line_height) json.field("line_height", *line_height);
    else json.key("line_height").null_value();
    if (max_width) json.field("max_width", *max_width);
    else json.key("max_width").null_value();
    json.field("hide_images", hide_images);
    json.field("hide_ads", hide_ads);
    json.field("dim_videos", dim_videos);
    json.field("reader_mode", reader_mode);
    json.field("force_dark", force_dark);
    json.end_object();
    return json.str();
}

}  // namespace netops::browser
