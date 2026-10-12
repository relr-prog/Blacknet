# Repository audit snapshot

This is a source and documentation review, not a penetration test or a claim of
security certification. Findings below were checked against the working tree
on 2026-10-12. File references are repository-relative.

| Status | Finding | Evidence |
| --- | --- | --- |
| Confirmed | The GitHub repository description contained claims about Rust, fingerprint spoofing, encrypted cookies, and default proxy chains that did not match the implementation. The description was updated; the README now describes implemented limits. | Repository description; `README.md`; `netops-desktop/package.json` |
| Confirmed | `netops/` is not a dead-code folder suitable for deletion: it contains its own Python application, imports, service unit, and tests. It is not launched by the desktop shell. | `netops/netops/`; `netops/tests/`; `netops/deploy/netops.service` |
| Confirmed | No tracked license, security policy, contribution guide, or GitHub workflow configuration existed at audit time. MIT was selected as the default license. | `LICENSE`; `SECURITY.md`; `CONTRIBUTING.md`; `.github/` |
| Fixed / not verified | Proxying remains optional and disabled by default. When explicitly enabled, the desktop now blocks requests if the gateway is unavailable or not applied to the tab, rather than selecting a fallback route. DNS-leak behavior has not been empirically verified; manual checks are documented. | `netops-desktop/src/main/proxy-fail-closed.js`; `netops-desktop/src/main/tabs.js`; `netops-desktop/test/proxy-fail-closed.test.js`; `docs/PROXY-LEAK-CHECK.md` |
| Confirmed | The desktop native addon ships 56 built-in tracker patterns and has custom host/path/regex/CIDR rules. EasyList/EasyPrivacy parsing, managed updates, and a large-list performance benchmark are not implemented. | `netops-desktop/native/src/net/blocklist.cpp`; `netops-desktop/native/include/netops/net/blocklist.hpp`; `netops-desktop/native/tests/test_blocklist.cpp` |
| Confirmed | Vault record encryption uses AES-256-GCM, random 12-byte IVs, and associated data bound to id/origin/username. A user-facing master-password layer and migration path are not implemented. | `netops-desktop/src/main/vault.js`; `netops-desktop/test/vault.test.js` |
| Already fixed | The README inaccurately said the default search kept queries on the machine. The implementation sends queries to public APIs; this is now disclosed in the README, threat model, and source comment. | `netops-desktop/src/main/search.js`; `README.md` |
| Confirmed | Fingerprinting protections are best-effort: timezone overrides cover selected JavaScript probes and letterboxing changes the page viewport, but neither establishes broad fingerprint resistance. | `netops-desktop/src/main/timezone.js`; `netops-desktop/src/main/letterbox.js`; `netops-desktop/src/main/hardening.js` |
| Confirmed | Android's release build and lint artifacts exist locally, but no physical-device run was evidenced. The README retains this caveat. | `netops-android/app/build.gradle.kts`; `README.md` |
| Confirmed | An open draft security PR (#1) covers URL/IPC/proxy hardening and has passing desktop and Android CI jobs. Passing CI does not establish end-to-end proxy leak resistance; the PR itself calls for further review. | GitHub PR #1; GitHub Actions checks |
| Confirmed | No product screenshot was tracked at audit time. A capture of the desktop new-tab page content was added; it intentionally does not imply that browser chrome is shown. | `docs/newtab.png`; `README.md` |

The audit did not delete `netops/`, perform live DNS/WebRTC leak tests, test
platform authentication on physical devices, or evaluate proxy-rotator
single-binary packaging. Those require separate validation.
