from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, TypeVar

from datahub._codegen.aspect import _Aspect
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
    DomainPropertiesClass,
    DomainsClass,
    FineGrainedLineageClass,
    FineGrainedLineageDownstreamTypeClass,
    FineGrainedLineageUpstreamTypeClass,
    GlobalTagsClass,
    GlossaryTermAssociationClass,
    GlossaryTermInfoClass,
    GlossaryTermsClass,
    MLModelPropertiesClass,
    OwnerClass,
    OwnershipClass,
    OwnershipTypeClass,
    QueryPropertiesClass,
    SchemaMetadataClass,
    StatusClass,
    TagAssociationClass,
    TagPropertiesClass,
    TrainingDataClass,
    UpstreamClass,
    UpstreamLineageClass,
)

from lineageguard_datahub.ingestion import (
    build_ingestion_plan,
    dbt_artifact_metrics,
    dbt_project_fingerprint,
    ingestion_snapshot_fingerprint,
    require_ingestion_prerequisites,
    verify_dbt_ingestion_artifacts,
)
from lineageguard_datahub.lineage import edges_by_downstream
from lineageguard_datahub.models import EntityType, ExpectedGraph, Granularity, GraphNode
from lineageguard_datahub.provenance import datahub_target_metrics
from lineageguard_datahub.query_history import plan_query_execution
from lineageguard_datahub.receipts import (
    OperationReceipt,
    ReceiptStatus,
    ReceiptStore,
)
from lineageguard_datahub.target_attestation import TargetAttestor, require_current_target
from lineageguard_datahub.warehouse import SqlCursor, attest_scenario_registry

ACTOR_URN = "urn:li:corpuser:lineageguard"
AUDIT_STAMP = AuditStampClass(time=0, actor=ACTOR_URN)
SCENARIO_MARKER_KEY = "lineageguard.scenario"
SCENARIO_MARKER_VALUE = "canonical-customer-id-rename"
OWNERSHIP_NONCE_KEY = "lineageguard.ownershipNonce"
Aspect = TypeVar("Aspect", bound=_Aspect)


class McpEmitter(Protocol):
    def emit_mcp(self, mcp: MetadataChangeProposalWrapper) -> object: ...


class McpEmitterFactory(Protocol):
    def __call__(self) -> McpEmitter: ...


class EntityReader(Protocol):
    def exists(self, entity_urn: str) -> bool: ...

    def get_aspect(
        self, entity_urn: str, aspect_type: type[Aspect], version: int = 0
    ) -> Aspect | None: ...


@dataclass(frozen=True, slots=True)
class PlannedUpsert:
    logical_key: str
    proposal: MetadataChangeProposalWrapper
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class SeedReceipt:
    scenario_id: str
    emitted: int
    skipped: int
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
    if node.ownership_type is None:
        raise ValueError(f"OWNERSHIP_TYPE_REQUIRED:{node.logical_key}")
    owner_type = {
        "BUSINESS_OWNER": OwnershipTypeClass.BUSINESS_OWNER,
        "TECHNICAL_OWNER": OwnershipTypeClass.TECHNICAL_OWNER,
    }[node.ownership_type.value]
    return OwnershipClass(
        owners=[OwnerClass(owner=owner_urn, type=owner_type) for owner_urn in node.owner_urns],
        lastModified=AUDIT_STAMP,
    )


def _tags(node: GraphNode) -> GlobalTagsClass:
    return GlobalTagsClass(tags=[TagAssociationClass(tag=tag_urn) for tag_urn in node.tag_urns])


def _marker_properties(ownership_nonce: str) -> dict[str, str]:
    return {
        SCENARIO_MARKER_KEY: SCENARIO_MARKER_VALUE,
        OWNERSHIP_NONCE_KEY: ownership_nonce,
    }


def _marker_text(ownership_nonce: str) -> str:
    return (
        f"[{SCENARIO_MARKER_KEY}={SCENARIO_MARKER_VALUE};{OWNERSHIP_NONCE_KEY}={ownership_nonce}]"
    )


def _node_aspects(
    node: GraphNode, graph: ExpectedGraph, ownership_nonce: str
) -> list[PlannedUpsert]:
    upserts: list[PlannedUpsert] = []
    if node.entity_type is EntityType.DASHBOARD:
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
                    customProperties=_marker_properties(ownership_nonce),
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
                        customProperties=_marker_properties(ownership_nonce),
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
    if node.domain_urn is not None:
        upserts.append(
            _upsert(
                f"{node.logical_key}:domains",
                node.urn,
                _entity_name(node),
                DomainsClass(domains=[node.domain_urn]),
            )
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


_DBT_SIBLING_URN_PATTERN = re.compile(
    r"^urn:li:dataset:\(urn:li:dataPlatform:postgres,(?P<suffix>.+),PROD\)$"
)


def _expected_dbt_sibling_urn(downstream_urn: str) -> str | None:
    """The dbt source connector's own sibling-lineage upstream for a canonical dataset.

    DataHub's dbt ingestion source always emits an entity-level ``COPY`` upstream from
    the dbt-platform sibling entity onto its target-platform (postgres) sibling. That
    edge is a byproduct of the connector's sibling model, not something LineageGuard
    controls, and it targets a URN this function can derive deterministically: same
    platform-instance-qualified suffix, ``dataPlatform:dbt`` instead of
    ``dataPlatform:postgres``.
    """
    match = _DBT_SIBLING_URN_PATTERN.match(downstream_urn)
    if match is None:
        return None
    return f"urn:li:dataset:(urn:li:dataPlatform:dbt,{match.group('suffix')},PROD)"


def _is_expected_dbt_sibling_upstream(upstream: UpstreamClass, downstream_urn: str) -> bool:
    expected_sibling_urn = _expected_dbt_sibling_urn(downstream_urn)
    return (
        expected_sibling_urn is not None
        and upstream.dataset == expected_sibling_urn
        and upstream.type == DatasetLineageTypeClass.COPY
    )


def _upstream_sort_key(upstream: UpstreamClass) -> tuple[str, str]:
    return (upstream.dataset, str(upstream.type))


def _fine_grained_sort_key(fine_grained: FineGrainedLineageClass) -> tuple[str, ...]:
    return (
        str(fine_grained.upstreamType),
        str(fine_grained.downstreamType),
        str(fine_grained.transformOperation),
        *sorted(fine_grained.upstreams or []),
        *sorted(fine_grained.downstreams or []),
    )


def reconcile_lineage_aspect(
    graph: ExpectedGraph,
    downstream_urn: str,
    current: UpstreamLineageClass | None,
) -> UpstreamLineageClass:
    """Merge LineageGuard's canonical lineage overlay with the connector's live aspect.

    The dbt source connector is allowed to emit its own native (entity-level, sibling)
    lineage on a connector-owned dataset. This function no longer requires the entire
    existing ``UpstreamLineage`` aspect to exactly equal LineageGuard's overlay. Instead
    it deterministically:

    1. reads the existing aspect (``current``, possibly ``None``);
    2. recognizes and preserves the expected connector-emitted edge (the dbt sibling
       ``COPY`` upstream), if present;
    3. adds the canonical field-level lineage LineageGuard requires, if missing;
    4. deduplicates the merged result deterministically (stable sort order, no
       duplicate upstream/fine-grained entries);
    5. rejects any other, unrecognized upstream as a foreign edge (fail closed) —
       LineageGuard never silently absorbs or overwrites lineage it cannot attribute
       to either its own canonical overlay or the one connector behavior it knows
       about.
    """
    canonical = _lineage_aspect(graph, downstream_urn)
    canonical_upstream_datasets = {upstream.dataset for upstream in canonical.upstreams}
    existing_upstreams = list(current.upstreams) if current is not None else []
    preserved_upstreams: list[UpstreamClass] = []
    for upstream in existing_upstreams:
        if upstream.dataset in canonical_upstream_datasets:
            # LineageGuard's own canonical upstream is added back below with its
            # canonical (TRANSFORMED) type; an existing entry for the same dataset is
            # superseded by the canonical value, not treated as foreign.
            continue
        if _is_expected_dbt_sibling_upstream(upstream, downstream_urn):
            preserved_upstreams.append(upstream)
            continue
        raise ValueError(f"LINEAGE_FOREIGN_EDGE_REJECTED:{downstream_urn}:{upstream.dataset}")
    merged_upstreams = sorted(
        {(u.dataset, u.type): u for u in (*preserved_upstreams, *canonical.upstreams)}.values(),
        key=_upstream_sort_key,
    )
    existing_fine_grained = list(current.fineGrainedLineages or []) if current is not None else []
    canonical_fine_grained = list(canonical.fineGrainedLineages or [])
    canonical_fine_grained_keys = {
        _fine_grained_sort_key(item) for item in canonical_fine_grained
    }
    preserved_fine_grained = [
        item
        for item in existing_fine_grained
        if _fine_grained_sort_key(item) not in canonical_fine_grained_keys
    ]
    for item in preserved_fine_grained:
        upstream_datasets = {
            _dataset_urn_from_schema_field_urn(urn) for urn in (item.upstreams or [])
        }
        if not all(
            dataset is not None and _is_expected_dbt_sibling_dataset(dataset, downstream_urn)
            for dataset in upstream_datasets
        ):
            raise ValueError(
                f"LINEAGE_FOREIGN_FIELD_EDGE_REJECTED:{downstream_urn}:"
                f"{sorted(item.upstreams or [])}"
            )
    merged_fine_grained = sorted(
        {
            _fine_grained_sort_key(item): item
            for item in (*preserved_fine_grained, *canonical_fine_grained)
        }.values(),
        key=_fine_grained_sort_key,
    )
    return UpstreamLineageClass(
        upstreams=merged_upstreams,
        fineGrainedLineages=merged_fine_grained or None,
    )


_SCHEMA_FIELD_URN_PATTERN = re.compile(r"^urn:li:schemaField:\((?P<dataset>.+),[^,]+\)$")


def _dataset_urn_from_schema_field_urn(schema_field_urn: str) -> str | None:
    match = _SCHEMA_FIELD_URN_PATTERN.match(schema_field_urn)
    return None if match is None else match.group("dataset")


def _is_expected_dbt_sibling_dataset(dataset_urn: str, downstream_urn: str) -> bool:
    return dataset_urn == _expected_dbt_sibling_urn(downstream_urn)


def _connector_entity_exists(reader: EntityReader, urn: str) -> bool:
    """Existence check tolerant of schema-field URNs.

    A schema field is not a standalone DataHub entity with its own key aspect; it is
    part of the parent dataset's ``SchemaMetadata``. The generic ``reader.exists()``
    (backed by the official SDK's key-aspect lookup) can therefore never confirm a
    schema field exists, even when the ingesting connector has already published it.
    For schema-field URNs, treat the field as present if either the generic existence
    check succeeds (covering readers/fixtures that model schema fields directly) or
    the parent dataset's schema lists a matching field path (the real DataHub SDK
    reader's behavior).
    """
    if reader.exists(urn):
        return True
    dataset_urn = _dataset_urn_from_schema_field_urn(urn)
    if dataset_urn is None:
        return False
    field_path = urn.rsplit(",", 1)[-1].rstrip(")")
    schema = reader.get_aspect(dataset_urn, SchemaMetadataClass)
    return schema is not None and any(field.fieldPath == field_path for field in schema.fields)


def build_seed_plan(
    graph: ExpectedGraph,
    root: Path,
    ownership_nonce: str = "offline-plan",
    reader: EntityReader | None = None,
) -> tuple[PlannedUpsert, ...]:
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
                    description=(
                        f"Canonical owner group: {owner.display_name}. "
                        f"{_marker_text(ownership_nonce)}"
                    ),
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
                    description=f"{tag.description} {_marker_text(ownership_nonce)}",
                ),
            )
        )
    for domain in graph.domains:
        upserts.append(
            _upsert(
                f"{domain.logical_key}:properties",
                domain.urn,
                "domain",
                DomainPropertiesClass(
                    name=domain.display_name,
                    description=domain.description,
                    customProperties=_marker_properties(ownership_nonce),
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
                customProperties=_marker_properties(ownership_nonce),
            ),
        )
    )
    upserts.append(
        _upsert(
            "commerce.orders.customer_id:glossary-terms",
            graph.source_field.schema_field_urn,
            "schemaField",
            GlossaryTermsClass(
                terms=[
                    GlossaryTermAssociationClass(
                        urn=graph.source_field.glossary_term_urn,
                        actor=ACTOR_URN,
                    )
                ],
                auditStamp=AUDIT_STAMP,
            ),
        )
    )
    for node in graph.nodes:
        upserts.extend(_node_aspects(node, graph, ownership_nonce))
    node_types = {node.urn: _entity_name(node) for node in graph.nodes}
    for downstream_urn in sorted(edges_by_downstream(graph)):
        if node_types[downstream_urn] != "dataset":
            continue
        lineage_aspect = (
            reconcile_lineage_aspect(
                graph, downstream_urn, reader.get_aspect(downstream_urn, UpstreamLineageClass)
            )
            if reader is not None
            else _lineage_aspect(graph, downstream_urn)
        )
        upserts.append(
            _upsert(
                f"lineage:{downstream_urn}",
                downstream_urn,
                node_types[downstream_urn],
                lineage_aspect,
            )
        )
    seeded_entity_types = {
        operation.proposal.entityUrn: operation.proposal.entityType
        for operation in upserts
        if operation.proposal.entityUrn in graph.owned_urns
        and operation.proposal.entityType != "domain"
    }
    for urn, entity_type in sorted(seeded_entity_types.items()):
        if urn is None:
            raise ValueError("SEED_ENTITY_URN_MISSING")
        upserts.append(
            _upsert(
                f"status:{urn}",
                urn,
                entity_type,
                StatusClass(removed=False),
            )
        )
    keys = [item.idempotency_key for item in upserts]
    if len(keys) != len(set(keys)):
        raise ValueError("DUPLICATE_METADATA_UPSERT")
    return tuple(upserts)


def _marker_aspect(entity_type: str) -> type[_Aspect]:
    return {
        "corpGroup": CorpGroupInfoClass,
        "dashboard": DashboardInfoClass,
        "dataset": DatasetPropertiesClass,
        "domain": DomainPropertiesClass,
        "glossaryTerm": GlossaryTermInfoClass,
        "mlModel": MLModelPropertiesClass,
        "query": QueryPropertiesClass,
        "tag": TagPropertiesClass,
    }[entity_type]


def entity_has_scenario_marker(
    reader: EntityReader, urn: str, entity_type: str, ownership_nonce: str
) -> bool:
    aspect = reader.get_aspect(urn, _marker_aspect(entity_type))
    if aspect is None:
        return False
    if isinstance(aspect, CorpGroupInfoClass | TagPropertiesClass):
        return _marker_text(ownership_nonce) in (aspect.description or "")
    custom_properties = getattr(aspect, "customProperties", None) or {}
    return (
        custom_properties.get(SCENARIO_MARKER_KEY) == SCENARIO_MARKER_VALUE
        and custom_properties.get(OWNERSHIP_NONCE_KEY) == ownership_nonce
    )


def seed_metadata(
    emitter_factory: McpEmitterFactory,
    reader: EntityReader,
    receipt_store: ReceiptStore,
    graph: ExpectedGraph,
    root: Path,
    registry_cursor: SqlCursor,
    *,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
    attest_target: TargetAttestor,
) -> SeedReceipt:
    with receipt_store.scenario_operation(graph.scenario_id, "seed"):
        require_current_target(
            attest_target,
            target_attestation=target_attestation,
            target_fingerprint=target_fingerprint,
        )
        attest_scenario_registry(
            registry_cursor,
            ownership_nonce=receipt_store.ownership_nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
        )
        emitter = emitter_factory()
        return _seed_metadata_under_lock(
            emitter,
            reader,
            receipt_store,
            graph,
            root,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
            target_attestation=target_attestation,
            target_fingerprint=target_fingerprint,
        )


def _seed_metadata_under_lock(
    emitter: McpEmitter,
    reader: EntityReader,
    receipt_store: ReceiptStore,
    graph: ExpectedGraph,
    root: Path,
    *,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
) -> SeedReceipt:
    nonce = receipt_store.ownership_nonce
    artifacts = verify_dbt_ingestion_artifacts(root)
    artifact_metrics = dbt_artifact_metrics(artifacts)
    project_fingerprint = dbt_project_fingerprint(root)
    snapshot_fingerprint = ingestion_snapshot_fingerprint(build_ingestion_plan(root), artifacts)
    require_ingestion_prerequisites(
        receipt_store.read_all(),
        scenario_id=graph.scenario_id,
        ownership_nonce=nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
        target_attestation=target_attestation,
        target_fingerprint=target_fingerprint,
        dbt_project_sha256=project_fingerprint,
        artifact_metrics=artifact_metrics,
        snapshot_fingerprint=snapshot_fingerprint,
        query_fingerprint=plan_query_execution(
            root, graph.query_evidence[0]
        ).normalized_fingerprint,
    )
    plan = build_seed_plan(graph, root, nonce, reader)
    target_metrics: dict[str, int | float | str] = (
        datahub_target_metrics(
            nonce,
            warehouse_target_fingerprint,
            target_attestation,
            target_fingerprint,
        )
        | artifact_metrics
        | {
            "dbtProjectFingerprint": project_fingerprint,
            "ingestionSnapshotFingerprint": snapshot_fingerprint,
        }
    )
    for operation in plan:
        receipt_store.append(
            OperationReceipt.create(
                scenario_id=graph.scenario_id,
                operation_kind="seed",
                entity_urn=operation.proposal.entityUrn,
                aspect_name=operation.proposal.aspectName,
                idempotency_key=operation.idempotency_key,
                status=ReceiptStatus.PLANNED,
                detail_code="OPERATION_PLANNED",
                proposal_hash=operation.idempotency_key,
                ownership_nonce=nonce,
                metrics=target_metrics | {"beforeStatus": "UNKNOWN", "afterStatus": "PLANNED"},
            )
        )
    by_entity: dict[tuple[str, str], list[PlannedUpsert]] = {}
    for operation in plan:
        urn = operation.proposal.entityUrn
        if urn is None:
            raise ValueError("SEED_ENTITY_URN_MISSING")
        by_entity.setdefault((urn, operation.proposal.entityType), []).append(operation)
    receipts = receipt_store.read_all()
    connector_references = {
        *graph.connector_dataset_urns,
        graph.source_field.schema_field_urn,
    }
    created_receipts = {
        receipt.entity_urn: receipt
        for receipt in receipts
        if receipt.scenario_id == graph.scenario_id
        and receipt.operation_kind == "entity"
        and receipt.status is ReceiptStatus.SUCCESS
        and receipt.detail_code == "ENTITY_CREATED"
        and receipt.ownership_nonce == nonce
    }
    preexisting_exact: set[str] = set()
    owned: set[str] = set()
    for (urn, entity_type), operations in by_entity.items():
        if urn in connector_references:
            if not _connector_entity_exists(reader, urn):
                operation = operations[0]
                receipt_store.append(
                    OperationReceipt.create(
                        scenario_id=graph.scenario_id,
                        operation_kind="seed",
                        entity_urn=urn,
                        aspect_name=operation.proposal.aspectName,
                        idempotency_key=operation.idempotency_key,
                        status=ReceiptStatus.RECONCILIATION_REQUIRED,
                        detail_code="CONNECTOR_ENTITY_REQUIRED",
                        proposal_hash=operation.idempotency_key,
                        ownership_nonce=nonce,
                        metrics=target_metrics,
                    )
                )
                raise ValueError(f"CONNECTOR_ENTITY_REQUIRED:{urn}")
            for operation in operations:
                aspect = operation.proposal.aspect
                if aspect is None:
                    raise ValueError("SEED_ASPECT_MISSING")
                if isinstance(aspect, UpstreamLineageClass):
                    # Lineage aspects are reconciled against the live connector-emitted
                    # aspect when the plan is built (reconcile_lineage_aspect already
                    # rejected any foreign edge at that point); a diff here is an
                    # expected, safe additive change, not a conflict.
                    continue
                current = reader.get_aspect(urn, type(aspect))
                if current is not None and current.to_obj() != aspect.to_obj():
                    receipt_store.append(
                        OperationReceipt.create(
                            scenario_id=graph.scenario_id,
                            operation_kind="seed",
                            entity_urn=urn,
                            aspect_name=operation.proposal.aspectName,
                            idempotency_key=operation.idempotency_key,
                            status=ReceiptStatus.RECONCILIATION_REQUIRED,
                            detail_code="CONNECTOR_OVERLAY_CONFLICT",
                            proposal_hash=operation.idempotency_key,
                            ownership_nonce=nonce,
                            metrics=target_metrics,
                        )
                    )
                    raise ValueError(
                        f"CONNECTOR_OVERLAY_CONFLICT:{urn}:{operation.proposal.aspectName}"
                    )
            continue
        if not reader.exists(urn):
            continue
        exact = all(
            operation.proposal.aspect is not None
            and (current := reader.get_aspect(urn, type(operation.proposal.aspect))) is not None
            and current.to_obj() == operation.proposal.aspect.to_obj()
            for operation in operations
        )
        if exact:
            preexisting_exact.add(urn)
            continue
        entity_hash = _entity_proposal_hash(operations)
        creation = created_receipts.get(urn)
        if (
            creation is None
            or creation.proposal_hash != entity_hash
            or not entity_has_scenario_marker(reader, urn, entity_type, nonce)
        ):
            operation = operations[0]
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="seed",
                    entity_urn=urn,
                    aspect_name=operation.proposal.aspectName,
                    idempotency_key=operation.idempotency_key,
                    status=ReceiptStatus.RECONCILIATION_REQUIRED,
                    detail_code="EXISTING_ENTITY_NOT_OWNED",
                    proposal_hash=operation.idempotency_key,
                    ownership_nonce=nonce,
                    metrics=target_metrics,
                )
            )
            raise ValueError(f"EXISTING_ENTITY_NOT_OWNED:{urn}")
        owned.add(urn)
        for operation in operations:
            aspect = operation.proposal.aspect
            if aspect is None:
                raise ValueError("SEED_ASPECT_MISSING")
            current = reader.get_aspect(urn, type(aspect))
            if current is not None and current.to_obj() != aspect.to_obj():
                if (
                    isinstance(aspect, StatusClass)
                    and isinstance(current, StatusClass)
                    and current.removed is True
                    and aspect.removed is False
                ):
                    continue
                receipt_store.append(
                    OperationReceipt.create(
                        scenario_id=graph.scenario_id,
                        operation_kind="seed",
                        entity_urn=urn,
                        aspect_name=operation.proposal.aspectName,
                        idempotency_key=operation.idempotency_key,
                        status=ReceiptStatus.RECONCILIATION_REQUIRED,
                        detail_code="OWNED_ASPECT_DRIFT",
                        proposal_hash=operation.idempotency_key,
                        ownership_nonce=nonce,
                        metrics=target_metrics,
                    )
                )
                raise ValueError(f"OWNED_ASPECT_DRIFT:{urn}:{operation.proposal.aspectName}")
    emitted = 0
    skipped = 0
    for operation in plan:
        proposal = operation.proposal
        urn = proposal.entityUrn
        if urn is None:
            raise ValueError("SEED_ENTITY_URN_MISSING")
        aspect = proposal.aspect
        if aspect is None:
            raise ValueError("SEED_ASPECT_MISSING")
        current = reader.get_aspect(urn, type(aspect))
        if current is not None and current.to_obj() == aspect.to_obj():
            skipped += 1
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="seed",
                    entity_urn=proposal.entityUrn,
                    aspect_name=proposal.aspectName,
                    idempotency_key=operation.idempotency_key,
                    status=ReceiptStatus.SKIPPED,
                    detail_code="ASPECT_SKIPPED_EXACT",
                    proposal_hash=operation.idempotency_key,
                    ownership_nonce=nonce,
                    metrics=target_metrics | {"beforeStatus": "EXACT", "afterStatus": "UNCHANGED"},
                )
            )
            continue
        try:
            emitter.emit_mcp(proposal)
        except Exception as error:
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="seed",
                    entity_urn=proposal.entityUrn,
                    aspect_name=proposal.aspectName,
                    idempotency_key=operation.idempotency_key,
                    status=ReceiptStatus.FAILURE,
                    detail_code=type(error).__name__,
                    proposal_hash=operation.idempotency_key,
                    ownership_nonce=nonce,
                    metrics=target_metrics | {"beforeStatus": "MISSING", "afterStatus": "FAILED"},
                )
            )
            raise
        emitted += 1
        receipt_store.append(
            OperationReceipt.create(
                scenario_id=graph.scenario_id,
                operation_kind="seed",
                entity_urn=proposal.entityUrn,
                aspect_name=proposal.aspectName,
                idempotency_key=operation.idempotency_key,
                status=ReceiptStatus.SUCCESS,
                detail_code="ASPECT_RECONCILED" if urn in owned else "ASPECT_EMITTED",
                proposal_hash=operation.idempotency_key,
                ownership_nonce=nonce,
                metrics=target_metrics | {"beforeStatus": "MISSING", "afterStatus": "EMITTED"},
            )
        )
        if urn not in connector_references and urn not in preexisting_exact and urn not in owned:
            operations = by_entity[(urn, proposal.entityType)]
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="entity",
                    entity_urn=urn,
                    aspect_name=None,
                    idempotency_key=hashlib.sha256(
                        f"entity:{graph.scenario_id}:{urn}".encode()
                    ).hexdigest(),
                    status=ReceiptStatus.SUCCESS,
                    detail_code="ENTITY_CREATED",
                    proposal_hash=_entity_proposal_hash(operations),
                    ownership_nonce=nonce,
                    metrics=target_metrics | {"beforeStatus": "ABSENT", "afterStatus": "CREATED"},
                )
            )
            owned.add(urn)
    return SeedReceipt(
        scenario_id=graph.scenario_id,
        emitted=emitted,
        skipped=skipped,
        idempotency_keys=tuple(operation.idempotency_key for operation in plan),
    )


def _entity_proposal_hash(operations: list[PlannedUpsert]) -> str:
    payload = "\n".join(sorted(operation.idempotency_key for operation in operations))
    return hashlib.sha256(payload.encode()).hexdigest()


def reconcile_seed_metadata(
    reader: EntityReader,
    receipt_store: ReceiptStore,
    graph: ExpectedGraph,
    root: Path,
    registry_cursor: SqlCursor,
    *,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
    attest_target: TargetAttestor,
) -> int:
    """Resolve an interrupted seed only after comparing every pending aspect to live state."""
    nonce = receipt_store.ownership_nonce
    artifacts = verify_dbt_ingestion_artifacts(root)
    artifact_metrics = dbt_artifact_metrics(artifacts)
    project_fingerprint = dbt_project_fingerprint(root)
    snapshot_fingerprint = ingestion_snapshot_fingerprint(build_ingestion_plan(root), artifacts)
    metrics: dict[str, int | float | str] = (
        datahub_target_metrics(
            nonce,
            warehouse_target_fingerprint,
            target_attestation,
            target_fingerprint,
        )
        | artifact_metrics
        | {
            "dbtProjectFingerprint": project_fingerprint,
            "ingestionSnapshotFingerprint": snapshot_fingerprint,
        }
    )
    plan = build_seed_plan(graph, root, nonce, reader)
    by_identity = {
        (
            operation.proposal.entityUrn,
            operation.proposal.aspectName,
            operation.idempotency_key,
        ): operation
        for operation in plan
    }
    reconciled = 0
    with receipt_store.scenario_operation(
        graph.scenario_id, "seed-reconcile", reconciliation=True
    ) as unresolved:
        require_current_target(
            attest_target,
            target_attestation=target_attestation,
            target_fingerprint=target_fingerprint,
        )
        attest_scenario_registry(
            registry_cursor,
            ownership_nonce=nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
        )
        foreign = [item for item in unresolved if item.operation_kind != "seed"]
        if foreign:
            raise ValueError("SEED_RECONCILIATION_FOREIGN_OPERATION")
        if not unresolved:
            raise ValueError("SEED_RECONCILIATION_NOT_REQUIRED")
        applied_after_failure: set[str] = set()
        for pending in unresolved:
            operation = by_identity.get(
                (pending.entity_urn, pending.aspect_name, pending.idempotency_key)
            )
            if operation is None or operation.proposal.entityUrn is None:
                raise ValueError("SEED_RECONCILIATION_PLAN_MISMATCH")
            if any(pending.metrics.get(key) != value for key, value in metrics.items()):
                raise ValueError("SEED_RECONCILIATION_PROVENANCE_MISMATCH")
            expected = operation.proposal.aspect
            if expected is None:
                raise ValueError("SEED_ASPECT_MISSING")
            current = reader.get_aspect(operation.proposal.entityUrn, type(expected))
            if current is not None and current.to_obj() == expected.to_obj():
                detail = "LIVE_RECONCILED_APPLIED"
                after = "EXACT"
                if pending.status is ReceiptStatus.FAILURE:
                    applied_after_failure.add(operation.proposal.entityUrn)
            elif (
                current is None
                or (
                    isinstance(expected, StatusClass)
                    and isinstance(current, StatusClass)
                    and current.removed is True
                    and expected.removed is False
                )
                or isinstance(expected, UpstreamLineageClass)
            ):
                # Lineage aspects were already reconciled (foreign edges rejected) when
                # the plan was rebuilt above; a live value that has not yet converged to
                # that reconciled result is a pending additive change, not a conflict.
                detail = "LIVE_RECONCILED_NOT_APPLIED"
                after = "ABSENT"
            else:
                receipt_store.append(
                    OperationReceipt.create(
                        scenario_id=graph.scenario_id,
                        operation_kind="seed",
                        entity_urn=pending.entity_urn,
                        aspect_name=pending.aspect_name,
                        idempotency_key=pending.idempotency_key,
                        status=ReceiptStatus.RECONCILIATION_REQUIRED,
                        detail_code="LIVE_RECONCILIATION_CONFLICT",
                        proposal_hash=pending.proposal_hash,
                        ownership_nonce=nonce,
                        metrics=metrics,
                    )
                )
                raise ValueError(f"SEED_LIVE_RECONCILIATION_CONFLICT:{pending.entity_urn}")
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="seed",
                    entity_urn=pending.entity_urn,
                    aspect_name=pending.aspect_name,
                    idempotency_key=pending.idempotency_key,
                    status=ReceiptStatus.SKIPPED,
                    detail_code=detail,
                    proposal_hash=pending.proposal_hash,
                    ownership_nonce=nonce,
                    metrics=metrics | {"beforeStatus": pending.status.value, "afterStatus": after},
                )
            )
            reconciled += 1
        current_receipts = receipt_store.read_all()
        created = {
            item.entity_urn
            for item in current_receipts
            if item.operation_kind == "entity"
            and item.status is ReceiptStatus.SUCCESS
            and item.detail_code == "ENTITY_CREATED"
        }
        by_entity: dict[tuple[str, str], list[PlannedUpsert]] = {}
        for operation in plan:
            urn = operation.proposal.entityUrn
            if urn is not None:
                by_entity.setdefault((urn, operation.proposal.entityType), []).append(operation)
        for (urn, entity_type), operations in by_entity.items():
            if (
                urn not in applied_after_failure
                or urn not in graph.owned_urns
                or urn in created
                or not reader.exists(urn)
            ):
                continue
            if not entity_has_scenario_marker(reader, urn, entity_type, nonce):
                continue
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="entity",
                    entity_urn=urn,
                    aspect_name=None,
                    idempotency_key=hashlib.sha256(
                        f"entity:{graph.scenario_id}:{urn}".encode()
                    ).hexdigest(),
                    status=ReceiptStatus.SUCCESS,
                    detail_code="ENTITY_CREATED",
                    proposal_hash=_entity_proposal_hash(operations),
                    ownership_nonce=nonce,
                    metrics=metrics | {"beforeStatus": "LIVE", "afterStatus": "RECONCILED_CREATED"},
                )
            )
    return reconciled
