import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONNECTION_FACTS, maybeQuote, needsQuoting, qualifiedTableName, quoteIdentifier, tableKey,
} from './sqlIdentifier';
import type { DbConnectionFacts } from '../api/dbQueries';

const postgres: DbConnectionFacts = {
  defaultSchema: 'public',
  identifierQuote: '"',
  storesLowerCaseIdentifiers: true,
  storesUpperCaseIdentifiers: false,
  databaseProductName: 'PostgreSQL',
};

const mssql: DbConnectionFacts = {
  defaultSchema: 'dbo',
  identifierQuote: '"',
  storesLowerCaseIdentifiers: false,
  storesUpperCaseIdentifiers: false,
  databaseProductName: 'Microsoft SQL Server',
};

describe('needsQuoting', () => {
  it('a plain lower-case name on a lower-case-storing database needs no quoting', () => {
    expect(needsQuoting('orders', postgres)).toBe(false);
  });

  it('an upper-case letter on a lower-case-storing database needs quoting', () => {
    expect(needsQuoting('Orders', postgres)).toBe(true);
  });

  it('a lower-case letter on an upper-case-storing database needs quoting', () => {
    const upperStoring: DbConnectionFacts = { ...postgres, storesLowerCaseIdentifiers: false, storesUpperCaseIdentifiers: true };
    expect(needsQuoting('Orders', upperStoring)).toBe(true);
    expect(needsQuoting('ORDERS', upperStoring)).toBe(false);
  });

  it('a name with a space or hyphen always needs quoting, whatever the case', () => {
    expect(needsQuoting('order items', mssql)).toBe(true);
    expect(needsQuoting('order-items', mssql)).toBe(true);
  });

  it('a leading digit always needs quoting', () => {
    expect(needsQuoting('1099_forms', postgres)).toBe(true);
  });

  it('mixed case on a database that does not fold case at all needs no quoting', () => {
    expect(needsQuoting('OrderItems', mssql)).toBe(false);
  });
});

describe('needsQuoting — reserved keywords', () => {
  it('a reserved word needs quoting on PostgreSQL', () => {
    expect(needsQuoting('user', postgres)).toBe(true);
    expect(needsQuoting('order', postgres)).toBe(true);
    expect(needsQuoting('group', postgres)).toBe(true);
    expect(needsQuoting('key', postgres)).toBe(true);
  });

  it('a reserved word needs quoting on MySQL', () => {
    const mysql: DbConnectionFacts = { ...postgres, databaseProductName: 'MySQL' };
    expect(needsQuoting('user', mysql)).toBe(true);
    expect(needsQuoting('order', mysql)).toBe(true);
    expect(needsQuoting('group', mysql)).toBe(true);
    expect(needsQuoting('key', mysql)).toBe(true);
  });

  it('a plural of a reserved word is an ordinary name, not reserved', () => {
    expect(needsQuoting('orders', postgres)).toBe(false);
  });

  it('an unknown dialect has no keyword list, so the keyword rule alone does not force quoting', () => {
    const unknownDialect: DbConnectionFacts = { ...postgres, databaseProductName: null };
    expect(needsQuoting('user', unknownDialect)).toBe(false);
  });

  it('an unknown dialect still quotes a name some other rule already covers', () => {
    const unknownDialectUpperStoring: DbConnectionFacts = {
      ...postgres, databaseProductName: null, storesLowerCaseIdentifiers: false, storesUpperCaseIdentifiers: true,
    };
    expect(needsQuoting('user', unknownDialectUpperStoring)).toBe(true);
  });
});

describe('quoteIdentifier', () => {
  it('wraps in the connection quote character and doubles an embedded one', () => {
    expect(quoteIdentifier('we"ird', postgres)).toBe('"we""ird"');
  });

  it('falls back to a double quote when the driver reports none', () => {
    const noQuote: DbConnectionFacts = { ...postgres, identifierQuote: ' ' };
    expect(quoteIdentifier('plain', noQuote)).toBe('"plain"');
  });
});

describe('maybeQuote', () => {
  it('leaves a name that needs no quoting untouched', () => {
    expect(maybeQuote('orders', postgres)).toBe('orders');
  });

  it('quotes a name that needs it', () => {
    expect(maybeQuote('Orders', postgres)).toBe('"Orders"');
  });

  it('quotes a reserved-keyword table name with the connection\'s own quote character', () => {
    expect(maybeQuote('order', postgres)).toBe('"order"');
  });
});

describe('qualifiedTableName', () => {
  it('a table in the default schema is unqualified', () => {
    expect(qualifiedTableName({ schema: 'public', name: 'orders', type: 'TABLE' }, postgres)).toBe('orders');
  });

  it('a table with no schema at all (MySQL/MariaDB) is unqualified', () => {
    expect(qualifiedTableName({ schema: null, name: 'orders', type: 'TABLE' }, postgres)).toBe('orders');
  });

  it('a table outside the default schema is qualified', () => {
    expect(qualifiedTableName({ schema: 'reporting', name: 'orders', type: 'TABLE' }, postgres))
      .toBe('reporting.orders');
  });

  it('quotes whichever part needs it, independently', () => {
    expect(qualifiedTableName({ schema: 'Reporting', name: 'orders', type: 'TABLE' }, postgres))
      .toBe('"Reporting".orders');
  });

  it('duplicate table names in different schemas produce different qualified names', () => {
    const a = qualifiedTableName({ schema: 'sales', name: 'orders', type: 'TABLE' }, postgres);
    const b = qualifiedTableName({ schema: 'archive', name: 'orders', type: 'TABLE' }, postgres);
    expect(a).not.toBe(b);
  });

  it('quotes a reserved-keyword table name', () => {
    expect(qualifiedTableName({ schema: 'public', name: 'order', type: 'TABLE' }, postgres)).toBe('"order"');
  });
});

describe('tableKey', () => {
  it('two same-named tables in different schemas get different keys', () => {
    expect(tableKey({ schema: 'a', name: 'orders' })).not.toBe(tableKey({ schema: 'b', name: 'orders' }));
  });

  it('a null schema is treated consistently, not as the literal string "null"', () => {
    expect(tableKey({ schema: null, name: 'orders' })).toBe(tableKey({ schema: null, name: 'orders' }));
  });
});

describe('DEFAULT_CONNECTION_FACTS', () => {
  it('is a safe placeholder before the real facts have loaded', () => {
    expect(needsQuoting('Orders', DEFAULT_CONNECTION_FACTS)).toBe(false);
  });
});
