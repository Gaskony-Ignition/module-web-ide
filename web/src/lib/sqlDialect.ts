/**
 * Pick a `@codemirror/lang-sql` dialect from a JDBC `getDatabaseProductName()`
 * string — the one fact the tables route already carries, so the Query
 * Browser's SQL completion highlights and completes keywords for the
 * connection it is actually pointed at, rather than guessing.
 */
import { MSSQL, MariaSQL, MySQL, PostgreSQL, SQLDialect, StandardSQL } from '@codemirror/lang-sql';

export function dialectForProductName(productName: string | null | undefined): SQLDialect {
  const name = (productName ?? '').toLowerCase();
  if (name.includes('postgresql')) {
    return PostgreSQL;
  }
  if (name.includes('mariadb')) {
    return MariaSQL;
  }
  if (name.includes('mysql')) {
    return MySQL;
  }
  if (name.includes('sql server')) {
    return MSSQL;
  }
  return StandardSQL;
}
