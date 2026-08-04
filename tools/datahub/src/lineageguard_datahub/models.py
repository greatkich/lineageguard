from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class EntityType(StrEnum):
    DATASET = "DATASET"
    DASHBOARD = "DASHBOARD"
    MLMODEL = "MLMODEL"


class Granularity(StrEnum):
    FIELD = "FIELD"
    ENTITY = "ENTITY"


@dataclass(frozen=True, slots=True)
class SourceField:
    logical_key: str
    dataset_urn: str
    field_path: str
    schema_field_urn: str
    glossary_term_urn: str


@dataclass(frozen=True, slots=True)
class Owner:
    logical_key: str
    urn: str
    display_name: str


@dataclass(frozen=True, slots=True)
class Tag:
    logical_key: str
    urn: str
    display_name: str


@dataclass(frozen=True, slots=True)
class GraphNode:
    logical_key: str
    urn: str
    entity_type: EntityType
    name: str
    owner_urns: tuple[str, ...]
    tag_urns: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class LineageEdge:
    logical_key: str
    upstream_urn: str
    downstream_urn: str
    upstream_type: EntityType
    downstream_type: EntityType
    granularity: Granularity
    upstream_field_path: str | None
    downstream_field_path: str | None


@dataclass(frozen=True, slots=True)
class QueryEvidence:
    logical_key: str
    query_urn: str
    marker: str
    sql_path: str
    dataset_urn: str
    field_path: str
    sha256: str
    owner_urn: str


@dataclass(frozen=True, slots=True)
class ExpectedGraph:
    schema_version: int
    scenario_id: str
    environment: str
    platform_instance: str
    source_field: SourceField
    owners: tuple[Owner, ...]
    tags: tuple[Tag, ...]
    nodes: tuple[GraphNode, ...]
    edges: tuple[LineageEdge, ...]
    query_evidence: tuple[QueryEvidence, ...]
    impact_cards: tuple[str, ...]
    lineage_intermediates: tuple[str, ...]

    @property
    def managed_urns(self) -> tuple[str, ...]:
        """Every entity URN the canonical seeder is allowed to mutate or remove."""
        urns = {
            self.source_field.glossary_term_urn,
            *(owner.urn for owner in self.owners),
            *(tag.urn for tag in self.tags),
            *(node.urn for node in self.nodes),
            *(query.query_urn for query in self.query_evidence),
        }
        return tuple(sorted(urns))
