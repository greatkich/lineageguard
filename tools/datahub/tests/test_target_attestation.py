from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

import pytest
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    ChangeTypeClass,
    DataPlatformInstancePropertiesClass,
    StatusClass,
    TelemetryClientIdClass,
)

import lineageguard_datahub.cli as cli
from lineageguard_datahub.config import CANONICAL_GMS_URL, DataHubConfig
from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.target_attestation import (
    TARGET_MARKER_DESCRIPTION,
    TARGET_MARKER_NAME,
    TARGET_MARKER_NAMESPACE,
    TARGET_MARKER_URN,
    TargetInstanceStateStore,
    attest_target_instance,
    complete_target_bootstrap,
    prepare_target_bootstrap,
    read_server_identity,
    target_marker_aspect,
)

SERVER_CLIENT_ID = "2ad62580-6d67-4f8b-b4a3-5e12ae978fc5"


class FakeTarget:
    def __init__(self, *, server_client_id: str = SERVER_CLIENT_ID) -> None:
        self.existing: set[str] = set()
        self.aspects: dict[tuple[str, type[object]], object] = {
            ("urn:li:telemetry:clientId", TelemetryClientIdClass): TelemetryClientIdClass(
                clientId=server_client_id
            )
        }
        self.emitted: list[MetadataChangeProposalWrapper] = []

    def get_server_config(self) -> dict[str, object]:
        return {"noCode": "true"}

    def exists(self, entity_urn: str) -> bool:
        return entity_urn in self.existing or any(urn == entity_urn for urn, _ in self.aspects)

    def get_aspect(self, entity_urn: str, aspect_type: type[Any], version: int = 0) -> Any | None:
        del version
        return self.aspects.get((entity_urn, aspect_type))

    def emit_mcp(self, proposal: MetadataChangeProposalWrapper) -> None:
        if proposal.changeType == ChangeTypeClass.CREATE and self.exists(proposal.entityUrn or ""):
            raise RuntimeError("CREATE_CONFLICT")
        self.emitted.append(proposal)
        assert proposal.entityUrn is not None and proposal.aspect is not None
        self.aspects[(proposal.entityUrn, type(proposal.aspect))] = proposal.aspect


def _store(tmp_path: Path) -> TargetInstanceStateStore:
    return TargetInstanceStateStore(tmp_path / "state/datahub-target.json")


def test_bootstrap_creates_random_protected_binding_and_exact_marker(
    expected_graph: ExpectedGraph, tmp_path: Path
) -> None:
    target = FakeTarget()
    store = _store(tmp_path)
    plan = prepare_target_bootstrap(target, store, expected_graph, canonical_url=CANONICAL_GMS_URL)
    assert len(plan.binding.live_instance_id) == 64
    assert (
        plan.binding.target_fingerprint
        == hashlib.sha256(
            (
                f"{CANONICAL_GMS_URL}|{plan.binding.server_identity}|"
                f"{plan.binding.live_instance_id}"
            ).encode()
        ).hexdigest()
    )
    assert (store.path.stat().st_mode & 0o777) == 0o600
    binding = complete_target_bootstrap(target, target, store, plan, expected_graph)
    assert binding == plan.binding
    assert len(target.emitted) == 1
    assert target.emitted[0].entityUrn == TARGET_MARKER_URN
    assert target.emitted[0].changeType == ChangeTypeClass.CREATE
    repeated = prepare_target_bootstrap(
        target, store, expected_graph, canonical_url=CANONICAL_GMS_URL
    )
    assert repeated.already_bootstrapped is True
    complete_target_bootstrap(target, target, store, repeated, expected_graph)
    assert len(target.emitted) == 1


def test_bootstrap_refuses_preexisting_canonical_entity(
    expected_graph: ExpectedGraph, tmp_path: Path
) -> None:
    target = FakeTarget()
    target.existing.add(expected_graph.managed_urns[0])
    with pytest.raises(ValueError, match="TARGET_BOOTSTRAP_CANONICAL_URN_EXISTS"):
        prepare_target_bootstrap(
            target, _store(tmp_path), expected_graph, canonical_url=CANONICAL_GMS_URL
        )


def test_attestation_rejects_missing_empty_substituted_and_conflicting_marker(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    target = FakeTarget()
    binding = store.create(server_identity=read_server_identity(target))
    with pytest.raises(ValueError, match="TARGET_INSTANCE_MARKER_MISSING"):
        attest_target_instance(target, store, canonical_url=CANONICAL_GMS_URL)

    target.aspects[(TARGET_MARKER_URN, DataPlatformInstancePropertiesClass)] = (
        DataPlatformInstancePropertiesClass(
            name=TARGET_MARKER_NAME,
            description=TARGET_MARKER_DESCRIPTION,
            customProperties={
                "lineageguard.namespace": TARGET_MARKER_NAMESPACE,
                "lineageguard.canonicalGmsUrl": CANONICAL_GMS_URL,
                "lineageguard.liveInstanceId": "",
            },
        )
    )
    with pytest.raises(ValueError, match="TARGET_INSTANCE_MARKER_EMPTY"):
        attest_target_instance(target, store, canonical_url=CANONICAL_GMS_URL)

    substituted = target_marker_aspect(binding)
    substituted.customProperties["lineageguard.liveInstanceId"] = "f" * 64
    target.aspects[(TARGET_MARKER_URN, DataPlatformInstancePropertiesClass)] = substituted
    with pytest.raises(ValueError, match="TARGET_INSTANCE_ID_MISMATCH"):
        attest_target_instance(target, store, canonical_url=CANONICAL_GMS_URL)

    conflicting = target_marker_aspect(binding)
    conflicting.customProperties["lineageguard.unexpected"] = "value"
    target.aspects[(TARGET_MARKER_URN, DataPlatformInstancePropertiesClass)] = conflicting
    with pytest.raises(ValueError, match="TARGET_INSTANCE_MARKER_CONFLICT"):
        attest_target_instance(target, store, canonical_url=CANONICAL_GMS_URL)

    target.aspects[(TARGET_MARKER_URN, DataPlatformInstancePropertiesClass)] = target_marker_aspect(
        binding
    )
    target.aspects[(TARGET_MARKER_URN, StatusClass)] = StatusClass(removed=True)
    with pytest.raises(ValueError, match="TARGET_INSTANCE_MARKER_CONFLICT"):
        attest_target_instance(target, store, canonical_url=CANONICAL_GMS_URL)


def test_attestation_rejects_unsafe_local_state_and_wrong_url(tmp_path: Path) -> None:
    target = FakeTarget()
    store = _store(tmp_path)
    binding = store.create(server_identity=read_server_identity(target))
    target.aspects[(TARGET_MARKER_URN, DataPlatformInstancePropertiesClass)] = target_marker_aspect(
        binding
    )
    with pytest.raises(ValueError, match="CANONICAL_DATAHUB_GMS_URL_REQUIRED"):
        attest_target_instance(target, store, canonical_url="http://127.0.0.1:8081")
    os.chmod(store.path, 0o644)
    with pytest.raises(ValueError, match="TARGET_STATE_MODE_MUST_BE_0600"):
        attest_target_instance(target, store, canonical_url=CANONICAL_GMS_URL)


def test_privileged_transport_is_not_loaded_or_constructed_before_attestation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    missing_marker = FakeTarget()
    binding = TargetInstanceStateStore(tmp_path / "walkthrough/.state/datahub-target.json").create(
        server_identity=read_server_identity(missing_marker)
    )
    config_calls: list[tuple[bool, bool]] = []
    graph_calls: list[object] = []
    emitter_calls: list[object] = []

    def fake_config(*, write: bool = False, ingest: bool = False) -> DataHubConfig:
        config_calls.append((write, ingest))
        if write or ingest:
            raise AssertionError("privileged config loaded before attestation")
        return DataHubConfig(CANONICAL_GMS_URL, "read", credential_kind="read")

    def fake_graph(config: object) -> FakeTarget:
        graph_calls.append(config)
        return missing_marker

    def fake_emitter(*args: object, **kwargs: object) -> object:
        emitter_calls.append((args, kwargs))
        raise AssertionError("write emitter constructed before attestation")

    monkeypatch.setattr(cli, "load_datahub_config", fake_config)
    monkeypatch.setattr(cli, "DataHubGraph", fake_graph)
    monkeypatch.setattr(cli, "DatahubRestEmitter", fake_emitter)
    with pytest.raises(ValueError, match="TARGET_INSTANCE_MARKER_MISSING"):
        cli._emitter_factory(tmp_path, binding)()
    assert config_calls == [(False, False)]
    assert len(graph_calls) == 1
    assert emitter_calls == []


def test_bootstrap_writer_is_not_constructed_before_clean_read_preflight(
    monkeypatch: pytest.MonkeyPatch,
    expected_graph: ExpectedGraph,
    tmp_path: Path,
) -> None:
    occupied = FakeTarget()
    occupied.existing.add(expected_graph.managed_urns[0])
    config_calls: list[tuple[bool, bool, bool]] = []
    emitter_calls: list[object] = []

    def fake_config(
        *, write: bool = False, ingest: bool = False, bootstrap: bool = False
    ) -> DataHubConfig:
        config_calls.append((write, ingest, bootstrap))
        token = "bootstrap" if bootstrap else "read"
        kind = "bootstrap" if bootstrap else "read"
        return DataHubConfig(CANONICAL_GMS_URL, token, credential_kind=kind)

    def fake_emitter(*args: object, **kwargs: object) -> object:
        emitter_calls.append((args, kwargs))
        raise AssertionError("bootstrap emitter constructed before read preflight")

    monkeypatch.setattr(cli, "load_expected_graph", lambda path: expected_graph)
    monkeypatch.setattr(cli, "_require_environment_gate", lambda: None)
    monkeypatch.setattr(cli, "load_datahub_config", fake_config)
    monkeypatch.setattr(cli, "DataHubGraph", lambda config: occupied)
    monkeypatch.setattr(cli, "DatahubRestEmitter", fake_emitter)
    with pytest.raises(ValueError, match="TARGET_BOOTSTRAP_CANONICAL_URN_EXISTS"):
        cli._bootstrap_target(True, expected_graph.scenario_id, tmp_path)
    assert config_calls == [(False, False, False)]
    assert emitter_calls == []


def test_bootstrap_rechecks_scope_before_and_after_create(
    expected_graph: ExpectedGraph, tmp_path: Path
) -> None:
    target = FakeTarget()
    store = _store(tmp_path)
    plan = prepare_target_bootstrap(target, store, expected_graph, canonical_url=CANONICAL_GMS_URL)
    raced_urn = expected_graph.managed_urns[0]
    target.existing.add(raced_urn)
    with pytest.raises(ValueError, match="TARGET_BOOTSTRAP_CANONICAL_URN_EXISTS"):
        complete_target_bootstrap(target, target, store, plan, expected_graph)
    assert target.emitted == []

    target.existing.remove(raced_urn)

    class PostEmitRace:
        def emit_mcp(self, proposal: MetadataChangeProposalWrapper) -> None:
            target.emit_mcp(proposal)
            target.existing.add(raced_urn)

    with pytest.raises(ValueError, match="TARGET_BOOTSTRAP_CANONICAL_URN_EXISTS"):
        complete_target_bootstrap(PostEmitRace(), target, store, plan, expected_graph)
    assert target.emitted[0].changeType == ChangeTypeClass.CREATE


def test_bootstrap_create_collision_never_overwrites_competing_marker(
    expected_graph: ExpectedGraph, tmp_path: Path
) -> None:
    target = FakeTarget()
    store = _store(tmp_path)
    plan = prepare_target_bootstrap(target, store, expected_graph, canonical_url=CANONICAL_GMS_URL)
    competing = target_marker_aspect(plan.binding)
    competing.customProperties["lineageguard.liveInstanceId"] = "f" * 64

    class ConcurrentWriter:
        def emit_mcp(self, proposal: MetadataChangeProposalWrapper) -> None:
            target.aspects[(TARGET_MARKER_URN, DataPlatformInstancePropertiesClass)] = competing
            target.emit_mcp(proposal)

    with pytest.raises(RuntimeError, match="CREATE_CONFLICT"):
        complete_target_bootstrap(ConcurrentWriter(), target, store, plan, expected_graph)
    observed = target.aspects[(TARGET_MARKER_URN, DataPlatformInstancePropertiesClass)]
    assert observed is competing


def test_attestation_rejects_marker_replay_on_different_server_identity(
    tmp_path: Path,
) -> None:
    original = FakeTarget(server_client_id=SERVER_CLIENT_ID)
    store = _store(tmp_path)
    binding = store.create(server_identity=read_server_identity(original))
    replay = FakeTarget(server_client_id="8de38c0a-9aa8-47bd-91f1-58e3864c2384")
    replay.aspects[(TARGET_MARKER_URN, DataPlatformInstancePropertiesClass)] = target_marker_aspect(
        binding
    )
    with pytest.raises(ValueError, match="TARGET_SERVER_IDENTITY_MISMATCH"):
        attest_target_instance(replay, store, canonical_url=CANONICAL_GMS_URL)


def test_server_identity_is_required_and_fail_closed(tmp_path: Path) -> None:
    target = FakeTarget()
    target.aspects.pop(("urn:li:telemetry:clientId", TelemetryClientIdClass))
    with pytest.raises(ValueError, match="TARGET_SERVER_IDENTITY_MISSING"):
        read_server_identity(target)
    target.aspects[("urn:li:telemetry:clientId", TelemetryClientIdClass)] = TelemetryClientIdClass(
        clientId="contains whitespace"
    )
    with pytest.raises(ValueError, match="TARGET_SERVER_IDENTITY_MISSING"):
        read_server_identity(target)


def test_privileged_factories_keep_all_reads_on_read_credential(
    monkeypatch: pytest.MonkeyPatch,
    expected_graph: ExpectedGraph,
    tmp_path: Path,
) -> None:
    target = FakeTarget()
    store = TargetInstanceStateStore(tmp_path / "walkthrough/.state/datahub-target.json")
    plan = prepare_target_bootstrap(target, store, expected_graph, canonical_url=CANONICAL_GMS_URL)
    binding = complete_target_bootstrap(target, target, store, plan, expected_graph)
    events: list[str] = []

    class Writer:
        def emit_mcp(self, proposal: MetadataChangeProposalWrapper) -> None:
            events.append(f"write:{proposal.aspectName}")

    writer = Writer()

    def fake_config(
        *, write: bool = False, ingest: bool = False, bootstrap: bool = False
    ) -> DataHubConfig:
        del bootstrap
        kind = "ingest" if ingest else ("mutation" if write else "read")
        events.append(f"config:{kind}")
        return DataHubConfig(CANONICAL_GMS_URL, f"{kind}-token", credential_kind=kind)

    def fake_graph(config: Any) -> FakeTarget:
        assert config.token == "read-token"
        events.append("graph:read-token")
        return target

    def fake_emitter(*, gms_server: str, token: str | None) -> Writer:
        assert gms_server == CANONICAL_GMS_URL
        assert token == "mutation-token"
        events.append("emitter:mutation-token")
        return writer

    monkeypatch.setattr(cli, "load_datahub_config", fake_config)
    monkeypatch.setattr(cli, "DataHubGraph", fake_graph)
    monkeypatch.setattr(cli, "DatahubRestEmitter", fake_emitter)
    emitter = cli._emitter_factory(tmp_path, binding)()
    assert emitter is writer
    deleter = cli._deleter_factory(tmp_path, binding)()
    assert not hasattr(deleter, "get_aspect")
    deleter.delete_entity(expected_graph.owned_urns[0])
    assert events == [
        "config:read",
        "graph:read-token",
        "config:mutation",
        "emitter:mutation-token",
        "config:read",
        "graph:read-token",
        "config:mutation",
        "emitter:mutation-token",
        "write:status",
    ]
