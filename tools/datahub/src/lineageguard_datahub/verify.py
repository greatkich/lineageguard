from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol, TypeVar

from datahub._codegen.aspect import _Aspect
from datahub.emitter.mce_builder import make_schema_field_urn
from datahub.metadata.schema_classes import (
    DashboardInfoClass,
    GlobalTagsClass,
    OwnershipClass,
    QueryPropertiesClass,
    QuerySubjectsClass,
    SchemaMetadataClass,
    TrainingDataClass,
    UpstreamLineageClass,
)

from lineageguard_datahub.models import ExpectedGraph, Granularity

Aspect = TypeVar("Aspect", bound=_Aspect)


class GraphReader(Protocol):
    def exists(self, entity_urn: str) -> bool: ...

    def get_aspect(
        self,
        entity_urn: str,
        aspect_type: type[Aspect],
        version: int = 0,
    ) -> Aspect | None: ...


@dataclass(frozen=True, slots=True)
class ObservedGraph:
    entity_urns: frozenset[str]
    entity_edges: frozenset[tuple[str, str]]
    field_edges: frozenset[tuple[str, str]]
    ownership: frozenset[tuple[str, str]]
    tags: frozenset[tuple[str, str]]
    glossary_terms: frozenset[tuple[str, str]]
    query_subjects: frozenset[tuple[str, str]]
    query_sha256: frozenset[tuple[str, str]]


@dataclass(frozen=True, slots=True)
class VerificationFailure:
    code: str
    detail: str


@dataclass(frozen=True, slots=True)
class GraphVerificationReport:
    ok: bool
    scenario_id: str
    graph_fingerprint: str
    impact_cards: int
    lineage_intermediates: int
    failures: tuple[VerificationFailure, ...]

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True, indent=2)


def expected_observation(graph: ExpectedGraph) -> ObservedGraph:
    entity_edges = {
        (edge.upstream_urn, edge.downstream_urn)
        for edge in graph.edges
        if edge.granularity is Granularity.ENTITY
    }
    field_edges = {
        (
            make_schema_field_urn(edge.upstream_urn, edge.upstream_field_path or ""),
            make_schema_field_urn(edge.downstream_urn, edge.downstream_field_path or ""),
        )
        for edge in graph.edges
        if edge.granularity is Granularity.FIELD
    }
    return ObservedGraph(
        entity_urns=frozenset(graph.managed_urns),
        entity_edges=frozenset(entity_edges),
        field_edges=frozenset(field_edges),
        ownership=frozenset(
            (node.urn, owner_urn) for node in graph.nodes for owner_urn in node.owner_urns
        )
        | frozenset((query.query_urn, query.owner_urn) for query in graph.query_evidence),
        tags=frozenset((node.urn, tag_urn) for node in graph.nodes for tag_urn in node.tag_urns),
        glossary_terms=frozenset(
            {(graph.source_field.schema_field_urn, graph.source_field.glossary_term_urn)}
        ),
        query_subjects=frozenset(
            (query.query_urn, query.dataset_urn) for query in graph.query_evidence
        ),
        query_sha256=frozenset((query.query_urn, query.sha256) for query in graph.query_evidence),
    )


def _missing_failure(
    code: str, expected: frozenset[object], observed: frozenset[object]
) -> VerificationFailure | None:
    missing = sorted(str(value) for value in expected - observed)
    if not missing:
        return None
    return VerificationFailure(code=code, detail=", ".join(missing))


def compare_observed_graph(
    graph: ExpectedGraph, observed: ObservedGraph
) -> GraphVerificationReport:
    expected = expected_observation(graph)
    checks = (
        ("ENTITY_MISSING", expected.entity_urns, observed.entity_urns),
        ("ENTITY_LINEAGE_MISSING", expected.entity_edges, observed.entity_edges),
        ("FIELD_LINEAGE_MISSING", expected.field_edges, observed.field_edges),
        ("OWNER_MISSING", expected.ownership, observed.ownership),
        ("TAG_MISSING", expected.tags, observed.tags),
        ("GLOSSARY_TERM_MISSING", expected.glossary_terms, observed.glossary_terms),
        ("QUERY_SUBJECT_MISSING", expected.query_subjects, observed.query_subjects),
        ("QUERY_EVIDENCE_MISSING", expected.query_sha256, observed.query_sha256),
    )
    failures = tuple(
        failure
        for code, expected_values, observed_values in checks
        if (failure := _missing_failure(code, expected_values, observed_values)) is not None
    )
    fingerprint_payload = {
        "entities": sorted(observed.entity_urns),
        "entityEdges": sorted(observed.entity_edges),
        "fieldEdges": sorted(observed.field_edges),
        "ownership": sorted(observed.ownership),
        "tags": sorted(observed.tags),
        "terms": sorted(observed.glossary_terms),
        "querySubjects": sorted(observed.query_subjects),
        "querySha256": sorted(observed.query_sha256),
    }
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return GraphVerificationReport(
        ok=not failures,
        scenario_id=graph.scenario_id,
        graph_fingerprint=fingerprint,
        impact_cards=len(graph.impact_cards),
        lineage_intermediates=len(graph.lineage_intermediates),
        failures=failures,
    )


def observe_live(reader: GraphReader, graph: ExpectedGraph) -> ObservedGraph:
    entities = {urn for urn in graph.managed_urns if reader.exists(urn)}
    entity_edges: set[tuple[str, str]] = set()
    field_edges: set[tuple[str, str]] = set()
    ownership: set[tuple[str, str]] = set()
    tags: set[tuple[str, str]] = set()
    glossary_terms: set[tuple[str, str]] = set()
    query_subjects: set[tuple[str, str]] = set()
    query_sha256: set[tuple[str, str]] = set()

    node_types = {node.urn: node.entity_type for node in graph.nodes}
    downstream_urns = {
        edge.downstream_urn
        for edge in graph.edges
        if node_types[edge.downstream_urn].value == "DATASET"
    }
    expected_entity_edges = {
        (edge.upstream_urn, edge.downstream_urn)
        for edge in graph.edges
        if edge.granularity is Granularity.ENTITY
    }
    for downstream_urn in downstream_urns:
        aspect = reader.get_aspect(downstream_urn, UpstreamLineageClass)
        if aspect is None:
            continue
        for upstream in aspect.upstreams:
            pair = (upstream.dataset, downstream_urn)
            if pair in expected_entity_edges:
                entity_edges.add(pair)
        for fine in aspect.fineGrainedLineages or []:
            for upstream_field in fine.upstreams or []:
                for downstream_field in fine.downstreams or []:
                    field_edges.add((upstream_field, downstream_field))

    for edge in graph.edges:
        if edge.granularity is not Granularity.ENTITY:
            continue
        if edge.downstream_type.value == "DASHBOARD":
            dashboard = reader.get_aspect(edge.downstream_urn, DashboardInfoClass)
            if dashboard is not None and edge.upstream_urn in (dashboard.datasets or []):
                entity_edges.add((edge.upstream_urn, edge.downstream_urn))
        elif edge.downstream_type.value == "MLMODEL":
            training_data = reader.get_aspect(edge.downstream_urn, TrainingDataClass)
            if training_data is not None and any(
                item.dataset == edge.upstream_urn for item in training_data.trainingData
            ):
                entity_edges.add((edge.upstream_urn, edge.downstream_urn))

    for node in graph.nodes:
        owner_aspect = reader.get_aspect(node.urn, OwnershipClass)
        if owner_aspect is not None:
            ownership.update((node.urn, owner.owner) for owner in owner_aspect.owners)
        tag_aspect = reader.get_aspect(node.urn, GlobalTagsClass)
        if tag_aspect is not None:
            tags.update((node.urn, association.tag) for association in tag_aspect.tags)

    schema = reader.get_aspect(graph.source_field.dataset_urn, SchemaMetadataClass)
    if schema is not None:
        for field in schema.fields:
            if field.fieldPath != graph.source_field.field_path or field.glossaryTerms is None:
                continue
            glossary_terms.update(
                (graph.source_field.schema_field_urn, association.urn)
                for association in field.glossaryTerms.terms
            )

    for query in graph.query_evidence:
        owner_aspect = reader.get_aspect(query.query_urn, OwnershipClass)
        if owner_aspect is not None:
            ownership.update((query.query_urn, owner.owner) for owner in owner_aspect.owners)
        subjects = reader.get_aspect(query.query_urn, QuerySubjectsClass)
        if subjects is not None:
            query_subjects.update(
                (query.query_urn, subject.entity) for subject in subjects.subjects
            )
        properties = reader.get_aspect(query.query_urn, QueryPropertiesClass)
        if properties is not None:
            custom_properties = properties.customProperties or {}
            digest = custom_properties.get("lineageguard.sha256")
            if digest is not None:
                query_sha256.add((query.query_urn, digest))
            owner_urn = custom_properties.get("lineageguard.ownerUrn")
            if owner_urn is not None:
                ownership.add((query.query_urn, owner_urn))

    return ObservedGraph(
        entity_urns=frozenset(entities),
        entity_edges=frozenset(entity_edges),
        field_edges=frozenset(field_edges),
        ownership=frozenset(ownership),
        tags=frozenset(tags),
        glossary_terms=frozenset(glossary_terms),
        query_subjects=frozenset(query_subjects),
        query_sha256=frozenset(query_sha256),
    )


def verify_query_files(graph: ExpectedGraph, root: Path) -> None:
    for query in graph.query_evidence:
        path = (root / query.sql_path).resolve()
        if not path.is_relative_to(root.resolve()):
            raise ValueError("QUERY_PATH_OUTSIDE_REPOSITORY")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != query.sha256:
            raise ValueError(f"QUERY_DIGEST_MISMATCH:{query.logical_key}")
