#!/usr/bin/env bash
# Repository hygiene gate.
#
# This exists because a PowerShell-mangled shell command once redirected
# fragments of the reauth helper into three files whose names were
#   payload =            (trailing space)
#   password +
#   if password is not None else
# All three got committed. Two problems followed:
#
#   1. The secret scan missed them, because it looked for credentials and
#      sensitive paths, never for filename shape.
#   2. Windows git cannot address them at all. "payload = " has a trailing
#      space, and the \\wsl.localhost bridge applies Windows path rules that
#      trim it, so git failed with ENOENT on a file that demonstrably exists.
#
# So: fail loudly on tracked filenames that are unrepresentable on Windows or
# awkward in a shell. Run from the repository root.
set -uo pipefail

# Resolve the repository root from this script's own location, not the cwd: the
# root is the monorepo parent, and a caller may run this from anywhere. An
# empty rev-parse must be a hard error, otherwise every check below vacuously
# passes against zero files.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$root" ]; then
  echo "[check_repo] FAIL not inside a git repository (looked from $here)" >&2
  exit 1
fi
cd "$root" || exit 1

status=0
note() { printf '  %s\n' "$1"; }
fail() {
  printf '[check_repo] FAIL %s\n' "$1" >&2
  status=1
}

mapfile -t tracked < <(git ls-files)
if [ "${#tracked[@]}" -eq 0 ]; then
  echo "[check_repo] FAIL repository has no tracked files; refusing to pass" >&2
  exit 1
fi

echo "[check_repo] ${#tracked[@]} tracked file(s)"

# --- 1. filenames Windows or a shell cannot represent -----------------------
# Trailing/leading spaces, tabs, and the characters that mean something to
# cmd.exe, PowerShell or /bin/sh.
bad=0
for f in "${tracked[@]}"; do
  why=""
  # Any whitespace at all, not just leading or trailing. The original incident
  # produced three names and only the trailing-space one is unrepresentable on
  # Windows; the other two ("password +" and "if password is not None else")
  # are representable but still shell hazards that nobody would type on
  # purpose. No legitimate file in this repository contains a space.
  if [[ "$f" =~ [[:space:]] ]]; then
    why="contains whitespace"
  fi
  case "$f" in
    *['"'*]*)   why="${why:+$why; }double quote" ;;
    *"'"*)      why="${why:+$why; }single quote" ;;
    *'$'*)       why="${why:+$why; }dollar" ;;
    *'`'*)       why="${why:+$why; }backtick" ;;
    *';'*)       why="${why:+$why; }semicolon" ;;
    *'|'*)       why="${why:+$why; }pipe" ;;
    *'<'*|*'>'*) why="${why:+$why; }redirect" ;;
    *'*'*|*'?'*) why="${why:+$why; }glob" ;;
    *':'*)       why="${why:+$why; }colon (breaks Windows paths)" ;;
    *'\'*)       why="${why:+$why; }backslash" ;;
  esac
  if [ -n "$why" ]; then
    fail "tracked filename is unrepresentable - $why"
    note "[$f]"
    bad=$((bad + 1))
  fi
done
[ "$bad" -eq 0 ] && note "filenames: all portable"

# --- 2. executables that should carry a shebang -----------------------------
# Not fatal: informational, because a missing shebang is a real bug but this
# gate is about repository shape.
for f in "${tracked[@]}"; do
  case "$f" in
    *.sh) [ -f "$f" ] && head -c 2 "$f" | grep -q '#!' || note "no shebang: $f" ;;
  esac
done

# --- 3. CRLF smuggled into the working tree ---------------------------------
# A tracked file carrying CR bytes is how autocrlf damage announces itself.
crlf=0
for f in "${tracked[@]}"; do
  [ -f "$f" ] || continue
  case "$f" in
    *.png|*.ico|*.db|*.node|*.so|*.woff|*.woff2) continue ;;
    # Compiled/archived binaries. The Gradle wrapper ships a .jar, which is not
    # text at all; a byte scan for CR in it is meaningless and always "fails".
    *.jar) continue ;;
  esac
  if LC_ALL=C grep -qU $'\r' -- "$f" 2>/dev/null; then
    fail "CR bytes in a text file (CRLF damage?): $f"
    crlf=$((crlf + 1))
  fi
done
[ "$crlf" -eq 0 ] && note "line endings: clean"

# --- 4. .gitattributes must exist and pin eol ------------------------------
if [ ! -f .gitattributes ]; then
  fail "no .gitattributes: line endings would depend on core.autocrlf"
elif ! grep -q 'eol=lf' .gitattributes; then
  fail ".gitattributes does not pin eol=lf"
else
  note "gitattributes: present and pinning LF"
fi

# --- 5. nothing ignored by .gitignore may be tracked -----------------------
# A tracked file that .gitignore also matches means the ignore rule and the
# index disagree, which is how secrets end up in history.
leaked=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if git check-ignore -q -- "$f" 2>/dev/null; then
    fail "tracked but also matched by .gitignore: $f"
    leaked=$((leaked + 1))
  fi
done < <(git ls-files)
[ "$leaked" -eq 0 ] && note "index: agrees with .gitignore"

echo "---"
if [ "$status" -eq 0 ]; then
  echo "[check_repo] ok"
else
  echo "[check_repo] repository hygiene FAILED" >&2
fi
exit "$status"