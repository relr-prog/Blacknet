cmake_minimum_required(VERSION 3.20)
project(netops_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(NETOPS_BUILD_ADDON "Build the Node.js native addon" ON)
option(NETOPS_BUILD_TESTS "Build the C++ unit tests" ON)

add_library(netops_core STATIC
  src/util.cpp
  src/net/url.cpp
  src/net/blocklist.cpp
  src/browser/cookies.cpp
  src/browser/cache_index.cpp
  src/browser/theme.cpp
  src/proxy/pool.cpp
)
target_include_directories(netops_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(netops_core PRIVATE -Wall -Wextra -Wpedantic -Wshadow)
endif()

# ---------------------------------------------------------------- node addon
if(NETOPS_BUILD_ADDON)
  # Electron's npm package ships the binary but not its headers - those live on a
  # separate CDN that node-gyp fetches on demand - so the addon is compiled
  # against whatever node headers this machine has. That is deliberate, and it is
  # only safe because this is an N-API addon (node-addon-api): its ABI is
  # versioned independently of Node and Electron and resolved when Electron loads
  # the .node file. A V8/NAN addon would need the matching Electron headers right
  # here, and would stop loading after an Electron upgrade.
  #
  # Hence the plain if(EXISTS) walk instead of find_path: find_path caches its
  # answer in CMakeCache.txt, so after an Electron bump the cached directory kept
  # winning and a rebuild quietly compiled against the previous headers without
  # saying so. CMakeCache.txt is not tracked, so this does not clean old entries
  # for anyone who already has a build directory; the normal variables below
  # shadow them.
  set(NODE_MODULES_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../node_modules"
      CACHE PATH "node_modules directory to build the addon against")

  set(NODE_ADDON_API_INCLUDE_DIR "")
  if(EXISTS "${NODE_MODULES_ROOT}/node-addon-api/napi.h")
    set(NODE_ADDON_API_INCLUDE_DIR "${NODE_MODULES_ROOT}/node-addon-api")
  endif()

  set(NODE_API_INCLUDE_DIR "")
  foreach(candidate IN ITEMS
      "${NODE_MODULES_ROOT}/electron/dist/include/node"
      "${NODE_MODULES_ROOT}/node/include/node"
      "/usr/include/node"
      "/usr/local/include/node")
    if(NOT NODE_API_INCLUDE_DIR AND EXISTS "${candidate}/node_api.h")
      set(NODE_API_INCLUDE_DIR "${candidate}")
    endif()
  endforeach()

  if(NOT NODE_ADDON_API_INCLUDE_DIR OR NOT NODE_API_INCLUDE_DIR)
    message(WARNING
      "native addon disabled: node-addon-api headers not found at "
      "'${NODE_MODULES_ROOT}/node-addon-api'. Run 'npm install' first, or pass "
      "-DNODE_MODULES_ROOT=<path>. Configure with -DNETOPS_BUILD_ADDON=OFF to "
      "build the C++ core and tests only.")
  else()
    message(STATUS "node-addon-api: ${NODE_ADDON_API_INCLUDE_DIR}")
    message(STATUS "node headers: ${NODE_API_INCLUDE_DIR} (N-API, so this does not have to match Electron's Node)")

    # No find_library(NAMES node) here, deliberately. A distro libnode.so (Node
    # 20, V8 12.4) links its own copy of V8 into the addon, and Electron carries
    # its own (V8 15.2). Two V8s in one process: loading the addon SIGSEGVs before
    # main() runs, on every platform, with no error message - it just looks like
    # Electron is broken. N-API symbols are resolved from whatever process loads
    # the .node, which is the whole point of the stable ABI, so linking is not
    # just unnecessary here, it is what breaks it.
    add_library(netops_node MODULE src/bindings.cpp)
    target_include_directories(netops_node PRIVATE
      ${CMAKE_CURRENT_SOURCE_DIR}/include
      ${NODE_ADDON_API_INCLUDE_DIR}
      ${NODE_API_INCLUDE_DIR}
    )
    target_link_libraries(netops_node PRIVATE netops_core)
    set_target_properties(netops_node PROPERTIES
      PREFIX ""
      # Node's require() looks for the .node suffix, not the platform's .so
      SUFFIX ".node"
      OUTPUT_NAME "netops_native"
      LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../build/native
    )
    if(APPLE)
      set_target_properties(netops_node PROPERTIES LINK_FLAGS "-undefined dynamic_lookup")
    endif()
    if(WIN32)
      # A PE DLL must resolve every symbol at link time - Windows has no loose
      # dynamic lookup the way ELF and Mach-O do. N-API is a stable C ABI, so
      # all it needs is an import library of the symbols the host will export at
      # runtime; linking it pulls no V8 and no libnode. Point NODE_IMPORT_LIB at
      # a .lib generated from the process that loads the addon (node.exe for a
      # plain Node build, electron.exe for Electron) - gendef + dlltool make one
      # from the host binary. Without it the addon is not linkable on Windows.
      if(NODE_IMPORT_LIB)
        target_link_libraries(netops_node PRIVATE "${NODE_IMPORT_LIB}")
      else()
        message(WARNING
          "native addon will not link on WIN32 without a node API import
           library: configure with -DNODE_IMPORT_LIB=<host .lib>")
      endif()
    endif()
    if(MSVC)
      set_target_properties(netops_node PROPERTIES RUNTIME_OUTPUT_DIRECTORY
        ${CMAKE_CURRENT_SOURCE_DIR}/../build/native)
    endif()
  endif()
endif()

# --------------------------------------------------------------------- tests
if(NETOPS_BUILD_TESTS)
  enable_testing()

  add_executable(netops_tests
    tests/test_url.cpp
    tests/test_blocklist.cpp
    tests/test_cookies.cpp
    tests/test_cache_index.cpp
    tests/test_theme.cpp
    tests/test_pool.cpp
    tests/test_main.cpp
  )
  target_link_libraries(netops_tests PRIVATE netops_core)
  target_include_directories(netops_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(netops_tests PRIVATE -Wall -Wextra -Wpedantic)
  endif()

  set(NETOPS_TEST_CASES
    url_accepts_bare_hosts
    url_upgrades_http_when_https_only
    url_keeps_loopback_on_plain_http
    url_rejects_dangerous_schemes
    url_rejects_embedded_credentials
    url_parses_port_and_path
    url_handles_ipv6_literals
    url_limits_data_urls
    host_validation_blocks_private_ranges
    host_validation_allows_private_when_opted_in
    url_should_block_helper
    blocklist_matches_builtin_hosts_and_subdomains
    blocklist_matches_path_rules
    blocklist_respects_suffix_rules
    blocklist_ignores_clean_urls
    blocklist_json_lists_rules
    cookies_are_redacted_in_the_report
    cookies_group_by_domain
    cookies_filter_by_domain_and_expiry
    cookies_select_for_clearing
    cookie_report_json_has_no_values
    cache_index_measures_and_clears
    cache_index_handles_missing_profile
    theme_css_uses_palette_and_overrides
    theme_reader_mode_and_hide_ads
    theme_rejects_bad_input
    theme_merge_applies_patch
    theme_auto_mode_follows_the_os
    pool_parses_upstream_formats
    pool_rejects_broken_specs
    pool_round_robin_advances
    pool_sticky_is_deterministic
    pool_least_used_prefers_idle
    pool_failover_prefers_healthy
    pool_skips_unhealthy_upstreams
    pool_records_success_and_failure
    pool_quarantine_hides_upstream
    pool_tier_management
    pool_remove_tier_drops_upstreams
    pool_json_summary
  )

  foreach(case ${NETOPS_TEST_CASES})
    add_test(NAME ${case} COMMAND netops_tests ${case})
  endforeach()
endif()
