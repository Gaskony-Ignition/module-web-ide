/**
 * Whether a table needs to be schema-qualified, and whether either part needs
 * quoting, from the connection facts the tables route reports.
 *
 * One place for this because three things need to agree on the same name: the
 * click/double-click insert (A), the SQL-completion namespace (B), and the
 * schema tree's own display text. A name built three different ways would
 * insert one thing, complete another, and show a third.
 */
import type { DbConnectionFacts, DbTableInfo } from '../api/dbQueries';
import { dialectForProductName } from './sqlDialect';

/**
 * Whether `name` is a reserved word in the dialect `productName` implies —
 * sourced from `@codemirror/lang-sql`'s own keyword lists (verified to carry
 * `user`/`order`/`group`/`key` for PostgreSQL, MySQL and MSSQL) rather than a
 * second, hand-rolled list. `StandardSQL`, used for an unrecognised or
 * absent product name, has no keyword list — an unknown dialect quotes
 * nothing extra rather than guessing.
 */
function isReservedKeyword(name: string, productName: string | null | undefined): boolean {
  const { keywords } = dialectForProductName(productName).spec;
  if (!keywords) {
    return false;
  }
  return keywords.split(/\s+/).includes(name.toLowerCase());
}

/**
 * An identifier needs quoting when it has a character outside
 * `[A-Za-z0-9_]`, starts with a digit, carries a case this connection would
 * silently fold on an unquoted identifier — an upper-case letter on a
 * database that stores unquoted identifiers lower-case (Postgres), or a
 * lower-case letter on one that stores them upper-case — or is a reserved
 * SQL keyword in the connection's dialect (e.g. a table literally named
 * `order` or `user`).
 */
export function needsQuoting(name: string, facts: DbConnectionFacts): boolean {
  if (name === '') {
    return true;
  }
  if (!/^[A-Za-z0-9_]+$/.test(name) || /^[0-9]/.test(name)) {
    return true;
  }
  if (facts.storesLowerCaseIdentifiers && /[A-Z]/.test(name)) {
    return true;
  }
  if (facts.storesUpperCaseIdentifiers && /[a-z]/.test(name)) {
    return true;
  }
  if (isReservedKeyword(name, facts.databaseProductName)) {
    return true;
  }
  return false;
}

/**
 * Quote an identifier with the connection's own quote character(s), doubling
 * any embedded occurrence — the SQL-standard escape, and the one
 * `getIdentifierQuoteString()` implies: JDBC specifies the SAME string at
 * both ends of a quoted identifier.
 */
export function quoteIdentifier(name: string, facts: DbConnectionFacts): string {
  const quote = facts.identifierQuote && facts.identifierQuote.trim() ? facts.identifierQuote : '"';
  return quote + name.split(quote).join(quote + quote) + quote;
}

/** `name`, quoted only if {@link needsQuoting} says it must be. */
export function maybeQuote(name: string, facts: DbConnectionFacts): string {
  return needsQuoting(name, facts) ? quoteIdentifier(name, facts) : name;
}

/**
 * A table's name as it should be typed into SQL: qualified with its schema
 * when that schema is not the connection's default (or the table carries no
 * schema, e.g. a MySQL/MariaDB datasource — always unqualified there since
 * every table already lives in the one connected database), and quoted only
 * where {@link needsQuoting} says a part needs it.
 */
export function qualifiedTableName(table: DbTableInfo, facts: DbConnectionFacts): string {
  const nameOut = maybeQuote(table.name, facts);
  if (table.schema == null || table.schema === facts.defaultSchema) {
    return nameOut;
  }
  // Narrowed non-null by the check above — kept as an `if` rather than a
  // ternary so TypeScript sees it.
  return `${maybeQuote(table.schema, facts)}.${nameOut}`;
}

/** A stable, collision-free key for a table across schemas — never the bare name alone. */
export function tableKey(table: Pick<DbTableInfo, 'schema' | 'name'>): string {
  return `${table.schema ?? ''}\u0001${table.name}`;
}

export const DEFAULT_CONNECTION_FACTS: DbConnectionFacts = {
  defaultSchema: null,
  identifierQuote: '"',
  storesLowerCaseIdentifiers: false,
  storesUpperCaseIdentifiers: false,
  databaseProductName: null,
};
