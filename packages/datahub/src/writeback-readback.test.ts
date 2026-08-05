import { canonicalDatasetUrn } from "@lineageguard/domain";
import { describe, expect, it } from "vitest";
import { parseOfficialWritebackEntities } from "./writeback.js";

const documentId = "lineageguard-migration-decision_test";
const reviewTag = "urn:li:tag:lineageguard-canonical.Reviewed";
const now = "2026-08-05T10:00:00.000Z";

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
    expect(parse([dataset(), { urn: reviewTag }])).toMatchObject({
      knownTagUrns: [reviewTag],
      scenarioMarker: "canonical-customer-id-rename",
      tagUrns: [],
      version: "7",
    });
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
      parse([dataset({ properties: { customProperties, name: "orders" } }), { urn: reviewTag }]),
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
      parse([dataset({ tags: tags === undefined ? undefined : { tags } }), { urn: reviewTag }]),
    ).toThrow();
  });

  it("includes all preexisting tags but excludes only the approved additive tag from metadata versioning", () => {
    const base = parse([
      dataset({ tags: { tags: [{ tag: { urn: "urn:li:tag:existing" } }] } }),
      { urn: reviewTag },
    ]);
    const withApproved = parse([
      dataset({
        tags: {
          tags: [{ tag: { urn: "urn:li:tag:existing" } }, { tag: { urn: reviewTag } }],
        },
      }),
      { urn: reviewTag },
    ]);
    const withUnexpected = parse([
      dataset({ tags: { tags: [{ tag: { urn: "urn:li:tag:unexpected" } }] } }),
      { urn: reviewTag },
    ]);
    expect(withApproved.relevantMetadataFingerprint).toBe(base.relevantMetadataFingerprint);
    expect(withUnexpected.relevantMetadataFingerprint).not.toBe(base.relevantMetadataFingerprint);
    expect(base.relevantMetadataFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });
});
