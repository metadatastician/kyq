# SPDX-License-Identifier: MPL-2.0
#
# A small Agda lexer for the proof runner's scans (PROOF-POLICY §8.4 rule
# 7: the postulate scan must lex comments, string and character literals
# and pragma bodies as Agda does).  It reads one file and prints either
#
#   mode=code    every source line as FILE:LINE:TEXT, with nested block
#                comments {- -} and line comments -- removed, string and
#                character literal contents removed, and pragmas removed
#   mode=pragma  every pragma {-# ... #-} as FILE:LINE:BODY, whitespace
#                normalised to single spaces
#
# Line numbers are preserved.  An unterminated comment, pragma or string
# is an error (exit 3): the scan fails closed rather than guess.
#
#   awk -v mode=code -v fname=F -f agda-lex.awk F
{ buf = buf $0 "\n" }

function die(msg) { printf "%s:%d: agda-lex: %s\n", fname, line, msg > "/dev/stderr"; bad = 1; exit 3 }

# A line comment or a character literal starts only at the start of a
# token: Agda names may contain '-' and '\'' (foo--bar and swap' are names).
function tokstart(k,  p) {
  if (k == 1) return 1
  p = substr(buf, k - 1, 1)
  return (p ~ /[ \t\n(){};."@]/)
}

END {
  if (bad) exit 3
  n = length(buf); i = 1; line = 1; out = ""
  while (i <= n) {
    c = substr(buf, i, 1); c2 = substr(buf, i, 2); c3 = substr(buf, i, 3)
    if (c3 == "{-#") {
      j = i + 3; body = ""; pl = line
      while (j <= n && substr(buf, j, 3) != "#-}") {
        ch = substr(buf, j, 1)
        if (ch == "\n") { line++; out = out "\n"; ch = " " }
        body = body ch; j++
      }
      if (j > n) die("unterminated pragma")
      gsub(/[ \t]+/, " ", body); sub(/^ /, "", body); sub(/ $/, "", body)
      if (mode == "pragma") print fname ":" pl ":" body
      out = out " "; i = j + 3; continue
    }
    if (c2 == "{-") {
      depth = 1; j = i + 2
      while (j <= n && depth > 0) {
        d2 = substr(buf, j, 2)
        if (d2 == "{-") { depth++; j += 2; continue }
        if (d2 == "-}") { depth--; j += 2; continue }
        if (substr(buf, j, 1) == "\n") { line++; out = out "\n" }
        j++
      }
      if (depth > 0) die("unterminated block comment")
      out = out " "; i = j; continue
    }
    if (c2 == "--" && tokstart(i)) {
      while (i <= n && substr(buf, i, 1) != "\n") i++
      continue
    }
    if (c == "\"") {
      j = i + 1
      while (j <= n) {
        ch = substr(buf, j, 1)
        if (ch == "\\") { j += 2; continue }
        if (ch == "\"") break
        if (ch == "\n") die("newline in a string literal")
        j++
      }
      if (j > n) die("unterminated string literal")
      out = out "\"\""; i = j + 1; continue
    }
    if (c == "'" && tokstart(i)) {
      j = i + 1
      if (substr(buf, j, 1) == "\\") j += 2; else j++
      while (j <= n && j <= i + 8 && substr(buf, j, 1) != "'" && substr(buf, j, 1) != "\n") j++
      if (substr(buf, j, 1) == "'") { out = out "''"; i = j + 1; continue }
    }
    if (c == "\n") line++
    out = out c; i++
  }
  if (mode == "code") {
    k = split(out, L, "\n")
    for (m = 1; m < k; m++) print fname ":" m ":" L[m]
  }
}
