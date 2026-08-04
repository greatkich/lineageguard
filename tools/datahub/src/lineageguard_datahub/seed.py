from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from datahub.emitter.mce_builder import make_schema_field_urn
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    AuditStampClass,
    BaseDataClass,
    ChangeAuditStampsClass,
    CorpGroupInfoClass,
    DashboardInfoClass,
    DatasetLineageTypeClass,
    DatasetPropertiesClass,
    FineGrainedLineageClass,
    FineGrainedLineageDownstreamTypeClass,
    FineGrainedLineageUpstreamTypeClass,
    GlobalTagsClass,
    GlossaryTermAssociationClass,
    GlossaryTermInfoClass,
    GlossaryTermsClass,
    MLModelPropertiesClass,
    NumberTypeClass,
    OtherSchemaClass,
    OwnerClass,
    OwnershipClass,
    OwnershipTypeClass,
    QueryPropertiesClass,
    QuerySourceClass,
    QueryStatementClass,
    QuerySubjectClass,
    QuerySubjectsClass,
    SchemaFieldClass,
    SchemaFieldDataTypeClass,
    SchemaMetadataClass,
    StringTypeClass,
    TagAssociationClass,
    TagPropertiesClass,
    TrainingDataClass,
    UpstreamClass,
    UpstreamLineageClass,
)

from lineageguard_datahub.lineage import edges_by_downstream
from lineageguard_datahub.models import EntityType, ExpectedGraph, Granularity, GraphNode

ACTOR_URN = "urn:li:corpuser:lineageguard"
AUDIT_STAMP = AuditStampClass(time=0, actor=ACTOR_URN)


class McpEmitter(Protocol):
    def emit_mcp(self, mcp: MetadataChangeProposalWrapper) -> object: ...


@dataclass(frozen=True, slots=True)
class PlannedUpsert:
    logical_key: str
    proposal: MetadataChangeProposalWrapper
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class SeedReceipt:
    scenario_id: str
    emitted: int
    idempotency_keys: tuple[str, ...]


def _idempotency_key(proposal: MetadataChangeProposalWrapper) -> str:
    encoded = json.dumps(proposal.to_obj(), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _upsert(logical_key: str, urn: str, entity_type: str, aspect: object) -> PlannedUpsert:
    proposal = MetadataChangeProposalWrapper(
        entityType=entity_type,
        entityUrn=urn,
        aspect=aspect,  # type: ignore[arg-type]
    )
    return PlannedUpsert(logical_key, proposal, _idempotency_key(proposal))


def _ownership(node: GraphNode) -> OwnershipClass:
    return OwnershipClass(
        owners=[
            OwnerClass(owner=owner_urn, type=OwnershipTypeClass.TECHNICAL_OWNER)
            for owner_urn in node.owner_urns
        ],
        lastModified=AUDIT_STAMP,
    )


def _tags(node: GraphNode) -> GlobalTagsClass:
    return GlobalTagsClass(tags=[TagAssociationClass(tag=tag_urn) for tag_urn in node.tag_urns])


def _field(
    name: str, native_type: str, *, number: bool = False, term_urn: str | None = None
) -> SchemaFieldClass:
    terms = None
    if term_urn is not None:
        terms = GlossaryTermsClass(
            terms=[GlossaryTermAssociationClass(urn=term_urn, actor=ACTOR_URN)],
            auditStamp=AUDIT_STAMP,
        )
    field_type = (
        NumberTypeClass()  # type: ignore[no-untyped-call]
        if number
        else StringTypeClass()  # type: ignore[no-untyped-call]
    )
    return SchemaFieldClass(
        fieldPath=name,
        type=SchemaFieldDataTypeClass(type=field_type),
        nativeDataType=native_type,
        nullable=False,
        glossaryTerms=terms,
    )


def _schema_for(node: GraphNode, graph: ExpectedGraph) -> SchemaMetadataClass:
    fields_by_key = {
        "commerce.orders": [
            _field("order_id", "uuid"),
            _field("customer_id", "uuid", term_urn=graph.source_field.glossary_term_urn),
            _field("order_total", "numeric(12,2)", number=True),
            _field("ordered_at", "timestamptz"),
        ],
        "analytics.stg_orders": [
            _field("order_id", "uuid"),
            _field("customer_id", "uuid"),
            _field("order_total", "numeric(12,2)", number=True),
            _field("ordered_at", "timestamptz"),
        ],
        "analytics.customer_revenue": [
            _field("customer_id", "uuid"),
            _field("lifetime_revenue", "numeric", number=True),
        ],
        "fraud.customer_features": [
            _field("customer_id", "uuid"),
            _field("order_count", "bigint", number=True),
            _field("max_order_total", "numeric", number=True),
        ],
    }
    fields = fields_by_key[node.logical_key]
    raw_schema = json.dumps(
        {"fields": [{"name": field.fieldPath, "type": field.nativeDataType} for field in fields]},
        sort_keys=True,
    )
    return SchemaMetadataClass(
        schemaName=node.logical_key,
        platform="urn:li:dataPlatform:postgres",
        version=0,
        hash=hashlib.sha256(raw_schema.encode()).hexdigest(),
        platformSchema=OtherSchemaClass(rawSchema=raw_schema),
        fields=fields,
        created=AUDIT_STAMP,
        lastModified=AUDIT_STAMP,
    )


def _node_aspects(node: GraphNode, graph: ExpectedGraph) -> list[PlannedUpsert]:
    upserts: list[PlannedUpsert] = []
    if node.entity_type is EntityType.DATASET:
        upserts.extend(
            [
                _upsert(
                    f"{node.logical_key}:properties",
                    node.urn,
                    "dataset",
                    DatasetPropertiesClass(
                        name=node.name,
                        qualifiedName=node.logical_key,
                        description=f"Canonical LineageGuard asset: {node.logical_key}.",
                        customProperties={"lineageguard.scenario": graph.scenario_id},
                    ),
                ),
                _upsert(
                    f"{node.logical_key}:schema",
                    node.urn,
                    "dataset",
                    _schema_for(node, graph),
                ),
            ]
        )
    elif node.entity_type is EntityType.DASHBOARD:
        revenue_urn = next(
            item.urn for item in graph.nodes if item.logical_key == "analytics.customer_revenue"
        )
        upserts.append(
            _upsert(
                f"{node.logical_key}:info",
                node.urn,
                "dashboard",
                DashboardInfoClass(
                    title=node.name,
                    description="Finance revenue monitoring and monthly close dashboard.",
                    lastModified=ChangeAuditStampsClass(
                        created=AUDIT_STAMP, lastModified=AUDIT_STAMP
                    ),
                    datasets=[revenue_urn],
                    customProperties={"lineageguard.scenario": graph.scenario_id},
                ),
            )
        )
    elif node.entity_type is EntityType.MLMODEL:
        feature_urn = next(
            item.urn for item in graph.nodes if item.logical_key == "fraud.customer_features"
        )
        upserts.extend(
            [
                _upsert(
                    f"{node.logical_key}:properties",
                    node.urn,
                    "mlModel",
                    MLModelPropertiesClass(
                        name=node.name,
                        description="Production fraud scoring model using customer order features.",
                        version=None,
                        type="classification",
                        customProperties={"lineageguard.scenario": graph.scenario_id},
                    ),
                ),
                _upsert(
                    f"{node.logical_key}:training-data",
                    node.urn,
                    "mlModel",
                    TrainingDataClass(
                        trainingData=[
                            BaseDataClass(
                                dataset=feature_urn,
                                motivation="Customer order behavior features for fraud scoring.",
                            )
                        ]
                    ),
                ),
            ]
        )
    if node.owner_urns:
        upserts.append(
            _upsert(f"{node.logical_key}:ownership", node.urn, _entity_name(node), _ownership(node))
        )
    if node.tag_urns:
        upserts.append(
            _upsert(f"{node.logical_key}:tags", node.urn, _entity_name(node), _tags(node))
        )
    return upserts


def _entity_name(node: GraphNode) -> str:
    return {
        EntityType.DATASET: "dataset",
        EntityType.DASHBOARD: "dashboard",
        EntityType.MLMODEL: "mlModel",
    }[node.entity_type]


def _lineage_aspect(graph: ExpectedGraph, downstream_urn: str) -> UpstreamLineageClass:
    edges = edges_by_downstream(graph)[downstream_urn]
    upstreams = [
        UpstreamClass(dataset=edge.upstream_urn, type=DatasetLineageTypeClass.TRANSFORMED)
        for edge in edges
    ]
    fine_grained = [
        FineGrainedLineageClass(
            upstreamType=FineGrainedLineageUpstreamTypeClass.FIELD_SET,
            downstreamType=FineGrainedLineageDownstreamTypeClass.FIELD,
            upstreams=[make_schema_field_urn(edge.upstream_urn, edge.upstream_field_path or "")],
            downstreams=[
                make_schema_field_urn(edge.downstream_urn, edge.downstream_field_path or "")
            ],
            transformOperation="IDENTITY",
            confidenceScore=1.0,
        )
        for edge in edges
        if edge.granularity is Granularity.FIELD
    ]
    return UpstreamLineageClass(upstreams=upstreams, fineGrainedLineages=fine_grained or None)


def build_seed_plan(graph: ExpectedGraph, root: Path) -> tuple[PlannedUpsert, ...]:
    upserts: list[PlannedUpsert] = []
    for owner in graph.owners:
        upserts.append(
            _upsert(
                f"{owner.logical_key}:info",
                owner.urn,
                "corpGroup",
                CorpGroupInfoClass(
                    admins=[],
                    members=[],
                    groups=[],
                    displayName=owner.display_name,
                    description=f"Canonical owner group: {owner.display_name}.",
                ),
            )
        )
    for tag in graph.tags:
        upserts.append(
            _upsert(
                f"{tag.logical_key}:properties",
                tag.urn,
                "tag",
                TagPropertiesClass(
                    name=tag.display_name,
                    description=f"LineageGuard {tag.display_name.lower()} asset classification.",
                ),
            )
        )
    upserts.append(
        _upsert(
            "customer-identifier:term-info",
            graph.source_field.glossary_term_urn,
            "glossaryTerm",
            GlossaryTermInfoClass(
                name="Customer Identifier",
                definition=(
                    "Stable identifier that joins customer activity across controlled systems."
                ),
                termSource="INTERNAL",
                customProperties={"lineageguard.scenario": graph.scenario_id},
            ),
        )
    )
    for node in graph.nodes:
        upserts.extend(_node_aspects(node, graph))
    node_types = {node.urn: _entity_name(node) for node in graph.nodes}
    for downstream_urn in sorted(edges_by_downstream(graph)):
        if node_types[downstream_urn] != "dataset":
            continue
        upserts.append(
            _upsert(
                f"lineage:{downstream_urn}",
                downstream_urn,
                node_types[downstream_urn],
                _lineage_aspect(graph, downstream_urn),
            )
        )
    for query in graph.query_evidence:
        statement = (root / query.sql_path).read_text(encoding="utf-8")
        upserts.extend(
            [
                _upsert(
                    f"{query.logical_key}:properties",
                    query.query_urn,
                    "query",
                    QueryPropertiesClass(
                        statement=QueryStatementClass(value=statement, language="SQL"),
                        source=QuerySourceClass.MANUAL,
                        created=AUDIT_STAMP,
                        lastModified=AUDIT_STAMP,
                        name="Finance monthly close",
                        description=(
                            "Unmanaged Finance query captured as organizational usage evidence."
                        ),
                        customProperties={
                            "lineageguard.marker": query.marker,
                            "lineageguard.sha256": query.sha256,
                            "lineageguard.fieldPath": query.field_path,
                            "lineageguard.ownerUrn": query.owner_urn,
                        },
                    ),
                ),
                _upsert(
                    f"{query.logical_key}:subjects",
                    query.query_urn,
                    "query",
                    QuerySubjectsClass(subjects=[QuerySubjectClass(entity=query.dataset_urn)]),
                ),
            ]
        )
    keys = [item.idempotency_key for item in upserts]
    if len(keys) != len(set(keys)):
        raise ValueError("DUPLICATE_METADATA_UPSERT")
    return tuple(upserts)


def seed_metadata(emitter: McpEmitter, graph: ExpectedGraph, root: Path) -> SeedReceipt:
    plan = build_seed_plan(graph, root)
    for operation in plan:
        emitter.emit_mcp(operation.proposal)
    return SeedReceipt(
        scenario_id=graph.scenario_id,
        emitted=len(plan),
        idempotency_keys=tuple(operation.idempotency_key for operation in plan),
    )
