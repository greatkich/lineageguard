from __future__ import annotations

import pytest
from datahub.metadata.schema_classes import (
    DatasetLineageTypeClass,
    FineGrainedLineageClass,
    FineGrainedLineageDownstreamTypeClass,
    FineGrainedLineageUpstreamTypeClass,
    UpstreamClass,
    UpstreamLineageClass,
)

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.seed import reconcile_lineage_aspect

CUSTOMER_REVENUE_URN = (
    "urn:li:dataset:(urn:li:dataPlatform:postgres,"
    "lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)"
)
DBT_SIBLING_URN = (
    "urn:li:dataset:(urn:li:dataPlatform:dbt,"
    "lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)"
)
CANONICAL_UPSTREAM_URN = (
    "urn:li:dataset:(urn:li:dataPlatform:postgres,"
    "lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)"
)
FOREIGN_URN = "urn:li:dataset:(urn:li:dataPlatform:postgres,shared.unrelated,PROD)"


def _dbt_sibling_upstream() -> UpstreamClass:
    return UpstreamClass(dataset=DBT_SIBLING_URN, type=DatasetLineageTypeClass.COPY)


def _foreign_upstream() -> UpstreamClass:
    return UpstreamClass(dataset=FOREIGN_URN, type=DatasetLineageTypeClass.TRANSFORMED)


def _canonical_upstream_dataset(aspect: UpstreamLineageClass) -> UpstreamClass:
    return next(u for u in aspect.upstreams if u.dataset == CANONICAL_UPSTREAM_URN)


def test_no_existing_lineage_adds_only_the_canonical_overlay(
    expected_graph: ExpectedGraph,
) -> None:
    reconciled = reconcile_lineage_aspect(expected_graph, CUSTOMER_REVENUE_URN, None)
    assert [u.dataset for u in reconciled.upstreams] == [CANONICAL_UPSTREAM_URN]
    assert _canonical_upstream_dataset(reconciled).type == DatasetLineageTypeClass.TRANSFORMED
    assert reconciled.fineGrainedLineages
    assert len(reconciled.fineGrainedLineages) == 1


def test_expected_dbt_connector_lineage_is_preserved_alongside_the_overlay(
    expected_graph: ExpectedGraph,
) -> None:
    current = UpstreamLineageClass(upstreams=[_dbt_sibling_upstream()])
    reconciled = reconcile_lineage_aspect(expected_graph, CUSTOMER_REVENUE_URN, current)
    datasets = {u.dataset for u in reconciled.upstreams}
    assert datasets == {DBT_SIBLING_URN, CANONICAL_UPSTREAM_URN}
    sibling = next(u for u in reconciled.upstreams if u.dataset == DBT_SIBLING_URN)
    assert sibling.type == DatasetLineageTypeClass.COPY
    assert _canonical_upstream_dataset(reconciled).type == DatasetLineageTypeClass.TRANSFORMED


def test_duplicate_canonical_edge_is_deduplicated_deterministically(
    expected_graph: ExpectedGraph,
) -> None:
    # The connector already emitted the exact canonical edge once (e.g. from a prior
    # LineageGuard write); reconciling again must not produce a second copy.
    current = UpstreamLineageClass(
        upstreams=[
            UpstreamClass(dataset=CANONICAL_UPSTREAM_URN, type=DatasetLineageTypeClass.TRANSFORMED),
            _dbt_sibling_upstream(),
        ]
    )
    reconciled = reconcile_lineage_aspect(expected_graph, CUSTOMER_REVENUE_URN, current)
    canonical_matches = [u for u in reconciled.upstreams if u.dataset == CANONICAL_UPSTREAM_URN]
    assert len(canonical_matches) == 1
    assert len(reconciled.upstreams) == 2

    # Reconciling the already-reconciled result again is a strict no-op.
    idempotent = reconcile_lineage_aspect(expected_graph, CUSTOMER_REVENUE_URN, reconciled)
    assert idempotent.to_obj() == reconciled.to_obj()


def test_canonical_field_overlay_is_added_when_missing(expected_graph: ExpectedGraph) -> None:
    current = UpstreamLineageClass(upstreams=[_dbt_sibling_upstream()], fineGrainedLineages=[])
    reconciled = reconcile_lineage_aspect(expected_graph, CUSTOMER_REVENUE_URN, current)
    assert reconciled.fineGrainedLineages
    fine_grained = reconciled.fineGrainedLineages[0]
    assert fine_grained.upstreamType == FineGrainedLineageUpstreamTypeClass.FIELD_SET
    assert fine_grained.downstreamType == FineGrainedLineageDownstreamTypeClass.FIELD
    assert fine_grained.upstreams == [
        f"urn:li:schemaField:({CANONICAL_UPSTREAM_URN},customer_id)"
    ]
    assert fine_grained.downstreams == [
        f"urn:li:schemaField:({CUSTOMER_REVENUE_URN},customer_id)"
    ]


def test_unexpected_foreign_edge_fails_closed(expected_graph: ExpectedGraph) -> None:
    current = UpstreamLineageClass(upstreams=[_foreign_upstream()])
    with pytest.raises(ValueError, match="LINEAGE_FOREIGN_EDGE_REJECTED"):
        reconcile_lineage_aspect(expected_graph, CUSTOMER_REVENUE_URN, current)


def test_foreign_fine_grained_edge_fails_closed(expected_graph: ExpectedGraph) -> None:
    current = UpstreamLineageClass(
        upstreams=[_dbt_sibling_upstream()],
        fineGrainedLineages=[
            FineGrainedLineageClass(
                upstreamType=FineGrainedLineageUpstreamTypeClass.FIELD_SET,
                downstreamType=FineGrainedLineageDownstreamTypeClass.FIELD,
                upstreams=[f"urn:li:schemaField:({FOREIGN_URN},some_field)"],
                downstreams=[f"urn:li:schemaField:({CUSTOMER_REVENUE_URN},customer_id)"],
                transformOperation="IDENTITY",
                confidenceScore=1.0,
            )
        ],
    )
    with pytest.raises(ValueError, match="LINEAGE_FOREIGN_FIELD_EDGE_REJECTED"):
        reconcile_lineage_aspect(expected_graph, CUSTOMER_REVENUE_URN, current)


def test_repeated_reconciliation_produces_no_further_change(
    expected_graph: ExpectedGraph,
) -> None:
    current = UpstreamLineageClass(upstreams=[_dbt_sibling_upstream()])
    first = reconcile_lineage_aspect(expected_graph, CUSTOMER_REVENUE_URN, current)
    second = reconcile_lineage_aspect(expected_graph, CUSTOMER_REVENUE_URN, first)
    assert first.to_obj() == second.to_obj()
