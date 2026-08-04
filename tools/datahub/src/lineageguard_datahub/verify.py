from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol, TypeVar

from datahub._codegen.aspect import _Aspect
from datahub.emitter.mce_builder import (
    make_dataplatform_instance_urn,
    make_schema_field_urn,
)
from datahub.metadata.schema_classes import (
    DashboardInfoClass,
    DataPlatformInstanceClass,
    GlobalTagsClass,
    OwnershipClass,
    QueryPropertiesClass,
    QuerySourceClass,
    QuerySubjectsClass,
    QueryUsageStatisticsClass,
    SchemaMetadataClass,
    TrainingDataClass,
    UpstreamLineageClass,
)

from lineageguard_datahub.ingestion import RECIPE_DIGESTS
from lineageguard_datahub.models import ExpectedGraph, Granularity
from lineageguard_datahub.paths import resolve_checked_file
from lineageguard_datahub.query_history import normalized_sql_fingerprint
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus

Aspect = TypeVar("Aspect", bound=_Aspect)


class GraphReader(Protocol):
    def exists(self, entity_urn: str) -> bool: ...

    def get_aspect(
        self, entity_urn: str, aspect_type: type[Aspect], version: int = 0
    ) -> Aspect | None: ...

    def get_timeseries_values(
        self,
        entity_urn: str,
        aspect_type: type[Aspect],
        filter: dict[str, Any],
        limit: int = 10,
    ) -> list[Aspect]: ...


@dataclass(frozen=True, slots=True)
class QuerySignal:
    urn: str
    source: str
    normalized_fingerprint: str
    subjects: frozenset[str]
    usage_count: int
    platform_instance: str
    observation_timestamp_ms: int
    aspect_keys: tuple[tuple[str, str], ...]


@dataclass(frozen=True, slots=True)
class ObservedGraph:
    entity_urns: frozenset[str]
    schema_fields: frozenset[str]
    entity_edges: frozenset[tuple[str, str]]
    field_edges: frozenset[tuple[str, str]]
    ownership: frozenset[tuple[str, str]]
    tags: frozenset[tuple[str, str]]
    glossary_terms: frozenset[tuple[str, str]]
    query_signals: tuple[QuerySignal, ...]


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
    reachable_outcomes: tuple[str, ...]
    failures: tuple[VerificationFailure, ...]

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True, indent=2)


def _expected_field_urns(graph: ExpectedGraph) -> frozenset[str]:
    fields = {
        make_schema_field_urn(node.urn, field)
        for node in graph.nodes
        if node.entity_type.value == "DATASET"
        for field in node.schema_fields
    }
    return frozenset(fields)


def expected_observation(graph: ExpectedGraph) -> ObservedGraph:
    query = graph.query_evidence[0]
    revenue_field = make_schema_field_urn(query.dataset_urn, query.field_path)
    return ObservedGraph(
        entity_urns=frozenset(graph.managed_urns),
        schema_fields=_expected_field_urns(graph),
        entity_edges=frozenset(
            (edge.upstream_urn, edge.downstream_urn)
            for edge in graph.edges
            if edge.granularity is Granularity.ENTITY
        ),
        field_edges=frozenset(
            (
                make_schema_field_urn(edge.upstream_urn, edge.upstream_field_path or ""),
                make_schema_field_urn(edge.downstream_urn, edge.downstream_field_path or ""),
            )
            for edge in graph.edges
            if edge.granularity is Granularity.FIELD
        ),
        ownership=frozenset(
            (node.urn, owner_urn) for node in graph.nodes for owner_urn in node.owner_urns
        ),
        tags=frozenset((node.urn, tag_urn) for node in graph.nodes for tag_urn in node.tag_urns),
        glossary_terms=frozenset(
            {(graph.source_field.schema_field_urn, graph.source_field.glossary_term_urn)}
        ),
        query_signals=(
            QuerySignal(
                urn=query.query_urn,
                source=QuerySourceClass.SYSTEM,
                normalized_fingerprint=normalized_sql_fingerprint_from_file(graph, query),
                subjects=frozenset({query.dataset_urn, revenue_field}),
                usage_count=1,
                platform_instance=make_dataplatform_instance_urn(
                    "postgres", graph.platform_instance
                ),
                observation_timestamp_ms=1,
                aspect_keys=(),
            ),
        ),
    )


def normalized_sql_fingerprint_from_file(graph: ExpectedGraph, query: object) -> str:
    del graph, query
    # The value is fixed by the immutable query shape in query_history.py.
    return normalized_sql_fingerprint(
        "SELECT customer_id, lifetime_revenue FROM analytics.customer_revenue "
        "WHERE lifetime_revenue >= 100 ORDER BY lifetime_revenue DESC"
    )


def _missing_failure(
    code: str, expected: frozenset[object], observed: frozenset[object]
) -> VerificationFailure | None:
    missing = sorted(str(value) for value in expected - observed)
    return None if not missing else VerificationFailure(code, ", ".join(missing))


def _exact_failure(
    code: str, expected: frozenset[object], observed: frozenset[object]
) -> VerificationFailure | None:
    missing = sorted(str(value) for value in expected - observed)
    extra = sorted(str(value) for value in observed - expected)
    return (
        None
        if not missing and not extra
        else VerificationFailure(code, f"missing={missing}, extra={extra}")
    )


def _receipt_failures(
    graph: ExpectedGraph,
    signals: tuple[QuerySignal, ...],
    receipts: tuple[OperationReceipt, ...],
) -> tuple[VerificationFailure, ...]:
    query_receipts = [
        receipt
        for receipt in receipts
        if receipt.scenario_id == graph.scenario_id
        and receipt.operation_kind == "query"
        and receipt.status is ReceiptStatus.SUCCESS
        and receipt.detail_code == "PG_STAT_OBSERVED"
    ]
    ingest_receipts = [
        receipt
        for receipt in receipts
        if receipt.scenario_id == graph.scenario_id
        and receipt.operation_kind == "ingest"
        and receipt.status is ReceiptStatus.SUCCESS
        and receipt.aspect_name == "walkthrough/metadata/postgres-ingestion.yml"
        and receipt.idempotency_key == RECIPE_DIGESTS["walkthrough/metadata/postgres-ingestion.yml"]
        and receipt.proposal_hash == RECIPE_DIGESTS["walkthrough/metadata/postgres-ingestion.yml"]
    ]
    live_query_candidates = [
        receipt
        for receipt in receipts
        if receipt.scenario_id == graph.scenario_id
        and receipt.operation_kind == "ingest-query"
        and (
            (
                receipt.status is ReceiptStatus.SUCCESS
                and receipt.detail_code == "LIVE_QUERY_EMITTED"
            )
            or (
                receipt.status is ReceiptStatus.SKIPPED
                and receipt.detail_code == "ASPECT_SKIPPED_EXACT"
            )
        )
    ]
    latest_live_by_aspect: dict[str, OperationReceipt] = {}
    for receipt in live_query_candidates:
        if receipt.aspect_name is None:
            continue
        current = latest_live_by_aspect.get(receipt.aspect_name)
        if current is None or receipt.recorded_at > current.recorded_at:
            latest_live_by_aspect[receipt.aspect_name] = receipt
    live_query_receipts = list(latest_live_by_aspect.values())
    failures: list[VerificationFailure] = []
    if not query_receipts:
        failures.append(VerificationFailure("PG_STAT_RECEIPT_MISSING", "query"))
    else:
        latest = max(query_receipts, key=lambda item: item.recorded_at)
        query = graph.query_evidence[0]
        if (
            latest.idempotency_key != normalized_sql_fingerprint_from_file(graph, query)
            or latest.proposal_hash != latest.idempotency_key
            or latest.metrics.get("normalizedFingerprint") != latest.idempotency_key
            or latest.metrics.get("statementSha256") != query.sha256
            or not latest.metrics.get("queryId")
        ):
            failures.append(VerificationFailure("PG_STAT_RECEIPT_BINDING_INVALID", "query"))
        if int(latest.metrics.get("executionCount", 0)) < 1:
            failures.append(VerificationFailure("PG_STAT_COUNT_INVALID", "executionCount"))
        if float(latest.metrics.get("totalExecTimeMs", -1)) < 0:
            failures.append(VerificationFailure("PG_STAT_TIME_INVALID", "totalExecTimeMs"))
    if not ingest_receipts:
        failures.append(VerificationFailure("POSTGRES_INGEST_RECEIPT_MISSING", "ingest"))
    elif query_receipts:
        latest_query = max(query_receipts, key=lambda item: item.recorded_at)
        latest_ingest = max(ingest_receipts, key=lambda item: item.recorded_at)
        if datetime.fromisoformat(latest_ingest.recorded_at) < datetime.fromisoformat(
            latest_query.recorded_at
        ):
            failures.append(VerificationFailure("POSTGRES_INGEST_PRECEDES_QUERY", "order"))
    required_query_aspects = {
        "queryProperties",
        "querySubjects",
        "dataPlatformInstance",
        "queryUsageStatistics",
    }
    signal = signals[0] if len(signals) == 1 else None
    receipt_aspects = {item.aspect_name for item in live_query_receipts}
    if not required_query_aspects <= receipt_aspects:
        failures.append(
            VerificationFailure(
                "LIVE_QUERY_INGEST_RECEIPTS_MISSING",
                ", ".join(sorted(required_query_aspects - receipt_aspects)),
            )
        )
    if signal is not None and query_receipts:
        latest_query = max(query_receipts, key=lambda item: item.recorded_at)
        expected_keys = dict(signal.aspect_keys)
        for item in live_query_receipts:
            if item.entity_urn != signal.urn:
                failures.append(
                    VerificationFailure("LIVE_QUERY_RECEIPT_URN_MISMATCH", str(item.entity_urn))
                )
                continue
            expected_key = expected_keys.get(item.aspect_name or "")
            if (
                expected_key is None
                or item.idempotency_key != expected_key
                or item.proposal_hash != expected_key
            ):
                failures.append(
                    VerificationFailure("LIVE_QUERY_RECEIPT_KEY_MISMATCH", str(item.aspect_name))
                )
            metrics = item.metrics
            if (
                metrics.get("queryFingerprint") != latest_query.idempotency_key
                or str(metrics.get("pgStatQueryId")) != str(latest_query.metrics.get("queryId"))
                or int(metrics.get("executionCount", -1))
                != int(latest_query.metrics.get("executionCount", -2))
                or float(metrics.get("totalExecTimeMs", -1))
                != float(latest_query.metrics.get("totalExecTimeMs", -2))
                or metrics.get("observationTimestamp") != latest_query.recorded_at
                or metrics.get("recipeFingerprint")
                != RECIPE_DIGESTS["walkthrough/metadata/postgres-ingestion.yml"]
                or metrics.get("afterStatus")
                != ("EMITTED" if item.status is ReceiptStatus.SUCCESS else "UNCHANGED")
            ):
                failures.append(
                    VerificationFailure(
                        "LIVE_QUERY_RECEIPT_METRICS_MISMATCH", str(item.aspect_name)
                    )
                )
        expected_ms = int(datetime.fromisoformat(latest_query.recorded_at).timestamp() * 1000)
        if signal.usage_count != int(latest_query.metrics.get("executionCount", -1)):
            failures.append(VerificationFailure("LIVE_QUERY_COUNT_MISMATCH", signal.urn))
        if signal.observation_timestamp_ms != expected_ms:
            failures.append(VerificationFailure("LIVE_QUERY_TIMESTAMP_MISMATCH", signal.urn))
        for item in live_query_receipts:
            if datetime.fromisoformat(item.recorded_at) < datetime.fromisoformat(
                latest_query.recorded_at
            ):
                failures.append(
                    VerificationFailure("LIVE_QUERY_RECEIPT_STALE", str(item.aspect_name))
                )
    return tuple(failures)


def _reachable(graph: ExpectedGraph, observed: ObservedGraph) -> tuple[set[str], set[str]]:
    reachable_fields = {graph.source_field.schema_field_urn}
    changed = True
    while changed:
        changed = False
        for upstream, downstream in observed.field_edges:
            if upstream in reachable_fields and downstream not in reachable_fields:
                reachable_fields.add(downstream)
                changed = True
    nodes = {node.logical_key: node for node in graph.nodes}
    revenue = nodes["analytics.customer_revenue"]
    stg = nodes["analytics.stg_orders"]
    fraud_features = nodes["fraud.customer_features"]
    dashboard = nodes["finance.revenue-dashboard"]
    model = nodes["fraud.model-v3"]
    revenue_field = make_schema_field_urn(revenue.urn, "customer_id")
    stg_field = make_schema_field_urn(stg.urn, "customer_id")
    fraud_field = make_schema_field_urn(fraud_features.urn, "customer_id")
    outcomes: set[str] = set()
    intermediates: set[str] = set()
    if stg_field in reachable_fields:
        intermediates.add("analytics.stg_orders")
    if fraud_field in reachable_fields:
        intermediates.add("fraud.customer_features")
    if revenue_field in reachable_fields:
        outcomes.add("analytics.customer_revenue")
    if (
        "analytics.customer_revenue" in outcomes
        and (revenue.urn, dashboard.urn) in observed.entity_edges
    ):
        outcomes.add("finance.revenue-dashboard")
    if fraud_field in reachable_fields and (fraud_features.urn, model.urn) in observed.entity_edges:
        outcomes.add("fraud.model-v3")
    if revenue_field in reachable_fields and any(
        signal.source == QuerySourceClass.SYSTEM
        and signal.usage_count > 0
        and revenue_field in signal.subjects
        for signal in observed.query_signals
    ):
        outcomes.add("query.finance-monthly-close")
    return outcomes, intermediates


def compare_observed_graph(
    graph: ExpectedGraph,
    observed: ObservedGraph,
    receipts: tuple[OperationReceipt, ...] = (),
) -> GraphVerificationReport:
    expected = expected_observation(graph)
    checks = (
        ("ENTITY_INVENTORY_MISMATCH", expected.entity_urns, observed.entity_urns),
        ("ENTITY_LINEAGE_MISMATCH", expected.entity_edges, observed.entity_edges),
        ("FIELD_LINEAGE_MISMATCH", expected.field_edges, observed.field_edges),
        ("OWNER_MISMATCH", expected.ownership, observed.ownership),
        ("TAG_MISMATCH", expected.tags, observed.tags),
        ("GLOSSARY_TERM_MISMATCH", expected.glossary_terms, observed.glossary_terms),
    )
    failures = [
        failure
        for code, expected_values, observed_values in checks
        if (failure := _exact_failure(code, expected_values, observed_values)) is not None
    ]
    if expected.schema_fields != observed.schema_fields:
        missing = sorted(expected.schema_fields - observed.schema_fields)
        extra = sorted(observed.schema_fields - expected.schema_fields)
        failures.append(
            VerificationFailure(
                "SCHEMA_FIELD_INVENTORY_MISMATCH", f"missing={missing}, extra={extra}"
            )
        )
    canonical_fingerprint = expected.query_signals[0].normalized_fingerprint
    live_query = [
        signal
        for signal in observed.query_signals
        if signal.source == QuerySourceClass.SYSTEM
        and signal.urn == graph.query_evidence[0].query_urn
        and signal.normalized_fingerprint == canonical_fingerprint
        and signal.usage_count > 0
        and signal.platform_instance
        == make_dataplatform_instance_urn("postgres", graph.platform_instance)
        and signal.subjects == expected.query_signals[0].subjects
    ]
    if not live_query:
        failures.append(VerificationFailure("LIVE_QUERY_EVIDENCE_MISSING", "SYSTEM query"))
    if len(live_query) != 1:
        failures.append(VerificationFailure("LIVE_QUERY_SIGNAL_SPLIT", str(len(live_query))))
    failures.extend(_receipt_failures(graph, tuple(live_query), receipts))
    outcomes, intermediates = _reachable(graph, observed)
    missing_outcomes = set(graph.impact_cards) - outcomes
    if missing_outcomes:
        failures.append(
            VerificationFailure("IMPACT_PATH_INCOMPLETE", ", ".join(sorted(missing_outcomes)))
        )
    fingerprint_payload = asdict(observed)
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_payload, sort_keys=True, default=sorted).encode()
    ).hexdigest()
    return GraphVerificationReport(
        ok=not failures,
        scenario_id=graph.scenario_id,
        graph_fingerprint=fingerprint,
        impact_cards=len(outcomes),
        lineage_intermediates=len(intermediates),
        reachable_outcomes=tuple(sorted(outcomes)),
        failures=tuple(failures),
    )


def observe_live(reader: GraphReader, graph: ExpectedGraph) -> ObservedGraph:
    entities = {urn for urn in graph.managed_urns if reader.exists(urn)}
    schema_fields: set[str] = set()
    entity_edges: set[tuple[str, str]] = set()
    field_edges: set[tuple[str, str]] = set()
    ownership: set[tuple[str, str]] = set()
    tags: set[tuple[str, str]] = set()
    glossary_terms: set[tuple[str, str]] = set()
    query_signals: list[QuerySignal] = []
    dataset_nodes = [node for node in graph.nodes if node.entity_type.value == "DATASET"]
    for node in dataset_nodes:
        schema = reader.get_aspect(node.urn, SchemaMetadataClass)
        if schema is not None:
            for field in schema.fields:
                field_urn = make_schema_field_urn(node.urn, field.fieldPath)
                schema_fields.add(field_urn)
                if field.glossaryTerms is not None:
                    glossary_terms.update(
                        (field_urn, association.urn) for association in field.glossaryTerms.terms
                    )
        lineage = reader.get_aspect(node.urn, UpstreamLineageClass)
        if lineage is not None:
            for fine in lineage.fineGrainedLineages or []:
                for upstream in fine.upstreams or []:
                    for downstream in fine.downstreams or []:
                        field_edges.add((upstream, downstream))
    for edge in graph.edges:
        if edge.granularity is not Granularity.ENTITY:
            continue
        if edge.downstream_type.value == "DASHBOARD":
            dashboard = reader.get_aspect(edge.downstream_urn, DashboardInfoClass)
            if dashboard is not None and edge.upstream_urn in (dashboard.datasets or []):
                entity_edges.add((edge.upstream_urn, edge.downstream_urn))
        elif edge.downstream_type.value == "MLMODEL":
            training = reader.get_aspect(edge.downstream_urn, TrainingDataClass)
            if training is not None and any(
                item.dataset == edge.upstream_urn for item in training.trainingData
            ):
                entity_edges.add((edge.upstream_urn, edge.downstream_urn))
    for node in graph.nodes:
        owner_aspect = reader.get_aspect(node.urn, OwnershipClass)
        if owner_aspect is not None:
            ownership.update((node.urn, owner.owner) for owner in owner_aspect.owners)
        tag_aspect = reader.get_aspect(node.urn, GlobalTagsClass)
        if tag_aspect is not None:
            tags.update((node.urn, association.tag) for association in tag_aspect.tags)
    urn = graph.query_evidence[0].query_urn
    if reader.exists(urn):
        properties = reader.get_aspect(urn, QueryPropertiesClass)
        subjects = reader.get_aspect(urn, QuerySubjectsClass)
        instance = reader.get_aspect(urn, DataPlatformInstanceClass)
        usage = reader.get_timeseries_values(urn, QueryUsageStatisticsClass, {}, limit=10)
        if properties is not None and subjects is not None and instance is not None and usage:
            latest_usage = max(usage, key=lambda item: item.timestampMillis)
            from datahub.emitter.mcp import MetadataChangeProposalWrapper

            aspects = (properties, subjects, instance, latest_usage)
            aspect_keys = tuple(
                (
                    MetadataChangeProposalWrapper(entityUrn=urn, aspect=aspect).aspectName or "",
                    hashlib.sha256(
                        json.dumps(
                            MetadataChangeProposalWrapper(entityUrn=urn, aspect=aspect).to_obj(),
                            sort_keys=True,
                            separators=(",", ":"),
                        ).encode()
                    ).hexdigest(),
                )
                for aspect in aspects
            )
            query_signals.append(
                QuerySignal(
                    urn=urn,
                    source=str(properties.source),
                    normalized_fingerprint=normalized_sql_fingerprint(properties.statement.value),
                    subjects=frozenset(subject.entity for subject in subjects.subjects),
                    usage_count=int(latest_usage.queryCount or 0),
                    platform_instance=str(instance.instance),
                    observation_timestamp_ms=int(latest_usage.timestampMillis),
                    aspect_keys=aspect_keys,
                )
            )
    return ObservedGraph(
        entity_urns=frozenset(entities),
        schema_fields=frozenset(schema_fields),
        entity_edges=frozenset(entity_edges),
        field_edges=frozenset(field_edges),
        ownership=frozenset(ownership),
        tags=frozenset(tags),
        glossary_terms=frozenset(glossary_terms),
        query_signals=tuple(sorted(query_signals, key=lambda signal: signal.urn)),
    )


def verify_query_files(graph: ExpectedGraph, root: Path) -> None:
    for query in graph.query_evidence:
        resolve_checked_file(root, query.sql_path, query.sha256)
