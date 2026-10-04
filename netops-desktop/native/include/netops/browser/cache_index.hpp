// Cache and storage accounting for a browser profile directory.
//
// Electron owns the profile; this walks the same directory Chromium writes to
// so the panel can show and free disk usage without guessing.
#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace netops::browser {

struct CacheFile {
    std::string path;   // relative to the profile root
    std::uint64_t bytes = 0;
};

struct CacheReport {
    std::string profile;
    std::uint64_t total_bytes = 0;
    std::size_t files = 0;
    std::uint64_t cache_bytes = 0;
    std::vector<CacheFile> largest_cache_files;
    bool cache_enabled = false;

    std::string to_json() const;
};

struct ClearResult {
    std::size_t files_removed = 0;
    std::uint64_t bytes_freed = 0;
    std::uint64_t total_before = 0;
    std::vector<std::string> errors;

    std::string to_json() const;
};

class CacheIndex {
public:
    explicit CacheIndex(std::filesystem::path profile_dir);

    CacheReport scan() const;
    // Removes cache trees (not preferences, cookies or logins).
    ClearResult clear() const;

    static const std::vector<std::string>& cache_directories();

private:
    std::filesystem::path root_;
};

std::uint64_t directory_size(const std::filesystem::path& path, std::size_t* files);

}  // namespace netops::browser
