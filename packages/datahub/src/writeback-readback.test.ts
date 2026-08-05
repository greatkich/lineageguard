import { canonicalDatasetUrn } from "@lineageguard/domain";
import { describe, expect, it } from "vitest";
import { parseOfficialWritebackEntities } from "./writeback.js";

const documentId = "lineageguard-migration-decision_test";
const reviewTag = "urn:li:tag:lineageguard-canonical.Reviewed";
const now = "2026-08-05T10:00:00.000Z";
const reviewTagEntity = {
  properties: {
    description:
      "LineageGuard review status: a validated migration decision was written back through the approved effect gate. lineageguard:scenario:canonical-customer-id-rename",
    name: "Reviewed",
  },
  urn: reviewTag,
};

function dataset(overrides: Record<string, unknown> = {}) {
  return {
    properties: {
      customProperties: {
        "lineageguard.scenario": "canonical-customer-id-rename",
      },
      name: "orders",
    },
    systemMetadata: { lastObserved: 7 },
    tags: { tags: [] },
    urn: canonicalDatasetUrn,
    ...overrides,
  };
}

function parse(items: unknown[]) {
  return parseOfficialWritebackEntities(items, canonicalDatasetUrn, documentId, reviewTag, now);
}

describe("official write-back readback normalization", () => {
  it("reads the exact seeded scenario marker and provisioned tag entity", () => {
    expect(parse([dataset(), reviewTagEntity])).toMatchObject({
      knownTagUrns: [reviewTag],
      scenarioMarker: "canonical-customer-id-rename",
      tagUrns: [],
      version: "7",
    });
  });

  it.each([
    ["absent", []],
    ["duplicate", [reviewTagEntity, reviewTagEntity]],
    [
      "wrong name",
      [{ ...reviewTagEntity, properties: { ...reviewTagEntity.properties, name: "Other" } }],
    ],
    [
      "wrong description",
      [{ ...reviewTagEntity, properties: { ...reviewTagEntity.properties, description: "Other" } }],
    ],
  ])("does not authorize an %s Reviewed tag definition", (_name, tags) => {
    expect(parse([dataset(), ...tags]).knownTagUrns).toEqual([]);
  });

  it.each([
    ["absent", {}],
    ["wrong", { "lineageguard.scenario": "copied-stale-scenario" }],
    [
      "duplicate",
      [
        { key: "lineageguard.scenario", value: "canonical-customer-id-rename" },
        { key: "lineageguard.scenario", value: "canonical-customer-id-rename" },
      ],
    ],
  ])("rejects %s scenario metadata even for the same URN/name", (_name, customProperties) => {
    expect(() =>
      parse([dataset({ properties: { customProperties, name: "orders" } }), reviewTagEntity]),
    ).toThrow();
  });

  it.each([
    ["absent", undefined],
    ["malformed", [{ tag: { urn: "not-a-tag-urn" } }]],
    [
      "duplicate",
      [{ tag: { urn: "urn:li:tag:existing" } }, { tag: { urn: "urn:li:tag:existing" } }],
    ],
    [
      "unbounded",
      Array.from({ length: 201 }, (_, index) => ({ tag: { urn: `urn:li:tag:t${index}` } })),
    ],
  ])("rejects %s source tag projections", (_name, tags) => {
    expect(() =>
      parse([dataset({ tags: tags === undefined ? undefined : { tags } }), reviewTagEntity]),
    ).toThrow();
  });

  it("includes all preexisting tags but excludes only the approved additive tag from metadata versioning", () => {
    const base = parse([
      dataset({ tags: { tags: [{ tag: { urn: "urn:li:tag:existing" } }] } }),
      reviewTagEntity,
    ]);
    const withApproved = parse([
      dataset({
        tags: {
          tags: [{ tag: { urn: "urn:li:tag:existing" } }, { tag: { urn: reviewTag } }],
        },
      }),
      reviewTagEntity,
    ]);
    const withUnexpected = parse([
      dataset({ tags: { tags: [{ tag: { urn: "urn:li:tag:unexpected" } }] } }),
      reviewTagEntity,
    ]);
    expect(withApproved.relevantMetadataFingerprint).toBe(base.relevantMetadataFingerprint);
    expect(withUnexpected.relevantMetadataFingerprint).not.toBe(base.relevantMetadataFingerprint);
    expect(base.relevantMetadataFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });
});
