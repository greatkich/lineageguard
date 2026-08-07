/**
 * The canonical `commerce.orders` baseline the validation runtime materializes before applying a
 * generated candidate.
 *
 * Identifiers are `uuid` across every layer of the walkthrough — schema evidence, generated
 * migration, validator fixtures, and exported examples all agree. Literals are fixed rather than
 * `gen_random_uuid()` so the validation receipt is byte-reproducible across repeated runs.
 */
const canonicalOrderIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;

/** Two distinct customers, with the first repeated, so backfill equality covers a duplicate. */
const canonicalCustomerIds = [
  "00000000-0000-4000-8000-0000000000a1",
  "00000000-0000-4000-8000-0000000000a2",
  "00000000-0000-4000-8000-0000000000a1",
] as const;

const canonicalOrderRows = [
  { orderTotal: "49.99", orderedAt: "2024-01-15" },
  { orderTotal: "129.00", orderedAt: "2024-02-20" },
  { orderTotal: "75.50", orderedAt: "2024-03-10" },
] as const;

function valuesClause(): string {
  return canonicalOrderRows
    .map(
      (row, index) =>
        `('${canonicalOrderIds[index]}', '${canonicalCustomerIds[index]}', ${row.orderTotal}, '${row.orderedAt}')`,
    )
    .join(", ");
}

export const canonicalBaseFixtureSql = [
  "CREATE SCHEMA IF NOT EXISTS commerce;",
  "CREATE TABLE commerce.orders (",
  "order_id UUID PRIMARY KEY,",
  "customer_id UUID NOT NULL,",
  "order_total NUMERIC(10,2),",
  "ordered_at TIMESTAMPTZ DEFAULT now()",
  ");",
  "INSERT INTO commerce.orders (order_id, customer_id, order_total, ordered_at) VALUES",
  `${valuesClause()};`,
]
  .join(" ")
  .replace(/\(\s+/g, "(")
  .replace(/\s+\)/g, ")");
