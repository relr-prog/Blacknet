# Contributing

Contributions should be focused, tested, and explicit about security and
privacy implications. Avoid changing unrelated behavior in the same pull
request. Do not commit provider credentials, signing keys, user data, or
generated build output.

## Development and tests

Run commands from the relevant project directory:

```sh
# Desktop Electron shell and C++ addon
cd netops-desktop
npm install
npm test
npm run smoke
bash tools/check_syntax.sh

# Optional proxy gateway
cd ../proxy-rotator
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest

# Android shell
cd ../netops-android
./gradlew test lintDebug
```

The desktop smoke suite opens a real Electron window and may require a graphical
display or a configured headless display. Android unit tests and lint do not
replace testing on a physical device. Do not describe Android as device-tested
unless it has actually been run on a device.

The desktop build requires Node.js, Electron's runtime dependencies, and a C++20
toolchain with CMake. Android builds require JDK 17 and the Android SDK. The
proxy gateway requires Python 3.11 or newer. See the root README for platform
notes and packaging details.

## Pull requests

- Explain the user-visible change, its security/privacy impact, and known
  limitations.
- Add or update focused tests for behavior changes.
- Run the relevant checks above and report any check that could not be run.
- Keep generated files and local configuration out of the change.

Use a concise Conventional Commit-style subject, for example
`fix(proxy): reject unavailable gateway routes`. Keep one concern per commit.
