from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol, TypeVar

from datahub._codegen.aspect import _Aspect
from datahub.emitter.mce_builder import make_dataplatform_instance_urn
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    ChangeTypeClass,
    DataPlatformInstancePropertiesClass,
    StatusClass,
    TelemetryClientIdClass,
)

from lineageguard_datahub.config import CANONICAL_GMS_URL
from lineageguard_datahub.models import ExpectedGraph

Aspect = TypeVar("Aspect", bound=_Aspect)

TARGET_STATE_SCHEMA_VERSION = 2
TARGET_MARKER_URN = make_dataplatform_instance_urn(
    "datahub", "lineageguard-canonical-target-attestation-v2"
)
TARGET_MARKER_NAMESPACE = "io.lineageguard.target-attestation/v2"
TARGET_MARKER_NAME = "LineageGuard canonical target attestation"
TARGET_MARKER_DESCRIPTION = (
    "Create-only bootstrap marker for the canonical LineageGuard DataHub target."
)
TELEMETRY_CLIENT_URN = "urn:li:telemetry:clientId"
SERVER_IDENTITY_NAMESPACE = "datahub-telemetry-client-id/v1"
INSTANCE_ID_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class TargetReader(Protocol):
    def exists(self, entity_urn: str) -> bool: ...

    def get_aspect(
        self, entity_urn: str, aspect_type: type[Aspect], version: int = 0
    ) -> Aspect | None: ...

    def get_server_config(self) -> dict[str, object]: ...


class TargetEmitter(Protocol):
    def emit_mcp(self, proposal: MetadataChangeProposalWrapper) -> object: ...


@dataclass(frozen=True, slots=True)
class TargetInstanceBinding:
    schema_version: int
    canonical_url: str
    live_instance_id: str
    server_identity: str

    @property
    def target_fingerprint(self) -> str:
        payload = f"{self.canonical_url}|{self.server_identity}|{self.live_instance_id}"
        return hashlib.sha256(payload.encode()).hexdigest()


class TargetAttestor(Protocol):
    def __call__(self) -> TargetInstanceBinding: ...


def require_current_target(
    attestor: TargetAttestor,
    *,
    target_attestation: str,
    target_fingerprint: str,
) -> TargetInstanceBinding:
    observed = attestor()
    if not secrets.compare_digest(observed.live_instance_id, target_attestation):
        raise ValueError("TARGET_INSTANCE_BINDING_CHANGED")
    if not secrets.compare_digest(observed.target_fingerprint, target_fingerprint):
        raise ValueError("TARGET_INSTANCE_BINDING_CHANGED")
    return observed


@dataclass(frozen=True, slots=True)
class TargetBootstrapPlan:
    binding: TargetInstanceBinding
    already_bootstrapped: bool


class TargetInstanceStateStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    @staticmethod
    def _safe_flags(flags: int) -> int:
        return flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)

    def _prepare_parent(self) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.path.parent.is_symlink() or not self.path.parent.is_dir():
            raise ValueError("TARGET_STATE_PARENT_UNSAFE")
        info = self.path.parent.stat()
        if info.st_uid != os.getuid():
            raise ValueError("TARGET_STATE_PARENT_WRONG_OWNER")
        os.chmod(self.path.parent, 0o700)

    @staticmethod
    def _validate_descriptor(descriptor: int) -> None:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("TARGET_STATE_NOT_REGULAR")
        if info.st_uid != os.getuid():
            raise ValueError("TARGET_STATE_WRONG_OWNER")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("TARGET_STATE_MODE_MUST_BE_0600")
        if info.st_size > 1024:
            raise ValueError("TARGET_STATE_TOO_LARGE")

    @staticmethod
    def _parse(raw: object) -> TargetInstanceBinding:
        if not isinstance(raw, dict) or set(raw) != {
            "schema_version",
            "canonical_url",
            "live_instance_id",
            "server_identity",
        }:
            raise ValueError("TARGET_STATE_INVALID")
        if (
            type(raw["schema_version"]) is not int
            or raw["schema_version"] != TARGET_STATE_SCHEMA_VERSION
        ):
            raise ValueError("TARGET_STATE_VERSION_INVALID")
        canonical_url = raw["canonical_url"]
        live_instance_id = raw["live_instance_id"]
        server_identity = raw["server_identity"]
        if canonical_url != CANONICAL_GMS_URL:
            raise ValueError("TARGET_STATE_URL_MISMATCH")
        if not isinstance(live_instance_id, str) or not INSTANCE_ID_PATTERN.fullmatch(
            live_instance_id
        ):
            raise ValueError("TARGET_STATE_INSTANCE_ID_INVALID")
        if not isinstance(server_identity, str) or not INSTANCE_ID_PATTERN.fullmatch(
            server_identity
        ):
            raise ValueError("TARGET_STATE_SERVER_IDENTITY_INVALID")
        return TargetInstanceBinding(
            schema_version=TARGET_STATE_SCHEMA_VERSION,
            canonical_url=canonical_url,
            live_instance_id=live_instance_id,
            server_identity=server_identity,
        )

    def load_optional(self) -> TargetInstanceBinding | None:
        self._prepare_parent()
        try:
            descriptor = os.open(self.path, self._safe_flags(os.O_RDONLY))
        except FileNotFoundError:
            return None
        try:
            self._validate_descriptor(descriptor)
        except Exception:
            os.close(descriptor)
            raise
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            try:
                raw = json.loads(stream.read(1025))
            except json.JSONDecodeError as error:
                raise ValueError("TARGET_STATE_INVALID") from error
        return self._parse(raw)

    def load_required(self) -> TargetInstanceBinding:
        binding = self.load_optional()
        if binding is None:
            raise ValueError("TARGET_INSTANCE_STATE_MISSING")
        return binding

    def create(self, *, server_identity: str) -> TargetInstanceBinding:
        self._prepare_parent()
        if not INSTANCE_ID_PATTERN.fullmatch(server_identity):
            raise ValueError("TARGET_SERVER_IDENTITY_INVALID")
        binding = TargetInstanceBinding(
            schema_version=TARGET_STATE_SCHEMA_VERSION,
            canonical_url=CANONICAL_GMS_URL,
            live_instance_id=secrets.token_hex(32),
            server_identity=server_identity,
        )
        encoded = json.dumps(asdict(binding), sort_keys=True, separators=(",", ":")).encode()
        try:
            descriptor = os.open(
                self.path,
                self._safe_flags(os.O_WRONLY | os.O_CREAT | os.O_EXCL),
                0o600,
            )
        except FileExistsError:
            return self.load_required()
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        return binding


def target_marker_aspect(binding: TargetInstanceBinding) -> DataPlatformInstancePropertiesClass:
    return DataPlatformInstancePropertiesClass(
        name=TARGET_MARKER_NAME,
        description=TARGET_MARKER_DESCRIPTION,
        customProperties={
            "lineageguard.namespace": TARGET_MARKER_NAMESPACE,
            "lineageguard.canonicalGmsUrl": binding.canonical_url,
            "lineageguard.liveInstanceId": binding.live_instance_id,
            "lineageguard.serverIdentitySha256": binding.server_identity,
        },
    )


def read_server_identity(reader: TargetReader) -> str:
    """Bind to DataHub's independently managed telemetry identity.

    DataHub exposes no nonce challenge in the official Python SDK. The telemetry client id is
    stronger than our own marker because DataHub creates it independently, but a complete clone of
    DataHub's metadata store can replay it. That residual limitation is documented operationally.
    """

    config = reader.get_server_config()
    if not isinstance(config, dict) or config.get("noCode") != "true":
        raise ValueError("TARGET_SERVER_CONFIG_INVALID")
    status = reader.get_aspect(TELEMETRY_CLIENT_URN, StatusClass)
    if status is not None and status.removed is True:
        raise ValueError("TARGET_SERVER_IDENTITY_MISSING")
    telemetry = reader.get_aspect(TELEMETRY_CLIENT_URN, TelemetryClientIdClass)
    client_id = None if telemetry is None else telemetry.clientId
    if (
        not isinstance(client_id, str)
        or not 8 <= len(client_id) <= 256
        or any(character.isspace() or ord(character) < 33 for character in client_id)
    ):
        raise ValueError("TARGET_SERVER_IDENTITY_MISSING")
    payload = f"{SERVER_IDENTITY_NAMESPACE}\0{client_id}"
    return hashlib.sha256(payload.encode()).hexdigest()


def _assert_canonical_urns_absent(reader: TargetReader, graph: ExpectedGraph) -> None:
    for urn in sorted(graph.allowed_mutation_urns):
        if reader.exists(urn):
            raise ValueError(f"TARGET_BOOTSTRAP_CANONICAL_URN_EXISTS:{urn}")


def _read_marker(reader: TargetReader) -> DataPlatformInstancePropertiesClass | None:
    aspect = reader.get_aspect(TARGET_MARKER_URN, DataPlatformInstancePropertiesClass)
    if aspect is not None:
        status = reader.get_aspect(TARGET_MARKER_URN, StatusClass)
        if status is not None and status.removed is True:
            raise ValueError("TARGET_INSTANCE_MARKER_CONFLICT")
        return aspect
    if reader.exists(TARGET_MARKER_URN):
        raise ValueError("TARGET_INSTANCE_MARKER_CONFLICT")
    return None


def attest_target_instance(
    reader: TargetReader,
    state_store: TargetInstanceStateStore,
    *,
    canonical_url: str,
) -> TargetInstanceBinding:
    if canonical_url != CANONICAL_GMS_URL:
        raise ValueError("CANONICAL_DATAHUB_GMS_URL_REQUIRED")
    binding = state_store.load_required()
    observed_server_identity = read_server_identity(reader)
    if not secrets.compare_digest(observed_server_identity, binding.server_identity):
        raise ValueError("TARGET_SERVER_IDENTITY_MISMATCH")
    marker = _read_marker(reader)
    if marker is None:
        raise ValueError("TARGET_INSTANCE_MARKER_MISSING")
    properties = marker.customProperties
    if not isinstance(properties, dict):
        raise ValueError("TARGET_INSTANCE_MARKER_CONFLICT")
    marker_id = properties.get("lineageguard.liveInstanceId")
    if marker_id == "":
        raise ValueError("TARGET_INSTANCE_MARKER_EMPTY")
    if marker_id != binding.live_instance_id:
        raise ValueError("TARGET_INSTANCE_ID_MISMATCH")
    if marker.to_obj() != target_marker_aspect(binding).to_obj():
        raise ValueError("TARGET_INSTANCE_MARKER_CONFLICT")
    return binding


def prepare_target_bootstrap(
    reader: TargetReader,
    state_store: TargetInstanceStateStore,
    graph: ExpectedGraph,
    *,
    canonical_url: str,
) -> TargetBootstrapPlan:
    if canonical_url != CANONICAL_GMS_URL:
        raise ValueError("CANONICAL_DATAHUB_GMS_URL_REQUIRED")
    server_identity = read_server_identity(reader)
    _assert_canonical_urns_absent(reader, graph)
    marker = _read_marker(reader)
    binding = state_store.load_optional()
    if marker is not None:
        if binding is None:
            raise ValueError("TARGET_INSTANCE_MARKER_CONFLICT")
        attest_target_instance(reader, state_store, canonical_url=canonical_url)
        return TargetBootstrapPlan(binding=binding, already_bootstrapped=True)
    if binding is not None and not secrets.compare_digest(binding.server_identity, server_identity):
        raise ValueError("TARGET_SERVER_IDENTITY_MISMATCH")
    return TargetBootstrapPlan(
        binding=binding or state_store.create(server_identity=server_identity),
        already_bootstrapped=False,
    )


def complete_target_bootstrap(
    emitter: TargetEmitter,
    reader: TargetReader,
    state_store: TargetInstanceStateStore,
    plan: TargetBootstrapPlan,
    graph: ExpectedGraph,
) -> TargetInstanceBinding:
    if not plan.already_bootstrapped:
        _assert_canonical_urns_absent(reader, graph)
        if _read_marker(reader) is not None:
            raise ValueError("TARGET_INSTANCE_MARKER_CONFLICT")
        if not secrets.compare_digest(read_server_identity(reader), plan.binding.server_identity):
            raise ValueError("TARGET_SERVER_IDENTITY_MISMATCH")
        emitter.emit_mcp(
            MetadataChangeProposalWrapper(
                changeType=ChangeTypeClass.CREATE,
                entityUrn=TARGET_MARKER_URN,
                aspect=target_marker_aspect(plan.binding),
            )
        )
    observed = attest_target_instance(
        reader,
        state_store,
        canonical_url=plan.binding.canonical_url,
    )
    if not secrets.compare_digest(observed.target_fingerprint, plan.binding.target_fingerprint):
        raise ValueError("TARGET_INSTANCE_FINGERPRINT_MISMATCH")
    _assert_canonical_urns_absent(reader, graph)
    return observed
