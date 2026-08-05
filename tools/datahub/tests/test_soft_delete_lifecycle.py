from __future__ import annotations

from pathlib import Path
from typing import Any

from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    DatasetPropertiesClass,
    OtherSchemaClass,
    SchemaFieldClass,
    SchemaFieldDataTypeClass,
    SchemaMetadataClass,
    StatusClass,
    StringTypeClass,
)
from support import (
    TARGET_ATTESTATION,
    TARGET_FINGERPRINT,
    WAREHOUSE_TARGET,
    RegistryCursor,
    append_build_provenance,
    attest_test_target,
    full_target_metrics,
    provenance_values,
)

from lineageguard_datahub.ingestion import RECIPE_DIGESTS
from lineageguard_datahub.live_query import emit_live_query_evidence
from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.provenance import registry_binding_metrics
from lineageguard_datahub.query_history import plan_query_execution
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore
from lineageguard_datahub.reset import build_reset_plan, execute_reset
from lineageguard_datahub.seed import seed_metadata
from lineageguard_datahub.verify import compare_observed_graph, observe_live

ATTESTATION = TARGET_ATTESTATION
TARGET = TARGET_FINGERPRINT


class LifecycleCatalog:
    def __init__(self) -> None:
        self.aspects: dict[tuple[str, type[object]], Any] = {}

    def exists(self, entity_urn: str) -> bool:
        return any(urn == entity_urn for urn, _ in self.aspects)

    def get_aspect(self, entity_urn: str, aspect_type: type[Any], version: int = 0) -> Any | None:
        del version
        return self.aspects.get((entity_urn, aspect_type))

    def get_timeseries_values(
        self,
        entity_urn: str,
        aspect_type: type[Any],
        filter: dict[str, Any],
        limit: int = 10,
    ) -> list[Any]:
        del filter, limit
        aspect = self.get_aspect(entity_urn, aspect_type)
        return [] if aspect is None else [aspect]

    def emit_mcp(self, proposal: MetadataChangeProposalWrapper) -> None:
        assert proposal.entityUrn is not None and proposal.aspect is not None
        self.aspects[(proposal.entityUrn, type(proposal.aspect))] = proposal.aspect

    def delete_entity(self, urn: str, hard: bool = False) -> None:
        assert hard is False
        self.aspects[(urn, StatusClass)] = StatusClass(removed=True)


def _add_connector_schemas(catalog: LifecycleCatalog, graph: ExpectedGraph) -> None:
    for node in graph.nodes:
        if node.urn not in graph.connector_dataset_urns:
            continue
        catalog.emit_mcp(
            MetadataChangeProposalWrapper(
                entityUrn=node.urn,
                aspect=DatasetPropertiesClass(name=node.name),
            )
        )
        fields = [
            SchemaFieldClass(
                fieldPath=field,
                type=SchemaFieldDataTypeClass(type=StringTypeClass()),
                nativeDataType="text",
                nullable=False,
            )
            for field in node.schema_fields
        ]
        catalog.emit_mcp(
            MetadataChangeProposalWrapper(
                entityUrn=node.urn,
                aspect=SchemaMetadataClass(
                    schemaName=node.logical_key,
                    platform="urn:li:dataPlatform:postgres",
                    version=0,
                    hash="connector",
                    platformSchema=OtherSchemaClass(rawSchema="{}"),
                    fields=fields,
                ),
            )
        )
    catalog.aspects[(graph.source_field.schema_field_urn, StatusClass)] = StatusClass(removed=False)


def _append_live_prerequisites(store: ReceiptStore, graph: ExpectedGraph, root: Path) -> None:
    append_build_provenance(store, root)
    execution = plan_query_execution(root, graph.query_evidence[0])
    store.append(
        OperationReceipt.create(
            scenario_id=graph.scenario_id,
            operation_kind="query",
            entity_urn=None,
            aspect_name="pg_stat_statements",
            idempotency_key=execution.normalized_fingerprint,
            proposal_hash=execution.normalized_fingerprint,
            status=ReceiptStatus.SUCCESS,
            detail_code="PG_STAT_OBSERVED",
            metrics={
                "queryId": "48291",
                "executionCount": 2,
                "totalExecTimeMs": 1.5,
                "normalizedFingerprint": execution.normalized_fingerprint,
                "statementSha256": execution.sha256,
                "databaseId": "16384",
                "userId": "16390",
                **registry_binding_metrics(store.ownership_nonce, WAREHOUSE_TARGET),
            },
            recorded_at="2026-08-04T10:00:00+00:00",
            ownership_nonce=store.ownership_nonce,
        )
    )
    postgres = "walkthrough/metadata/postgres-ingestion.yml"
    digest = RECIPE_DIGESTS[postgres]
    store.append(
        OperationReceipt.create(
            scenario_id=graph.scenario_id,
            operation_kind="ingest",
            entity_urn=None,
            aspect_name=postgres,
            idempotency_key=digest,
            proposal_hash=digest,
            status=ReceiptStatus.SUCCESS,
            detail_code="INGESTED",
            recorded_at="2026-08-04T10:01:00+00:00",
            ownership_nonce=store.ownership_nonce,
            metrics=full_target_metrics(root, store.ownership_nonce),
        )
    )


def _append_dbt_ingest(store: ReceiptStore, graph: ExpectedGraph, root: Path) -> None:
    relative = "walkthrough/metadata/dbt-ingestion.yml"
    digest = RECIPE_DIGESTS[relative]
    store.append(
        OperationReceipt.create(
            scenario_id=graph.scenario_id,
            operation_kind="ingest",
            entity_urn=None,
            aspect_name=relative,
            idempotency_key=digest,
            proposal_hash=digest,
            status=ReceiptStatus.SUCCESS,
            detail_code="INGESTED",
            ownership_nonce=store.ownership_nonce,
            metrics=full_target_metrics(root, store.ownership_nonce),
        )
    )


def _verify(
    catalog: LifecycleCatalog, store: ReceiptStore, graph: ExpectedGraph, root: Path
) -> tuple[bool, tuple[str, ...]]:
    project, artifacts, snapshot = provenance_values(root)
    report = compare_observed_graph(
        graph,
        observe_live(catalog, graph),
        store.read_all(),
        ownership_nonce=store.ownership_nonce,
        warehouse_target_fingerprint=WAREHOUSE_TARGET,
        target_attestation=ATTESTATION,
        target_fingerprint=TARGET,
        dbt_project_sha256=project,
        artifact_metrics=artifacts,
        snapshot_fingerprint=snapshot,
    )
    return report.ok, tuple(f"{item.code}:{item.detail}" for item in report.failures)


def test_reset_verify_reseed_soft_delete_lifecycle(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    catalog = LifecycleCatalog()
    _add_connector_schemas(catalog, expected_graph)
    store = ReceiptStore(tmp_path / "operations.jsonl")
    _append_live_prerequisites(store, expected_graph, repository_root)
    emit_live_query_evidence(
        lambda: catalog,
        catalog,
        store,
        expected_graph,
        repository_root,
        RegistryCursor(store.ownership_nonce),
        warehouse_target_fingerprint=WAREHOUSE_TARGET,
        target_attestation=ATTESTATION,
        target_fingerprint=TARGET,
        attest_target=attest_test_target,
    )
    _append_dbt_ingest(store, expected_graph, repository_root)
    seed_metadata(
        lambda: catalog,
        catalog,
        store,
        expected_graph,
        repository_root,
        RegistryCursor(store.ownership_nonce),
        warehouse_target_fingerprint=WAREHOUSE_TARGET,
        target_attestation=ATTESTATION,
        target_fingerprint=TARGET,
        attest_target=attest_test_target,
    )
    initial = _verify(catalog, store, expected_graph, repository_root)
    assert initial[0], initial[1]

    plan = build_reset_plan(
        expected_graph,
        environment_gate="canonical",
        platform_instance=expected_graph.platform_instance,
        creation_receipts=store.read_all(),
        root=repository_root,
        ownership_nonce=store.ownership_nonce,
        warehouse_target_fingerprint=WAREHOUSE_TARGET,
        target_attestation=ATTESTATION,
        target_fingerprint=TARGET,
    )
    execute_reset(
        lambda: catalog,
        catalog,
        store,
        plan,
        RegistryCursor(store.ownership_nonce),
        attest_target=attest_test_target,
    )
    assert not set(plan.urns) & set(expected_graph.connector_dataset_urns)
    assert _verify(catalog, store, expected_graph, repository_root)[0] is False

    emit_live_query_evidence(
        lambda: catalog,
        catalog,
        store,
        expected_graph,
        repository_root,
        RegistryCursor(store.ownership_nonce),
        warehouse_target_fingerprint=WAREHOUSE_TARGET,
        target_attestation=ATTESTATION,
        target_fingerprint=TARGET,
        attest_target=attest_test_target,
    )
    seed_metadata(
        lambda: catalog,
        catalog,
        store,
        expected_graph,
        repository_root,
        RegistryCursor(store.ownership_nonce),
        warehouse_target_fingerprint=WAREHOUSE_TARGET,
        target_attestation=ATTESTATION,
        target_fingerprint=TARGET,
        attest_target=attest_test_target,
    )
    assert all(
        (status := catalog.get_aspect(urn, StatusClass)) is None or status.removed is False
        for urn in expected_graph.owned_urns
    )
    restored = _verify(catalog, store, expected_graph, repository_root)
    assert restored[0], restored[1]
