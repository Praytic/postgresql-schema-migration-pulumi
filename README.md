# PostgreSQL Schema Migration Pulumi Provider

[Pulumi](https://www.pulumi.com/) custom [resource provider](https://www.pulumi.com/docs/iac/concepts/resources/providers/) that manages PostgreSQL schema migrations by replicating [Flyway](https://github.com/flyway/flyway)'s logic and immutability principles.

## How it works?

Each SQL migration file (which ends with `.up.sql`) in the `sql/` directory creates a corresponding Pulumi [resource](https://www.pulumi.com/docs/iac/concepts/resources/) that applies the migration to the PostgreSQL database. The provider ensures migrations are applied in sequential order with strict dependency chains, where each migration waits for the previous one to complete successfully before executing.

When deploying migrations, the provider scans for SQL files following the pattern `V{version}__{description}.{up|down}.sql` and creates `postgresql:SchemaVersion` resources. Each resource executes `.up.sql` script on creation which applies the migration. You can provide `.down.sql` script if you want to rollback the migration when resource is [destoyed](https://www.pulumi.com/docs/iac/cli/commands/pulumi_destroy/).

## Examples

In the [examples](examples) directory you will find a minimal project that applies migrations against containerized PostgreSQL instance.

### Migration application

When deploying to a fresh environment, all migrations are applied in sequential order with dependency chains ensuring proper execution order.

```
Updating (myorg/postgresql-migrations/dev)

     Type                                                       Name                        Status              Info
 +   pulumi:pulumi:Stack                                        postgresql-migrations-dev  created (2s)        5 messages
 +   ├─ pulumi-nodejs:dynamic:postgresql:SchemaVersion          V001__initial-DDL.up        created (0.60s)     
 +   └─ pulumi-nodejs:dynamic:postgresql:SchemaVersion          V002__test.up               created (0.39s)     

Diagnostics:
  pulumi:pulumi:Stack (postgresql-migrations-dev):
    Applied migration: 001 - initial DDL
    Applied migration: 002 - test
    Found 2 migrations to process

Resources:
    + 3 created
```

### Checksum verification
`postgresql:SchemaVersion` resource stores checksums of both UP and DOWN SQL content to detect any modifications after deployment. If you attempt to modify a previously applied migration file, the system will fail with a checksum mismatch error, enforcing immutability that prevents accidental data corruption from changed migration scripts.

```
Diagnostics:
  pulumi:pulumi:Stack (postgresql-migrations-dev):
    Error: Migration 001 checksum mismatch. SchemaVersion resources are immutable once applied.

  pulumi-nodejs:dynamic:postgresql:SchemaVersion (V001__initial-DDL.up):
    error: Migration 001 checksum mismatch. SchemaVersion resources are immutable once applied.

Resources:
    1 unchanged
```

### Migration rollback
When destroying resources, migrations are rolled back in reverse order using down scripts, with targeted removal using `pulumi destroy --target` or state-only removal using `pulumi state delete`.

```
Destroying (myorg/postgresql-migrations/dev)

     Type                                                       Name                        Status              Info
 -   pulumi:pulumi:Stack                                        postgresql-migrations-dev  deleted (0.08s)     4 messages
 -   ├─ pulumi-nodejs:dynamic:postgresql:SchemaVersion          V002__test.up               deleted (0.18s)     
 -   └─ pulumi-nodejs:dynamic:postgresql:SchemaVersion          V001__initial-DDL.up        deleted (0.70s)     

Diagnostics:
  pulumi:pulumi:Stack (postgresql-migrations-dev):
    No down migration found for 002, skipping rollback
    Rolled back migration: 001 - initial DDL

Resources:
    - 3 deleted
```
