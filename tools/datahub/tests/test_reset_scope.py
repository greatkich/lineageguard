from __future__ import annotations

import pytest

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.reset import ResetPolicyError, build_reset_plan, execute_reset


class RecordingDeleter:
    def __init__(self) -> None:
        self.deleted: list[tuple[str, bool]] = []

    def delete_entity(self, urn: str, hard: bool = False) -> None:
        self.deleted.append((urn, hard))


def test_reset_refuses_non_canonical_environment(expected_graph: ExpectedGraph) -> None:
    with pytest.raises(ResetPolicyError, match="CANONICAL_ENV_REQUIRED"):
        build_reset_plan(
            expected_graph,
            environment_gate="production",
            platform_instance=expected_graph.platform_instance,
        )


def test_reset_refuses_other_platform_instance(expected_graph: ExpectedGraph) -> None:
    with pytest.raises(ResetPolicyError, match="PLATFORM_INSTANCE_MISMATCH"):
        build_reset_plan(
            expected_graph,
            environment_gate="canonical",
            platform_instance="shared",
        )


def test_reset_deletes_only_manifest_urns_as_soft_deletes(expected_graph: ExpectedGraph) -> None:
    plan = build_reset_plan(
        expected_graph,
        environment_gate="canonical",
        platform_instance=expected_graph.platform_instance,
    )
    deleter = RecordingDeleter()
    receipt = execute_reset(deleter, plan)
    assert set(receipt.deleted_urns) == set(expected_graph.managed_urns)
    assert deleter.deleted == [(urn, False) for urn in plan.urns]
