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


class OwnershipType(StrEnum):
    BUSINESS_OWNER = "BUSINESS_OWNER"
    TECHNICAL_OWNER = "TECHNICAL_OWNER"


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
    description: str


@dataclass(frozen=True, slots=True)
class Domain:
    logical_key: str
    urn: str
    display_name: str
    description: str


@dataclass(frozen=True, slots=True)
class GraphNode:
    logical_key: str
    urn: str
    entity_type: EntityType
    name: str
    owner_urns: tuple[str, ...]
    ownership_type: OwnershipType | None
    tag_urns: tuple[str, ...]
    domain_urn: str | None
    schema_fields: tuple[str, ...]


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


@dataclass(frozen=True, slots=True)
class ExpectedGraph:
    schema_version: int
    scenario_id: str
    environment: str
    platform_instance: str
    source_field: SourceField
    owners: tuple[Owner, ...]
    tags: tuple[Tag, ...]
    domains: tuple[Domain, ...]
    nodes: tuple[GraphNode, ...]
    edges: tuple[LineageEdge, ...]
    query_evidence: tuple[QueryEvidence, ...]
    impact_cards: tuple[str, ...]
    lineage_intermediates: tuple[str, ...]

    @property
    def managed_urns(self) -> tuple[str, ...]:
        """Every canonical entity URN referenced by the expected graph."""
        urns = {
            self.source_field.glossary_term_urn,
            *(owner.urn for owner in self.owners),
            *(tag.urn for tag in self.tags),
            *(domain.urn for domain in self.domains),
            *(node.urn for node in self.nodes),
            *(query.query_urn for query in self.query_evidence),
        }
        return tuple(sorted(urns))

    @property
    def connector_dataset_urns(self) -> tuple[str, ...]:
        return tuple(
            sorted(node.urn for node in self.nodes if node.entity_type is EntityType.DATASET)
        )

    @property
    def owned_urns(self) -> tuple[str, ...]:
        connector = set(self.connector_dataset_urns)
        return tuple(sorted(set(self.managed_urns) - connector))

    @property
    def allowed_mutation_urns(self) -> tuple[str, ...]:
        return tuple(sorted({*self.managed_urns, self.source_field.schema_field_urn}))
