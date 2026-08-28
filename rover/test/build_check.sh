#!/usr/bin/env bash
# Type-checks the firmware without an Arduino toolchain.
#
# There is no arduino-cli on the Pi this project is developed from, so main.ino
# would otherwise reach the board having never been through a compiler. This
# compiles it as ordinary C++ against thin stubs of the four libraries it uses
# (test/stubs/), which catches every syntax error, typo and type mismatch in our
# own code. What it CANNOT catch is anything about the real libraries' actual
# signatures or the hardware -- treat a pass as "this will probably compile",
# not as "this works".
#
# Also builds and runs the core unit tests, which are the real verification.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=${TMPDIR:-/tmp}

echo "== core unit tests =="
g++ -std=c++17 -O2 -Wall -Wextra -o "$OUT/rover_test_core" rover/test/test_core.cpp
"$OUT/rover_test_core"

echo
echo "== firmware type check =="
# .ino is not a C++ extension the compiler recognises, so point it at the file
# explicitly with -x c++.
g++ -std=c++17 -fsyntax-only -Wall -Wextra \
    -I rover/test/stubs -I rover \
    -x c++ rover/main.ino
echo "main.ino type-checks clean"
