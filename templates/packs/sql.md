---
id: sql
title: SQL databases (Postgres, MySQL, SQLite; Prisma, Sequelize, TypeORM, Knex, Drizzle)
---

## @all
- Never build SQL by concatenating or interpolating user input. Use parameterized queries or the ORM's query builder. Raw-query helpers (`$queryRawUnsafe`, `sequelize.query` with string templates, `knex.raw` with interpolation) need extra scrutiny.
- Limits and balances need atomic statements (`UPDATE … SET stock = stock - 1 WHERE id = ? AND stock > 0`) or a transaction with row locks (`SELECT … FOR UPDATE`).

## @architect
- Schema changes go through the project's migration tool; make them backward compatible (add nullable column → backfill → enforce).
- Enforce uniqueness and foreign keys in the database, not only in code.
- Add indexes for new filter, join and sort columns.

## @developer
- Wrap multi-statement changes that must succeed together in a transaction.
- Map unique-violation errors (Postgres `23505`, MySQL `ER_DUP_ENTRY`, Prisma `P2002`) to 409/400 responses.
- Select only the columns you need; never return password hashes.

## @qa
- Concurrency on anything with a limit; duplicates of unique values; very long strings against column limits; deleting a parent that has children.

## @security
- Dynamic identifiers (column or table names from user input for sorting/filtering) must come from an allowlist; parameters can't protect identifiers.
- Check ORM "update from object" calls for mass assignment of protected columns.

## @reviewer
- N+1 queries in loops; missing transactions around related writes; migrations that lock big tables.
