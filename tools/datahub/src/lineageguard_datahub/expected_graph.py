from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from lineageguard_datahub.models import (
    EntityType,
    ExpectedGraph,
    Granularity,
    GraphNode,
    LineageEdge,
    Owner,
    OwnershipType,
    QueryEvidence,
    SourceField,
    Tag,
)


class GraphContractError(ValueError):
    """The checked graph manifest violates the canonical contract."""


CANONICAL_PREFIX = "lineageguard-canonical"
CANONICAL_QUERY_SHA256 = "e4bbe7075754d05de68f76ff0a9b127532e044da8ab0a357bce7e0d41f7ad22c"
CANONICAL_LIVE_QUERY_URN = f"urn:li:query:{CANONICAL_PREFIX}.system.{CANONICAL_QUERY_SHA256}"
CANONICAL_SCHEMA_FIELDS = {
    "commerce.orders": ("order_id", "customer_id", "order_total", "ordered_at"),
    "analytics.stg_orders": ("order_id", "customer_id", "order_total", "ordered_at"),
    "analytics.customer_revenue": ("customer_id", "lifetime_revenue"),
    "fraud.customer_features": ("customer_id", "order_count", "max_order_total"),
    "finance.revenue-dashboard": (),
    "fraud.model-v3": (),
}
CANONICAL_EDGE_SPECS = {
    (
        "orders.customer_id->stg_orders.customer_id",
        "commerce.orders",
        "analytics.stg_orders",
        "FIELD",
        "customer_id",
        "customer_id",
    ),
    (
        "stg_orders.customer_id->customer_revenue.customer_id",
        "analytics.stg_orders",
        "analytics.customer_revenue",
        "FIELD",
        "customer_id",
        "customer_id",
    ),
    (
        "stg_orders.customer_id->customer_features.customer_id",
        "analytics.stg_orders",
        "fraud.customer_features",
        "FIELD",
        "customer_id",
        "customer_id",
    ),
    (
        "customer_revenue->finance-dashboard",
        "analytics.customer_revenue",
        "finance.revenue-dashboard",
        "ENTITY",
        None,
        None,
    ),
    (
        "customer_features->fraud-model-v3",
        "fraud.customer_features",
        "fraud.model-v3",
        "ENTITY",
        None,
        None,
    ),
}
CANONICAL_IMPACT_CARDS = (
    "analytics.customer_revenue",
    "finance.revenue-dashboard",
    "fraud.model-v3",
    "query.finance-monthly-close",
)
CANONICAL_INTERMEDIATES = ("analytics.stg_orders", "fraud.customer_features")
CANONICAL_ENTITY_TYPES = {
    "commerce.orders": EntityType.DATASET,
    "analytics.stg_orders": EntityType.DATASET,
    "analytics.customer_revenue": EntityType.DATASET,
    "fraud.customer_features": EntityType.DATASET,
    "finance.revenue-dashboard": EntityType.DASHBOARD,
    "fraud.model-v3": EntityType.MLMODEL,
}
CANONICAL_NON_DATASET_URNS = {
    "urn:li:corpGroup:lineageguard-canonical.finance-analytics",
    "urn:li:corpGroup:lineageguard-canonical.risk-ml",
    "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)",
    "urn:li:glossaryTerm:lineageguard-canonical.CustomerIdentifier",
    "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)",
    CANONICAL_LIVE_QUERY_URN,
    "urn:li:tag:lineageguard-canonical.Critical",
    "urn:li:tag:lineageguard-canonical.Production",
    "urn:li:tag:lineageguard-canonical.Reviewed",
}
CANONICAL_OWNER_SPECS = frozenset(
    {
        (
            "team.finance-analytics",
            "urn:li:corpGroup:lineageguard-canonical.finance-analytics",
            "Finance Analytics",
        ),
        ("team.risk-ml", "urn:li:corpGroup:lineageguard-canonical.risk-ml", "Risk ML"),
    }
)
CANONICAL_TAG_SPECS = frozenset(
    {
        (
            "critical",
            "urn:li:tag:lineageguard-canonical.Critical",
            "Critical",
            "LineageGuard critical asset classification.",
        ),
        (
            "production",
            "urn:li:tag:lineageguard-canonical.Production",
            "Production",
            "LineageGuard production asset classification.",
        ),
        (
            "reviewed",
            "urn:li:tag:lineageguard-canonical.Reviewed",
            "Reviewed",
            "LineageGuard review status: a validated migration decision was written back "
            "through the approved effect gate.",
        ),
    }
)
CANONICAL_NODE_SEMANTICS = frozenset(
    {
        ("commerce.orders", "orders", (), None, ()),
        ("analytics.stg_orders", "stg_orders", (), None, ()),
        (
            "analytics.customer_revenue",
            "customer_revenue",
            ("urn:li:corpGroup:lineageguard-canonical.finance-analytics",),
            OwnershipType.TECHNICAL_OWNER,
            ("urn:li:tag:lineageguard-canonical.Critical",),
        ),
        (
            "fraud.customer_features",
            "customer_features",
            ("urn:li:corpGroup:lineageguard-canonical.risk-ml",),
            OwnershipType.TECHNICAL_OWNER,
            ("urn:li:tag:lineageguard-canonical.Production",),
        ),
        (
            "finance.revenue-dashboard",
            "Finance Revenue Dashboard",
            ("urn:li:corpGroup:lineageguard-canonical.finance-analytics",),
            OwnershipType.BUSINESS_OWNER,
            (
                "urn:li:tag:lineageguard-canonical.Critical",
                "urn:li:tag:lineageguard-canonical.Production",
            ),
        ),
        (
            "fraud.model-v3",
            "Fraud Model v3",
            ("urn:li:corpGroup:lineageguard-canonical.risk-ml",),
            OwnershipType.TECHNICAL_OWNER,
            (
                "urn:li:tag:lineageguard-canonical.Critical",
                "urn:li:tag:lineageguard-canonical.Production",
            ),
        ),
    }
)
CANONICAL_QUERY_SEMANTICS = (
    "query.finance-monthly-close",
    "lineageguard:finance-monthly-close",
    "walkthrough/warehouse/queries/finance-monthly-close.sql",
    "customer_id",
    ("urn:li:corpGroup:lineageguard-canonical.finance-analytics",),
    OwnershipType.BUSINESS_OWNER,
)


ROOT_KEYS = {
    "schemaVersion",
    "scenarioId",
    "environment",
    "platformInstance",
    "sourceField",
    "owners",
    "tags",
    "nodes",
    "edges",
    "queryEvidence",
    "impactCards",
    "lineageIntermediates",
}


def _object(value: object, context: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise GraphContractError(f"{context} must be an object")
    return cast(dict[str, Any], value)


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise GraphContractError(f"{context} keys mismatch: missing={missing}, extra={extra}")


def _string(value: object, context: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise GraphContractError(f"{context} must be a non-empty string")
    return value


def _strings(value: object, context: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise GraphContractError(f"{context} must be an array")
    if len(value) > 64:
        raise GraphContractError(f"{context} exceeds maximum size")
    return tuple(_string(item, f"{context}[]") for item in value)


def _objects(value: object, context: str) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, list):
        raise GraphContractError(f"{context} must be an array")
    if len(value) > 64:
        raise GraphContractError(f"{context} exceeds maximum size")
    return tuple(_object(item, f"{context}[]") for item in value)


def _optional_string(value: object, context: str) -> str | None:
    return None if value is None else _string(value, context)


def _unique[T](values: tuple[T, ...], key: Callable[[T], object], context: str) -> None:
    identifiers = [key(item) for item in values]
    if len(identifiers) != len(set(identifiers)):
        raise GraphContractError(f"{context} contains duplicate identifiers")


def _source_field(raw: object) -> SourceField:
    value = _object(raw, "sourceField")
    _exact_keys(
        value,
        {"logicalKey", "datasetUrn", "fieldPath", "schemaFieldUrn", "glossaryTermUrn"},
        "sourceField",
    )
    return SourceField(
        logical_key=_string(value["logicalKey"], "sourceField.logicalKey"),
        dataset_urn=_string(value["datasetUrn"], "sourceField.datasetUrn"),
        field_path=_string(value["fieldPath"], "sourceField.fieldPath"),
        schema_field_urn=_string(value["schemaFieldUrn"], "sourceField.schemaFieldUrn"),
        glossary_term_urn=_string(value["glossaryTermUrn"], "sourceField.glossaryTermUrn"),
    )


def _owner(raw: dict[str, Any]) -> Owner:
    _exact_keys(raw, {"logicalKey", "urn", "displayName"}, "owner")
    return Owner(
        logical_key=_string(raw["logicalKey"], "owner.logicalKey"),
        urn=_string(raw["urn"], "owner.urn"),
        display_name=_string(raw["displayName"], "owner.displayName"),
    )


def _tag(raw: dict[str, Any]) -> Tag:
    _exact_keys(raw, {"logicalKey", "urn", "displayName", "description"}, "tag")
    return Tag(
        logical_key=_string(raw["logicalKey"], "tag.logicalKey"),
        urn=_string(raw["urn"], "tag.urn"),
        display_name=_string(raw["displayName"], "tag.displayName"),
        description=_string(raw["description"], "tag.description"),
    )


def _node(raw: dict[str, Any]) -> GraphNode:
    _exact_keys(
        raw,
        {
            "logicalKey",
            "urn",
            "entityType",
            "name",
            "ownerUrns",
            "ownershipType",
            "tagUrns",
            "schemaFields",
        },
        "node",
    )
    try:
        entity_type = EntityType(_string(raw["entityType"], "node.entityType"))
    except ValueError as error:
        raise GraphContractError(f"unsupported node entityType: {raw['entityType']}") from error
    raw_ownership_type = raw["ownershipType"]
    try:
        ownership_type = (
            None
            if raw_ownership_type is None
            else OwnershipType(_string(raw_ownership_type, "node.ownershipType"))
        )
    except ValueError as error:
        raise GraphContractError(f"unsupported node ownershipType: {raw_ownership_type}") from error
    owner_urns = _strings(raw["ownerUrns"], "node.ownerUrns")
    if bool(owner_urns) != (ownership_type is not None):
        raise GraphContractError("node ownershipType must exactly accompany ownerUrns")
    return GraphNode(
        logical_key=_string(raw["logicalKey"], "node.logicalKey"),
        urn=_string(raw["urn"], "node.urn"),
        entity_type=entity_type,
        name=_string(raw["name"], "node.name"),
        owner_urns=owner_urns,
        ownership_type=ownership_type,
        tag_urns=_strings(raw["tagUrns"], "node.tagUrns"),
        schema_fields=_strings(raw["schemaFields"], "node.schemaFields"),
    )


def _edge(raw: dict[str, Any]) -> LineageEdge:
    _exact_keys(
        raw,
        {
            "logicalKey",
            "upstreamUrn",
            "downstreamUrn",
            "upstreamType",
            "downstreamType",
            "granularity",
            "upstreamFieldPath",
            "downstreamFieldPath",
        },
        "edge",
    )
    try:
        upstream_type = EntityType(_string(raw["upstreamType"], "edge.upstreamType"))
        downstream_type = EntityType(_string(raw["downstreamType"], "edge.downstreamType"))
        granularity = Granularity(_string(raw["granularity"], "edge.granularity"))
    except ValueError as error:
        raise GraphContractError(f"unsupported edge enum value in {raw['logicalKey']}") from error
    edge = LineageEdge(
        logical_key=_string(raw["logicalKey"], "edge.logicalKey"),
        upstream_urn=_string(raw["upstreamUrn"], "edge.upstreamUrn"),
        downstream_urn=_string(raw["downstreamUrn"], "edge.downstreamUrn"),
        upstream_type=upstream_type,
        downstream_type=downstream_type,
        granularity=granularity,
        upstream_field_path=_optional_string(raw["upstreamFieldPath"], "edge.upstreamFieldPath"),
        downstream_field_path=_optional_string(
            raw["downstreamFieldPath"], "edge.downstreamFieldPath"
        ),
    )
    if edge.granularity is Granularity.FIELD:
        if (
            edge.upstream_type is not EntityType.DATASET
            or edge.downstream_type is not EntityType.DATASET
        ):
            raise GraphContractError(f"field edge {edge.logical_key} must connect two datasets")
        if edge.upstream_field_path is None or edge.downstream_field_path is None:
            raise GraphContractError(f"field edge {edge.logical_key} requires both field paths")
    elif edge.upstream_field_path is not None or edge.downstream_field_path is not None:
        raise GraphContractError(f"entity edge {edge.logical_key} cannot carry field paths")
    return edge


def _query(raw: dict[str, Any]) -> QueryEvidence:
    _exact_keys(
        raw,
        {
            "logicalKey",
            "queryUrn",
            "marker",
            "sqlPath",
            "datasetUrn",
            "fieldPath",
            "sha256",
            "ownerUrns",
            "ownershipType",
        },
        "queryEvidence",
    )
    digest = _string(raw["sha256"], "queryEvidence.sha256")
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise GraphContractError("queryEvidence.sha256 must be a lowercase SHA-256 digest")
    try:
        ownership_type = OwnershipType(_string(raw["ownershipType"], "queryEvidence.ownershipType"))
    except ValueError as error:
        raise GraphContractError(
            f"unsupported query ownershipType: {raw['ownershipType']}"
        ) from error
    owner_urns = _strings(raw["ownerUrns"], "queryEvidence.ownerUrns")
    if not owner_urns:
        raise GraphContractError("queryEvidence.ownerUrns must not be empty")
    return QueryEvidence(
        logical_key=_string(raw["logicalKey"], "queryEvidence.logicalKey"),
        query_urn=_string(raw["queryUrn"], "queryEvidence.queryUrn"),
        marker=_string(raw["marker"], "queryEvidence.marker"),
        sql_path=_string(raw["sqlPath"], "queryEvidence.sqlPath"),
        dataset_urn=_string(raw["datasetUrn"], "queryEvidence.datasetUrn"),
        field_path=_string(raw["fieldPath"], "queryEvidence.fieldPath"),
        sha256=digest,
        owner_urns=owner_urns,
        ownership_type=ownership_type,
    )


def _validate_references(graph: ExpectedGraph) -> None:
    node_by_urn = {node.urn: node for node in graph.nodes}
    owner_urns = {owner.urn for owner in graph.owners}
    tag_urns = {tag.urn for tag in graph.tags}
    logical_keys = {node.logical_key for node in graph.nodes} | {
        query.logical_key for query in graph.query_evidence
    }
    for node in graph.nodes:
        if node.schema_fields != CANONICAL_SCHEMA_FIELDS.get(node.logical_key):
            raise GraphContractError(f"node {node.logical_key} schemaFields mismatch")
        if not set(node.owner_urns) <= owner_urns:
            raise GraphContractError(f"node {node.logical_key} references an unknown owner")
        if not set(node.tag_urns) <= tag_urns:
            raise GraphContractError(f"node {node.logical_key} references an unknown tag")
    for query in graph.query_evidence:
        if not set(query.owner_urns) <= owner_urns:
            raise GraphContractError(f"query {query.logical_key} references an unknown owner")
    for edge in graph.edges:
        upstream = node_by_urn.get(edge.upstream_urn)
        downstream = node_by_urn.get(edge.downstream_urn)
        if upstream is None or downstream is None:
            raise GraphContractError(f"edge {edge.logical_key} references an unknown node")
        if (
            upstream.entity_type is not edge.upstream_type
            or downstream.entity_type is not edge.downstream_type
        ):
            raise GraphContractError(f"edge {edge.logical_key} entity type does not match its node")
    if graph.source_field.dataset_urn not in node_by_urn:
        raise GraphContractError("sourceField datasetUrn is not present in nodes")
    if set(graph.impact_cards) - logical_keys:
        raise GraphContractError("impactCards references an unknown logical key")
    if set(graph.lineage_intermediates) - logical_keys:
        raise GraphContractError("lineageIntermediates references an unknown logical key")


def _validate_canonical_allowlist(graph: ExpectedGraph) -> None:
    if graph.scenario_id != "canonical-customer-id-rename":
        raise GraphContractError("scenarioId is not the immutable canonical scenario")
    if graph.platform_instance != CANONICAL_PREFIX or graph.environment != "PROD":
        raise GraphContractError("canonical target identity mismatch")
    node_types = {node.logical_key: node.entity_type for node in graph.nodes}
    if node_types != CANONICAL_ENTITY_TYPES:
        raise GraphContractError("canonical node/type allowlist mismatch")
    dataset_urns = {node.urn for node in graph.nodes if node.entity_type is EntityType.DATASET}
    expected_dataset_urns = {
        (
            "urn:li:dataset:(urn:li:dataPlatform:postgres,"
            f"{CANONICAL_PREFIX}.lineageguard.{logical_key},PROD)"
        )
        for logical_key, entity_type in CANONICAL_ENTITY_TYPES.items()
        if entity_type is EntityType.DATASET
    }
    if dataset_urns != expected_dataset_urns:
        raise GraphContractError("canonical dataset URN allowlist mismatch")
    orders_urn = next(node.urn for node in graph.nodes if node.logical_key == "commerce.orders")
    expected_source_field_urn = f"urn:li:schemaField:({orders_urn},customer_id)"
    if (
        graph.source_field.logical_key != "commerce.orders.customer_id"
        or graph.source_field.dataset_urn != orders_urn
        or graph.source_field.field_path != "customer_id"
        or graph.source_field.schema_field_urn != expected_source_field_urn
        or graph.source_field.glossary_term_urn
        != "urn:li:glossaryTerm:lineageguard-canonical.CustomerIdentifier"
    ):
        raise GraphContractError("canonical source field allowlist mismatch")
    actual_non_dataset = set(graph.managed_urns) - dataset_urns
    if actual_non_dataset != CANONICAL_NON_DATASET_URNS:
        raise GraphContractError("canonical non-dataset URN allowlist mismatch")
    owner_specs = frozenset(
        (owner.logical_key, owner.urn, owner.display_name) for owner in graph.owners
    )
    if owner_specs != CANONICAL_OWNER_SPECS:
        raise GraphContractError("canonical owner logical/name mapping mismatch")
    tag_specs = frozenset(
        (tag.logical_key, tag.urn, tag.display_name, tag.description) for tag in graph.tags
    )
    if tag_specs != CANONICAL_TAG_SPECS:
        raise GraphContractError("canonical tag logical/name mapping mismatch")
    node_semantics = frozenset(
        (
            node.logical_key,
            node.name,
            node.owner_urns,
            node.ownership_type,
            node.tag_urns,
        )
        for node in graph.nodes
    )
    if node_semantics != CANONICAL_NODE_SEMANTICS:
        raise GraphContractError("canonical node name/owner/tag mapping mismatch")
    if len(graph.query_evidence) != 1:
        raise GraphContractError("canonical query evidence count must equal one")
    query = graph.query_evidence[0]
    if query.sha256 != CANONICAL_QUERY_SHA256:
        raise GraphContractError("canonical query digest mismatch")
    if query.query_urn != CANONICAL_LIVE_QUERY_URN:
        raise GraphContractError("canonical live query URN mismatch")
    if (
        query.logical_key,
        query.marker,
        query.sql_path,
        query.field_path,
        query.owner_urns,
        query.ownership_type,
    ) != CANONICAL_QUERY_SEMANTICS:
        raise GraphContractError("canonical query logical mapping mismatch")
    if (
        query.dataset_urn
        != next(
            node.urn for node in graph.nodes if node.logical_key == "analytics.customer_revenue"
        )
        or query.field_path != "customer_id"
    ):
        raise GraphContractError("canonical query subject mismatch")
    logical_by_urn = {node.urn: node.logical_key for node in graph.nodes}
    actual_edges = {
        (
            edge.logical_key,
            logical_by_urn[edge.upstream_urn],
            logical_by_urn[edge.downstream_urn],
            edge.granularity.value,
            edge.upstream_field_path,
            edge.downstream_field_path,
        )
        for edge in graph.edges
    }
    if actual_edges != CANONICAL_EDGE_SPECS:
        raise GraphContractError("canonical edge allowlist mismatch")
    if graph.impact_cards != CANONICAL_IMPACT_CARDS:
        raise GraphContractError("canonical impact outcomes mismatch")
    if graph.lineage_intermediates != CANONICAL_INTERMEDIATES:
        raise GraphContractError("canonical intermediate outcomes mismatch")


def load_expected_graph(path: Path) -> ExpectedGraph:
    raw = _object(json.loads(path.read_text(encoding="utf-8")), "root")
    _exact_keys(raw, ROOT_KEYS, "root")
    schema_version = raw["schemaVersion"]
    if type(schema_version) is not int or schema_version != 1:
        raise GraphContractError("schemaVersion must equal 1")
    graph = ExpectedGraph(
        schema_version=schema_version,
        scenario_id=_string(raw["scenarioId"], "scenarioId"),
        environment=_string(raw["environment"], "environment"),
        platform_instance=_string(raw["platformInstance"], "platformInstance"),
        source_field=_source_field(raw["sourceField"]),
        owners=tuple(_owner(item) for item in _objects(raw["owners"], "owners")),
        tags=tuple(_tag(item) for item in _objects(raw["tags"], "tags")),
        nodes=tuple(_node(item) for item in _objects(raw["nodes"], "nodes")),
        edges=tuple(_edge(item) for item in _objects(raw["edges"], "edges")),
        query_evidence=tuple(
            _query(item) for item in _objects(raw["queryEvidence"], "queryEvidence")
        ),
        impact_cards=_strings(raw["impactCards"], "impactCards"),
        lineage_intermediates=_strings(raw["lineageIntermediates"], "lineageIntermediates"),
    )
    for values, key, context in (
        (graph.owners, lambda item: item.urn, "owners"),
        (graph.tags, lambda item: item.urn, "tags"),
        (graph.nodes, lambda item: item.urn, "nodes"),
        (graph.edges, lambda item: item.logical_key, "edges"),
        (graph.query_evidence, lambda item: item.logical_key, "queryEvidence"),
    ):
        _unique(values, key, context)
    _validate_references(graph)
    _validate_canonical_allowlist(graph)
    return graph


def graph_fingerprint(graph: ExpectedGraph) -> str:
    payload = {
        "scenario": graph.scenario_id,
        "urns": graph.managed_urns,
        "owners": tuple(
            (owner.logical_key, owner.urn, owner.display_name)
            for owner in sorted(graph.owners, key=lambda item: item.logical_key)
        ),
        "tags": tuple(
            (tag.logical_key, tag.urn, tag.display_name, tag.description)
            for tag in sorted(graph.tags, key=lambda item: item.logical_key)
        ),
        "nodeSemantics": tuple(
            (
                node.logical_key,
                node.name,
                tuple(sorted(node.owner_urns)),
                node.ownership_type,
                tuple(sorted(node.tag_urns)),
                tuple(sorted(node.schema_fields)),
            )
            for node in sorted(graph.nodes, key=lambda item: item.logical_key)
        ),
        "edges": tuple(
            (
                edge.logical_key,
                edge.upstream_urn,
                edge.downstream_urn,
                edge.upstream_type,
                edge.downstream_type,
                edge.granularity,
                edge.upstream_field_path,
                edge.downstream_field_path,
            )
            for edge in sorted(graph.edges, key=lambda item: item.logical_key)
        ),
        "queries": tuple(
            (
                query.logical_key,
                query.sha256,
                tuple(sorted(query.owner_urns)),
                query.ownership_type,
            )
            for query in sorted(graph.query_evidence, key=lambda item: item.logical_key)
        ),
        "impactCards": tuple(sorted(graph.impact_cards)),
        "lineageIntermediates": tuple(sorted(graph.lineage_intermediates)),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()
