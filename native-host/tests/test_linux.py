import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import download_butler_host as host


class LinuxDialogs(unittest.TestCase):
    def test_save(self):
        with patch.object(host.sys, "platform", "linux"), patch.object(host, "run_zenity", return_value="/tmp/a b.pdf") as dialog:
            self.assertEqual(host.choose_destination("a b.pdf", Path("/tmp")), "/tmp/a b.pdf")
            dialog.assert_called_once_with("--save", "--confirm-overwrite",
                "--title=Download Butler — Save download as", "--filename=/tmp/a b.pdf")

    def test_folder(self):
        with patch.object(host.sys, "platform", "linux"), patch.object(host, "run_zenity", return_value="/tmp") as dialog:
            self.assertEqual(host.choose_folder(Path("/tmp")), "/tmp")
            dialog.assert_called_once_with("--directory", "--title=Download Butler — Choose download folder", "--filename=/tmp/")

    def test_cancel_and_success(self):
        with patch.dict(os.environ, {"DISPLAY": ":0"}), patch.object(host.shutil, "which", return_value="/usr/bin/zenity"), patch.object(host.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 1, "", "")
            self.assertIsNone(host.run_zenity("--directory"))
            run.return_value = subprocess.CompletedProcess([], 0, "/tmp/a b\n", "")
            self.assertEqual(host.run_zenity("--directory"), "/tmp/a b")
            run.return_value = subprocess.CompletedProcess([], 2, "", "failure")
            with self.assertRaisesRegex(RuntimeError, "failure"):
                host.run_zenity("--directory")

    def test_mac_dispatch_unchanged(self):
        with patch.object(host.sys, "platform", "darwin"), patch.object(host, "choose_folder_macos", return_value="/tmp") as dialog:
            self.assertEqual(host.choose_folder(Path("/tmp")), "/tmp")
            dialog.assert_called_once_with(Path("/tmp"))


if __name__ == "__main__":
    unittest.main()
