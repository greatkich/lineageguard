PINNED_DATAHUB_VERSION = "1.6.0"


def runtime_is_supported(version: tuple[int, int, int]) -> bool:
    return version[:2] == (3, 12)
