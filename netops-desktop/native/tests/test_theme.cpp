#include "netops/util.hpp"

#include "netops/browser/theme.hpp"

#include "test_harness.hpp"

using namespace netops;
using namespace netops::browser;

NETOPS_TEST(theme_css_uses_palette_and_overrides) {
    Theme theme;
    theme.name = "forest";
    const std::string css = theme.to_css();
    EXPECT_CONTAINS(css, "#0f1a14");   // preset background
    EXPECT_CONTAINS(css, "#a3e635");   // preset link colour
    EXPECT_CONTAINS(css, "html,body{background:");

    theme.colors["accent"] = "#00ff00";
    theme.colors["bg"] = "#010203";
    const std::string overridden = theme.to_css();
    EXPECT_CONTAINS(overridden, "#00ff00");
    EXPECT_CONTAINS(overridden, "#010203");
    EXPECT_FALSE(overridden.find("#0f1a14") != std::string::npos);
}

NETOPS_TEST(theme_reader_mode_and_hide_ads) {
    Theme reader;
    reader.mode = ThemeMode::Light;
    reader.reader_mode = true;
    reader.hide_ads = true;
    reader.hide_images = true;
    reader.dim_videos = true;
    reader.font_family = "Georgia, serif";
    reader.font_size = 18;
    reader.line_height = 1.7;
    reader.max_width = 720;

    const std::string css = reader.to_css();
    EXPECT_CONTAINS(css, "font-family:Georgia, serif");
    EXPECT_CONTAINS(css, "font-size:18px");
    EXPECT_CONTAINS(css, "line-height:1.70");
    EXPECT_CONTAINS(css, "max-width:720px");
    EXPECT_CONTAINS(css, "display:none");
    EXPECT_CONTAINS(css, "opacity:.45");
    // a light theme must not be inverted
    EXPECT_FALSE(css.find("invert(") != std::string::npos);

    Theme dark;
    EXPECT_CONTAINS(dark.to_css(), "invert(");

    dark.force_dark = false;
    EXPECT_FALSE(dark.to_css().find("invert(") != std::string::npos);
}

NETOPS_TEST(theme_rejects_bad_input) {
    Theme theme;
    theme.name = "neon";
    EXPECT_TRUE(theme.validate().has_value());

    theme.name = "midnight";
    theme.font_size = 4;
    EXPECT_TRUE(theme.validate().has_value());
    theme.font_size = 18;
    EXPECT_FALSE(theme.validate().has_value());

    theme.font_size.reset();
    theme.line_height = 9.0;
    EXPECT_TRUE(theme.validate().has_value());
    theme.line_height = 1.4;
    EXPECT_FALSE(theme.validate().has_value());

    theme.line_height.reset();
    theme.colors["accent"] = "javascript:alert(1)";
    EXPECT_TRUE(theme.validate().has_value());
    theme.colors["accent"] = "#fff";
    EXPECT_FALSE(theme.validate().has_value());

    theme.colors.clear();
    theme.font_family = "x; } body { display: none } .z {";
    EXPECT_TRUE(theme.validate().has_value());
    theme.font_family = "Iosevka, monospace";
    EXPECT_FALSE(theme.validate().has_value());

    EXPECT_TRUE(parse_mode("DARK").has_value());
    EXPECT_EQ(*parse_mode("auto"), ThemeMode::Auto);
    EXPECT_FALSE(parse_mode("neon").has_value());
    EXPECT_EQ(std::string(mode_name(ThemeMode::Light)), std::string("light"));
}

NETOPS_TEST(theme_merge_applies_patch) {
    Theme base;
    base.name = "midnight";
    base.colors["accent"] = "#111111";

    Theme patch;
    patch.name = "sepia";
    patch.colors["accent"] = "#222222";
    patch.colors["bg"] = "#333333";
    patch.reader_mode = true;

    const Theme merged = *base.merge(patch);
    EXPECT_EQ(merged.name, std::string("sepia"));
    EXPECT_EQ(merged.colors.at("accent"), std::string("#222222"));
    EXPECT_EQ(merged.colors.at("bg"), std::string("#333333"));
    EXPECT_EQ(merged.reader_mode, true);
    EXPECT_FALSE(merged.validate().has_value());

    // base is untouched
    EXPECT_EQ(base.name, std::string("midnight"));
    EXPECT_EQ(base.colors.at("accent"), std::string("#111111"));

    const std::string json = merged.to_json();
    EXPECT_CONTAINS(json, "\"name\": \"sepia\"");
    EXPECT_CONTAINS(json, "\"reader_mode\": true");
    EXPECT_EQ(theme_presets().size(), std::size_t{6});
}

NETOPS_TEST(theme_auto_mode_follows_the_os) {
    Theme auto_theme;
    auto_theme.mode = ThemeMode::Auto;
    const std::string css = auto_theme.to_css();
    EXPECT_CONTAINS(css, "prefers-color-scheme: dark");
    EXPECT_CONTAINS(css, "prefers-color-scheme: light");

    // a pinned mode must not emit media queries at all
    Theme dark;
    EXPECT_FALSE(contains(dark.to_css(), "prefers-color-scheme"));
    Theme light;
    light.mode = ThemeMode::Light;
    EXPECT_FALSE(contains(light.to_css(), "prefers-color-scheme"));
}
