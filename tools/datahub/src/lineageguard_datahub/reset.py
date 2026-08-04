from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from lineageguard_datahub.models import ExpectedGraph


class ResetPolicyError(ValueError):
    """Reset was not authorized for the exact canonical environment."""


class EntityDeleter(Protocol):
    def delete_entity(self, urn: str, hard: bool = False) -> None: ...


@dataclass(frozen=True, slots=True)
class ResetPlan:
    scenario_id: str
    urns: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ResetReceipt:
    scenario_id: str
    deleted_urns: tuple[str, ...]


def build_reset_plan(
    graph: ExpectedGraph,
    *,
    environment_gate: str | None,
    platform_instance: str | None,
) -> ResetPlan:
    if environment_gate != "canonical":
        raise ResetPolicyError("CANONICAL_ENV_REQUIRED")
    if platform_instance != graph.platform_instance:
        raise ResetPolicyError("PLATFORM_INSTANCE_MISMATCH")
    return ResetPlan(scenario_id=graph.scenario_id, urns=tuple(reversed(graph.managed_urns)))


def execute_reset(deleter: EntityDeleter, plan: ResetPlan) -> ResetReceipt:
    for urn in plan.urns:
        deleter.delete_entity(urn, hard=False)
    return ResetReceipt(plan.scenario_id, plan.urns)
