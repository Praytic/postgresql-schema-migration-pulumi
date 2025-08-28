# PostgreSQL Schema Migration Example

This example demonstrates how to use the `@prayitc/postgresql-schema-migration-pulumi` provider to manage database schema migrations.

## Prerequisites

You need a running PostgreSQL instance. Author recommends to use the [Pulumi PostgreSQL provider](https://github.com/pulumi/pulumi-postgresql) to provision a PostgreSQL instance as part of your infrastructure. But you can also use a Docker container.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure PostgreSQL connection:
   ```bash
   pulumi config set --secret postgresql:password your_password
   ```

3. Apply the migrations:
   ```bash
   pulumi up
   ```

4. Check that migrations are applied in the database

5. Rollback the migrations:
    ```bash
    pulumi destroy
    ```
