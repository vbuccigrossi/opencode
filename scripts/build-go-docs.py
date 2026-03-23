#!/usr/bin/env python3
"""
Documentation Dataset Builder for RAG Indexing.

Generates structured markdown documentation files from Go packages
(stdlib and modules) for offline RAG consumption. Run this on the
target machine before air-gapped sessions.

Output structure:
    <output>/
        go-stdlib/
            net-http.md
            crypto-tls.md
        go-modules/
            github.com-gorilla-mux.md
        error-patterns/
            go-compilation-errors.md

Each file includes YAML-like frontmatter so the RAG metadata extractor
can detect it as documentation:

    ---
    type: documentation
    language: go
    package: net/http
    ---

Usage:
    python3 build-go-docs.py --output /home/user/work/.docs/ \\
        --packages net/http crypto/tls encoding/json \\
        --go-sum /path/to/project/go.sum \\
        --all-stdlib
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Go stdlib documentation
# ---------------------------------------------------------------------------

# Common stdlib packages to document if --all-stdlib is used
COMMON_STDLIB = [
    "archive/tar", "archive/zip",
    "bufio", "bytes",
    "compress/gzip",
    "context", "crypto", "crypto/aes", "crypto/cipher", "crypto/ecdsa",
    "crypto/ed25519", "crypto/hmac", "crypto/rand", "crypto/rsa",
    "crypto/sha256", "crypto/sha512", "crypto/subtle", "crypto/tls",
    "crypto/x509",
    "database/sql",
    "encoding", "encoding/base64", "encoding/binary", "encoding/csv",
    "encoding/gob", "encoding/hex", "encoding/json", "encoding/pem",
    "encoding/xml",
    "errors",
    "flag", "fmt",
    "hash", "hash/crc32",
    "html", "html/template",
    "io", "io/fs",
    "log", "log/slog",
    "math", "math/big", "math/rand",
    "mime", "mime/multipart",
    "net", "net/http", "net/http/httptest", "net/http/httputil",
    "net/mail", "net/smtp", "net/url",
    "os", "os/exec", "os/signal",
    "path", "path/filepath",
    "reflect", "regexp",
    "runtime", "runtime/debug",
    "sort", "strconv", "strings", "sync", "sync/atomic",
    "testing", "text/template", "time",
    "unicode", "unicode/utf8",
]


def run_go_doc(package: str, all_symbols: bool = True) -> Optional[str]:
    """
    Run `go doc` for a package and return its output.

    Parameters
    ----------
    package : str
        Go package import path (e.g., 'net/http').
    all_symbols : bool
        If True, pass -all to include all exported symbols.

    Returns
    -------
    str or None
        The go doc output, or None on failure.
    """
    cmd = ["go", "doc"]
    if all_symbols:
        cmd.append("-all")
    cmd.append(package)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout
        return None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def build_package_summary(package: str) -> Optional[str]:
    """
    Build a structured markdown document for a Go package.

    Combines `go doc <pkg>` (short) with `go doc -all <pkg>` (full)
    into a single markdown file with YAML frontmatter.

    Parameters
    ----------
    package : str
        Go package import path.

    Returns
    -------
    str or None
        Formatted markdown content, or None if go doc fails.
    """
    short_doc = run_go_doc(package, all_symbols=False)
    full_doc = run_go_doc(package, all_symbols=True)

    if not short_doc and not full_doc:
        return None

    safe_name = package.replace("/", "-")
    lines = [
        "---",
        "type: documentation",
        "language: go",
        f"package: {package}",
        "---",
        "",
        f"# Go Package: {package}",
        "",
    ]

    if short_doc:
        lines.extend([
            "## Overview",
            "",
            short_doc.strip(),
            "",
        ])

    if full_doc and full_doc != short_doc:
        lines.extend([
            "## Functions",
            "",
            full_doc.strip(),
            "",
        ])

    return "\n".join(lines)


def extract_go_stdlib_docs(
    packages: list[str],
    output_dir: Path,
) -> int:
    """
    Generate documentation files for Go stdlib packages.

    Parameters
    ----------
    packages : list[str]
        List of Go package import paths.
    output_dir : Path
        Base output directory (files go into go-stdlib/ subdirectory).

    Returns
    -------
    int
        Number of packages successfully documented.
    """
    stdlib_dir = output_dir / "go-stdlib"
    stdlib_dir.mkdir(parents=True, exist_ok=True)

    count = 0
    for pkg in packages:
        print(f"  Documenting stdlib: {pkg} ...", end=" ", flush=True)
        content = build_package_summary(pkg)
        if content:
            safe_name = pkg.replace("/", "-")
            out_file = stdlib_dir / f"{safe_name}.md"
            out_file.write_text(content, encoding="utf-8")
            print("OK")
            count += 1
        else:
            print("SKIP (no docs)")

    return count


def extract_go_module_docs(
    go_sum_path: Path,
    output_dir: Path,
) -> int:
    """
    Extract documentation for Go modules listed in go.sum.

    Looks for README files in the Go module cache
    ($GOPATH/pkg/mod or ~/go/pkg/mod).

    Parameters
    ----------
    go_sum_path : Path
        Path to go.sum file.
    output_dir : Path
        Base output directory (files go into go-modules/ subdirectory).

    Returns
    -------
    int
        Number of modules successfully documented.
    """
    modules_dir = output_dir / "go-modules"
    modules_dir.mkdir(parents=True, exist_ok=True)

    if not go_sum_path.exists():
        print(f"  Warning: go.sum not found at {go_sum_path}")
        return 0

    # Parse go.sum for module paths and versions
    modules: dict[str, str] = {}
    with open(go_sum_path, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split()
            if len(parts) >= 2:
                mod_path = parts[0]
                version = parts[1].split("/")[0]  # strip /go.mod suffix
                if mod_path not in modules:
                    modules[mod_path] = version

    # Find Go module cache
    gopath = os.environ.get("GOPATH", os.path.expanduser("~/go"))
    mod_cache = Path(gopath) / "pkg" / "mod"

    if not mod_cache.exists():
        print(f"  Warning: Go module cache not found at {mod_cache}")
        return 0

    count = 0
    for mod_path, version in modules.items():
        # Module cache uses lowercase + escaped paths
        cache_dir = mod_cache / _escape_module_path(mod_path + "@" + version)

        if not cache_dir.exists():
            continue

        # Look for README
        readme_content = None
        for readme_name in ["README.md", "README", "README.txt", "readme.md"]:
            readme_path = cache_dir / readme_name
            if readme_path.exists():
                try:
                    readme_content = readme_path.read_text(encoding="utf-8")
                except Exception:
                    pass
                break

        if not readme_content:
            continue

        safe_name = mod_path.replace("/", "-")
        content = "\n".join([
            "---",
            "type: documentation",
            "language: go",
            f"package: {mod_path}",
            f"version: {version}",
            "---",
            "",
            f"# Go Module: {mod_path} ({version})",
            "",
            readme_content.strip(),
            "",
        ])

        out_file = modules_dir / f"{safe_name}.md"
        out_file.write_text(content, encoding="utf-8")
        count += 1

    print(f"  Documented {count} Go modules from go.sum")
    return count


def _escape_module_path(mod_path: str) -> str:
    """
    Escape a Go module path for the module cache directory.

    Go module cache uses '!' prefix for uppercase letters.

    Parameters
    ----------
    mod_path : str
        Module path with version.

    Returns
    -------
    str
        Escaped path suitable for filesystem lookup.
    """
    result = []
    for ch in mod_path:
        if ch.isupper():
            result.append("!")
            result.append(ch.lower())
        else:
            result.append(ch)
    return "".join(result)


# ---------------------------------------------------------------------------
# Error pattern documentation
# ---------------------------------------------------------------------------

# Common Go compilation errors with explanations
GO_ERROR_PATTERNS = [
    {
        "error": "undefined: X",
        "cause": "Symbol X is not defined in the current scope or imported package.",
        "fix": "Check the import statement, verify the symbol is exported (starts with uppercase), "
               "and confirm the package version contains this symbol.",
    },
    {
        "error": "cannot use X (type T1) as type T2",
        "cause": "Type mismatch in assignment, function argument, or return value.",
        "fix": "Check the expected type signature. Use type assertion or conversion "
               "(e.g., T2(x)) if types are compatible.",
    },
    {
        "error": "imported and not used: \"pkg\"",
        "cause": "A package is imported but no exported symbol from it is referenced.",
        "fix": "Either use a symbol from the package or remove the import. "
               "Use _ alias (import _ \"pkg\") for side-effect-only imports.",
    },
    {
        "error": "too many arguments in call to F",
        "cause": "Function F was called with more arguments than its signature accepts.",
        "fix": "Check the function signature with `go doc pkg.F` and match the argument count.",
    },
    {
        "error": "not enough arguments in call to F",
        "cause": "Function F was called with fewer arguments than required.",
        "fix": "Check the function signature with `go doc pkg.F` and provide all required arguments.",
    },
    {
        "error": "cannot convert X (type T1) to type T2",
        "cause": "Go does not allow direct conversion between these types.",
        "fix": "Check if an intermediate conversion exists (e.g., string → []byte → other). "
               "For interface conversions, use type assertion x.(T2).",
    },
    {
        "error": "multiple-value F() in single-value context",
        "cause": "A function returning (value, error) is used where only one value is expected.",
        "fix": "Capture both return values: val, err := F(). Handle the error explicitly.",
    },
    {
        "error": "X is not a type",
        "cause": "X was used as a type but is actually a variable, function, or constant.",
        "fix": "Check the definition of X. You may need the type name, not the constructor.",
    },
    {
        "error": "cannot assign to X",
        "cause": "Attempting to assign to a read-only value (constant, map value field, etc.).",
        "fix": "For map values, assign a new struct: m[key] = newStruct. "
               "For constants, use a variable instead.",
    },
    {
        "error": "declared and not used: X",
        "cause": "Variable X is declared but never referenced.",
        "fix": "Either use the variable or replace it with _ if the value is intentionally discarded.",
    },
]


def generate_error_patterns(output_dir: Path) -> int:
    """
    Generate an error patterns documentation file for RAG indexing.

    Creates a markdown file mapping common compilation errors to their
    causes and fixes, structured for search retrieval.

    Parameters
    ----------
    output_dir : Path
        Base output directory (file goes into error-patterns/ subdirectory).

    Returns
    -------
    int
        Number of error patterns written.
    """
    errors_dir = output_dir / "error-patterns"
    errors_dir.mkdir(parents=True, exist_ok=True)

    lines = [
        "---",
        "type: documentation",
        "language: go",
        "package: compiler-errors",
        "---",
        "",
        "# Go Compilation Error Reference",
        "",
        "Common Go compiler errors with causes and fixes.",
        "",
    ]

    for pattern in GO_ERROR_PATTERNS:
        lines.extend([
            f"## Error: `{pattern['error']}`",
            "",
            f"**Cause:** {pattern['cause']}",
            "",
            f"**Fix:** {pattern['fix']}",
            "",
        ])

    out_file = errors_dir / "go-compilation-errors.md"
    out_file.write_text("\n".join(lines), encoding="utf-8")
    print(f"  Generated {len(GO_ERROR_PATTERNS)} error patterns")
    return len(GO_ERROR_PATTERNS)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    """
    Parse command-line arguments.

    Returns
    -------
    argparse.Namespace
        Parsed arguments.
    """
    parser = argparse.ArgumentParser(
        description="Generate Go package documentation for RAG indexing.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Document specific packages
  python3 build-go-docs.py --output ~/.docs/ --packages net/http crypto/tls

  # Document all common stdlib packages
  python3 build-go-docs.py --output ~/.docs/ --all-stdlib

  # Document project dependencies from go.sum
  python3 build-go-docs.py --output ~/.docs/ --go-sum ./go.sum

  # Full pipeline: stdlib + modules + error patterns
  python3 build-go-docs.py --output ~/work/.docs/ --all-stdlib \\
      --go-sum ~/project/go.sum --error-patterns
        """,
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output directory for generated documentation files.",
    )
    parser.add_argument(
        "--packages",
        nargs="*",
        default=[],
        help="Specific Go packages to document (e.g., net/http crypto/tls).",
    )
    parser.add_argument(
        "--all-stdlib",
        action="store_true",
        help="Document all common Go stdlib packages.",
    )
    parser.add_argument(
        "--go-sum",
        type=Path,
        default=None,
        help="Path to go.sum file for module documentation.",
    )
    parser.add_argument(
        "--error-patterns",
        action="store_true",
        help="Generate Go error pattern documentation.",
    )
    return parser.parse_args()


def main() -> None:
    """Main entry point for the documentation builder."""
    args = parse_args()

    output_dir: Path = args.output
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Documentation output: {output_dir}")
    print()

    total = 0

    # Determine which stdlib packages to document
    stdlib_packages = list(args.packages)
    if args.all_stdlib:
        # Merge explicit packages with the common set (dedup)
        seen = set(stdlib_packages)
        for pkg in COMMON_STDLIB:
            if pkg not in seen:
                stdlib_packages.append(pkg)
                seen.add(pkg)

    if stdlib_packages:
        print(f"[1/3] Documenting {len(stdlib_packages)} Go stdlib packages...")
        count = extract_go_stdlib_docs(stdlib_packages, output_dir)
        total += count
        print(f"  → {count} packages documented")
        print()
    else:
        print("[1/3] No stdlib packages requested, skipping.")
        print()

    if args.go_sum:
        print(f"[2/3] Extracting Go module docs from {args.go_sum}...")
        count = extract_go_module_docs(args.go_sum, output_dir)
        total += count
        print()
    else:
        print("[2/3] No go.sum provided, skipping module docs.")
        print()

    if args.error_patterns:
        print("[3/3] Generating error pattern documentation...")
        count = generate_error_patterns(output_dir)
        total += count
        print()
    else:
        print("[3/3] Error patterns not requested, skipping.")
        print()

    print(f"Done. {total} documentation entries generated in {output_dir}")
    print()
    print("Next steps:")
    print(f"  1. Ensure {output_dir} is within a configured RAG source directory")
    print("  2. Delete the RAG manifest to force re-indexing:")
    print("     rm ~/.local/share/opencode/rag-manifest.json")
    print("  3. Start opencode — RAG will auto-index the new docs")


if __name__ == "__main__":
    main()
