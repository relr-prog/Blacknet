#include "netops/browser/cache_index.hpp"

#include <filesystem>
#include <fstream>

#include "test_harness.hpp"

namespace fs = std::filesystem;
using namespace netops::browser;

namespace {

fs::path write_file(const fs::path& path, std::size_t bytes) {
    fs::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary);
    out << std::string(bytes, 'x');
    return path;
}

}  // namespace

NETOPS_TEST(cache_index_measures_and_clears) {
    const fs::path root = fs::temp_directory_path() / "netops-cache-test";
    fs::remove_all(root);
    write_file(root / "Default" / "Cache" / "data_0", 4096);
    write_file(root / "Code Cache" / "js.bin", 2048);
    write_file(root / "Preferences", 128);
    write_file(root / "Cookies", 64);

    const CacheIndex index(root);
    const CacheReport report = index.scan();
    EXPECT_EQ(report.files, std::size_t{4});
    EXPECT_EQ(report.total_bytes, std::uint64_t{4096 + 2048 + 128 + 64});
    EXPECT_EQ(report.cache_bytes, std::uint64_t{6144});
    EXPECT_FALSE(report.largest_cache_files.empty());
    EXPECT_EQ(report.largest_cache_files.front().bytes, std::uint64_t{4096});

    const ClearResult cleared = index.clear();
    EXPECT_EQ(cleared.files_removed, std::size_t{2});
    EXPECT_EQ(cleared.bytes_freed, std::uint64_t{6144});
    EXPECT_TRUE(cleared.errors.empty());
    EXPECT_TRUE(cleared.to_json().find("\"ok\": true") != std::string::npos);

    // preferences and cookies must survive a cache clear
    EXPECT_TRUE(fs::exists(root / "Preferences"));
    EXPECT_TRUE(fs::exists(root / "Cookies"));
    EXPECT_EQ(index.scan().total_bytes, std::uint64_t{192});

    const std::string json = index.scan().to_json();
    EXPECT_CONTAINS(json, "\"cache_bytes\": 0");
    fs::remove_all(root);
}

NETOPS_TEST(cache_index_handles_missing_profile) {
    const fs::path root = fs::temp_directory_path() / "netops-cache-missing";
    fs::remove_all(root);
    const CacheIndex index(root);
    const CacheReport report = index.scan();
    EXPECT_EQ(report.total_bytes, std::uint64_t{0});
    EXPECT_EQ(report.files, std::size_t{0});
    const ClearResult cleared = index.clear();
    EXPECT_EQ(cleared.files_removed, std::size_t{0});
    EXPECT_EQ(directory_size(root, nullptr), std::uint64_t{0});
}
