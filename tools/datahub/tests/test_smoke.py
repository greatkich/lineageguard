from lineageguard_datahub.version_policy import PINNED_DATAHUB_VERSION, runtime_is_supported


def test_python_and_datahub_policy() -> None:
    assert runtime_is_supported((3, 12, 13))
    assert not runtime_is_supported((3, 11, 9))
    assert PINNED_DATAHUB_VERSION == "1.6.0"
