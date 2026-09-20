# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

"""Offline regression tests for release metadata: python3 -m unittest discover -s scripts."""

import argparse
import hashlib
import pathlib
import subprocess
import sys
import tempfile
import unittest

import models


class ReleaseManifestTests(unittest.TestCase):
    def test_valid_release_tags(self):
        for version, tag in (
            ("0.2.3", "v0.2.3"),
            ("0.2.3", "v0.2.3-alpha.0"),
            ("0.2.3", "v0.2.3-alpha.10+build.001"),
            ("0.2.3", "v0.2.3-01alpha"),
            ("0.2.3-alpha.1", "v0.2.3-alpha.1"),
            ("0.2.3+build-name", "v0.2.3+build-name"),
        ):
            with self.subTest(tag=tag):
                models.validate_release_tag(version, tag)

    def test_invalid_or_mismatched_release_tags(self):
        for tag in (
            "v0.2.3-", "v0.2.3-alpha..1", "v0.2.3-alpha.01", "v0.2.3-01",
            "v0.2.3-α", "v0.2.3-alpha/1", "v0.2.3-alpha_1", "v0.2.3-alpha+",
            "v0.2.3-alpha\n", "v00.2.3", "v0.2.03", "v0.2", "v0.2.4",
            "0.2.3", "v0.2.3+unexpected", "v18446744073709551616.2.3",
        ):
            with self.subTest(tag=tag):
                with self.assertRaises(ValueError):
                    models.validate_release_tag("0.2.3", tag)

    def test_manifest_rejects_unparseable_release_tag(self):
        with self.assertRaises(ValueError):
            models.release_manifest("0.2.3", "v0.2.3-alpha.01", None)

    def test_release_validation_cli_reports_error_without_traceback(self):
        result = subprocess.run(
            [sys.executable, str(models.ROOT / "scripts/models.py"), "validate-release",
             "--version", "0.2.3", "--tag", "v0.2.3-alpha.01"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("leading zero", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_default_repository_is_upstream(self):
        manifest = models.release_manifest("0.2.3", "v0.2.3", None)
        self.assertEqual(manifest["repository"], models.REPO)
        self.assertEqual(manifest["schema"], 2)
        self.assertEqual(len(manifest["binaries"]), 5)
        for platform in manifest["binaries"].values():
            for arch in platform.values():
                for bundle in arch.values():
                    self.assertTrue(bundle["url"].startswith(
                        "https://github.com/jub0t/Concat/releases/download/v0.2.3/"
                    ))

    def test_fork_app_urls_do_not_move_model_mirror(self):
        upstream = models.release_manifest("0.2.3", "v0.2.3", None)
        fork = models.release_manifest("0.2.3", "v0.2.3", None, "Mehdidjah/Concat-app")
        self.assertEqual(fork["models"], upstream["models"])
        self.assertEqual(fork["models_release"], upstream["models_release"])
        for platform in fork["binaries"].values():
            for arch in platform.values():
                for bundle in arch.values():
                    self.assertTrue(bundle["url"].startswith(
                        "https://github.com/Mehdidjah/Concat-app/releases/download/v0.2.3/"
                    ))

    def test_prerelease_tag_keeps_workspace_version_in_asset_name(self):
        manifest = models.release_manifest("0.2.3", "v0.2.3-alpha.2", None)
        bundle = manifest["binaries"]["android"]["arm64"]["apk"]
        self.assertEqual(bundle["file"], "Concat-0.2.3-android-arm64.apk")
        self.assertIn("/v0.2.3-alpha.2/", bundle["url"])

    def test_only_present_artifacts_are_advertised_with_digest_and_size(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            content = b"test installer bytes"
            name = "Concat-0.2.3-windows-x86_64-setup.exe"
            (directory / name).write_bytes(content)
            manifest = models.release_manifest("0.2.3", "v0.2.3", directory, "Example/Fork")
            self.assertEqual(list(manifest["binaries"]), ["windows"])
            self.assertEqual(list(manifest["binaries"]["windows"]), ["x86_64"])
            self.assertEqual(list(manifest["binaries"]["windows"]["x86_64"]), ["setup"])
            bundle = manifest["binaries"]["windows"]["x86_64"]["setup"]
            self.assertEqual(bundle["bytes"], len(content))
            self.assertEqual(bundle["sha256"], hashlib.sha256(content).hexdigest())

    def test_repository_rejects_hosts_paths_and_query_strings(self):
        for repository in ("https://github.com/a/b", "a/b/c", "../b", "a/..", "a/b?x=1", "a/b#x", "a\\b", "a/b\n"):
            with self.subTest(repository=repository):
                with self.assertRaises(argparse.ArgumentTypeError):
                    models.release_manifest("0.2.3", "v0.2.3", None, repository)

    def test_cli_validates_repository_before_generating_manifest(self):
        result = subprocess.run(
            [sys.executable, str(models.ROOT / "scripts/models.py"), "release-manifest",
             "--version", "0.2.3", "--tag", "v0.2.3", "--repository", "https://example.com"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("owner/name", result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
