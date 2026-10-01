"""Kernels run as the API's OS user: the API process must not be readable by them
through /proc/<pid>/environ (docs/design/spe-security.md §1)."""

import sys

import pytest

from app.core import hardening


def test_never_fails_and_is_a_no_op_off_linux():
    applied = hardening.forbid_same_user_inspection()
    assert applied is sys.platform.startswith("linux")


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="prctl is Linux-only")
def test_the_process_is_no_longer_dumpable():
    hardening.forbid_same_user_inspection()
    assert hardening.is_dumpable() is False


def test_a_failing_prctl_is_logged_not_raised(monkeypatch):
    monkeypatch.setattr(hardening.sys, "platform", "linux")

    def broken():
        raise OSError("no libc")

    monkeypatch.setattr(hardening, "_libc", broken)
    assert hardening.forbid_same_user_inspection() is False
