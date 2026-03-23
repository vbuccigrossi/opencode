#!/usr/bin/env python3
"""
Tests for the Go documentation dataset builder.

Verifies package summary generation, output file structure,
YAML frontmatter, and error pattern documentation.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Import from build-go-docs.py (hyphenated filename requires importlib)
import importlib.util

_script_path = str(Path(__file__).parent / "build-go-docs.py")
_spec = importlib.util.spec_from_file_location("build_go_docs", _script_path)
assert _spec and _spec.loader
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

GO_ERROR_PATTERNS = _mod.GO_ERROR_PATTERNS
build_package_summary = _mod.build_package_summary
extract_go_stdlib_docs = _mod.extract_go_stdlib_docs
generate_error_patterns = _mod.generate_error_patterns
_escape_module_path = _mod._escape_module_path


class TestBuildPackageSummary(unittest.TestCase):
    """Tests for build_package_summary()."""

    def test_known_stdlib_package(self) -> None:
        """build_package_summary returns content for a known stdlib package (fmt)."""
        # Skip if go is not installed
        if shutil.which("go") is None:
            self.skipTest("go not installed")

        content = build_package_summary("fmt")
        self.assertIsNotNone(content, "fmt should produce documentation")
        assert content is not None  # for type checker

        # Verify YAML frontmatter
        self.assertTrue(content.startswith("---"), "Should start with YAML frontmatter")
        self.assertIn("type: documentation", content)
        self.assertIn("language: go", content)
        self.assertIn("package: fmt", content)

        # Verify content structure
        self.assertIn("# Go Package: fmt", content)
        self.assertIn("## Overview", content)
        # fmt should have Println, Sprintf, etc.
        self.assertIn("Println", content)

    def test_nonexistent_package(self) -> None:
        """build_package_summary returns None for a nonexistent package."""
        if shutil.which("go") is None:
            self.skipTest("go not installed")

        content = build_package_summary("nonexistent/fake/package12345")
        self.assertIsNone(content)

    def test_net_http_package(self) -> None:
        """build_package_summary handles net/http (a large package)."""
        if shutil.which("go") is None:
            self.skipTest("go not installed")

        content = build_package_summary("net/http")
        self.assertIsNotNone(content)
        assert content is not None

        self.assertIn("package: net/http", content)
        self.assertIn("# Go Package: net/http", content)


class TestExtractGoStdlibDocs(unittest.TestCase):
    """Tests for extract_go_stdlib_docs()."""

    def setUp(self) -> None:
        """Create a temporary output directory."""
        self.output_dir = Path(tempfile.mkdtemp(prefix="go-docs-test-"))

    def tearDown(self) -> None:
        """Clean up temporary directory."""
        shutil.rmtree(self.output_dir, ignore_errors=True)

    def test_creates_stdlib_directory(self) -> None:
        """Output directory structure: go-stdlib/ is created."""
        if shutil.which("go") is None:
            self.skipTest("go not installed")

        extract_go_stdlib_docs(["fmt"], self.output_dir)
        stdlib_dir = self.output_dir / "go-stdlib"
        self.assertTrue(stdlib_dir.exists(), "go-stdlib/ directory should be created")

    def test_generates_expected_file(self) -> None:
        """Correct file naming: fmt → go-stdlib/fmt.md."""
        if shutil.which("go") is None:
            self.skipTest("go not installed")

        count = extract_go_stdlib_docs(["fmt"], self.output_dir)
        self.assertGreater(count, 0, "Should document at least one package")

        expected_file = self.output_dir / "go-stdlib" / "fmt.md"
        self.assertTrue(expected_file.exists(), "fmt.md should be created")

    def test_slashed_package_names(self) -> None:
        """Slashed packages like net/http → net-http.md."""
        if shutil.which("go") is None:
            self.skipTest("go not installed")

        extract_go_stdlib_docs(["net/http"], self.output_dir)
        expected_file = self.output_dir / "go-stdlib" / "net-http.md"
        self.assertTrue(expected_file.exists(), "net-http.md should be created")

    def test_frontmatter_parseable(self) -> None:
        """YAML frontmatter in generated files is properly structured."""
        if shutil.which("go") is None:
            self.skipTest("go not installed")

        extract_go_stdlib_docs(["fmt"], self.output_dir)
        content = (self.output_dir / "go-stdlib" / "fmt.md").read_text()

        # Parse frontmatter manually (avoid yaml dependency)
        self.assertTrue(content.startswith("---\n"))
        end_idx = content.index("---", 4)
        frontmatter = content[4:end_idx].strip()

        fm_dict = {}
        for line in frontmatter.split("\n"):
            if ":" in line:
                key, val = line.split(":", 1)
                fm_dict[key.strip()] = val.strip()

        self.assertEqual(fm_dict.get("type"), "documentation")
        self.assertEqual(fm_dict.get("language"), "go")
        self.assertEqual(fm_dict.get("package"), "fmt")


class TestGenerateErrorPatterns(unittest.TestCase):
    """Tests for generate_error_patterns()."""

    def setUp(self) -> None:
        """Create a temporary output directory."""
        self.output_dir = Path(tempfile.mkdtemp(prefix="go-docs-test-"))

    def tearDown(self) -> None:
        """Clean up temporary directory."""
        shutil.rmtree(self.output_dir, ignore_errors=True)

    def test_creates_error_patterns_directory(self) -> None:
        """error-patterns/ directory is created."""
        generate_error_patterns(self.output_dir)
        errors_dir = self.output_dir / "error-patterns"
        self.assertTrue(errors_dir.exists())

    def test_generates_compilation_errors_file(self) -> None:
        """go-compilation-errors.md is created."""
        generate_error_patterns(self.output_dir)
        expected = self.output_dir / "error-patterns" / "go-compilation-errors.md"
        self.assertTrue(expected.exists())

    def test_contains_all_patterns(self) -> None:
        """All GO_ERROR_PATTERNS appear in the output."""
        generate_error_patterns(self.output_dir)
        content = (self.output_dir / "error-patterns" / "go-compilation-errors.md").read_text()

        for pattern in GO_ERROR_PATTERNS:
            self.assertIn(pattern["error"], content,
                          f"Missing error pattern: {pattern['error']}")

    def test_has_frontmatter(self) -> None:
        """YAML frontmatter with type: documentation is present."""
        generate_error_patterns(self.output_dir)
        content = (self.output_dir / "error-patterns" / "go-compilation-errors.md").read_text()

        self.assertTrue(content.startswith("---\n"))
        self.assertIn("type: documentation", content)
        self.assertIn("language: go", content)
        self.assertIn("package: compiler-errors", content)

    def test_returns_pattern_count(self) -> None:
        """Return value matches GO_ERROR_PATTERNS count."""
        count = generate_error_patterns(self.output_dir)
        self.assertEqual(count, len(GO_ERROR_PATTERNS))


class TestEscapeModulePath(unittest.TestCase):
    """Tests for _escape_module_path()."""

    def test_lowercase_unchanged(self) -> None:
        """All-lowercase paths are unchanged."""
        self.assertEqual(
            _escape_module_path("github.com/user/repo@v1.0.0"),
            "github.com/user/repo@v1.0.0",
        )

    def test_uppercase_escaped(self) -> None:
        """Uppercase letters get ! prefix and lowercased."""
        self.assertEqual(
            _escape_module_path("github.com/Azure/sdk@v1.0.0"),
            "github.com/!azure/sdk@v1.0.0",
        )

    def test_mixed_case(self) -> None:
        """Mixed case paths are properly escaped."""
        self.assertEqual(
            _escape_module_path("github.com/GorillaToolkit/Mux@v1.8.0"),
            "github.com/!gorilla!toolkit/!mux@v1.8.0",
        )


if __name__ == "__main__":
    unittest.main()
