"""Package-spec allowlist: the guard that stops R/shell injection via package
names. These refs are fed to `Rscript -e` source (renv) and `uv` argv, so an
unescaped metacharacter is an RCE vector — the validator must reject anything
outside a strict `name[==version]` allowlist."""

import pytest

from app.services.execution.package_spec import (
    InvalidPackageSpec,
    validate_package_spec,
    validate_package_specs,
)


@pytest.mark.parametrize(
    "spec",
    [
        "pandas",
        "numpy==1.26.0",
        "scipy>=1.10",
        "requests!=2.0",
        "dplyr@1.1.4",
        "scikit-learn",
        "data.table",
        "  ggplot2  ",  # surrounding whitespace tolerated
    ],
)
def test_valid_specs_pass(spec):
    validate_package_spec(spec)  # does not raise


@pytest.mark.parametrize(
    "spec",
    [
        # R-code injection payloads (the RCE vector)
        'x"); system("id"); ("',
        "x'); system('id'); ('",
        "foo`whoami`",
        "foo; rm -rf ~",
        "foo\nbar",
        "foo)",
        "foo#comment",
        # shell/flag metacharacters + empties
        "--config-settings=x",
        "-rf",
        "foo bar",
        "",
        "   ",
        "==1.0",  # empty name
        "pandas==1.0; drop",  # metachar in version
    ],
)
def test_injection_and_malformed_specs_rejected(spec):
    with pytest.raises(InvalidPackageSpec):
        validate_package_spec(spec)


def test_validate_list_raises_on_first_bad():
    with pytest.raises(InvalidPackageSpec):
        validate_package_specs(["pandas", 'evil"); system("id"); ("', "numpy"])


def test_validate_list_returns_stripped():
    assert validate_package_specs([" pandas ", "numpy==1.26"]) == [
        "pandas",
        "numpy==1.26",
    ]
