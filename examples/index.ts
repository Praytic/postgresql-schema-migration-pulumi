import * as pulumi from "@pulumi/pulumi";
import { SchemaVersion, FileMigrationManager } from "postgresql-schema-migration-pulumi";
import * as path from "path";

const config = new pulumi.Config("postgresql");
const migrations = new FileMigrationManager(path.join(__dirname, "sql"));
const migrationResources = migrations.createMigrationResources();

export const migrationCount = migrationResources.length;
export const appliedMigrations = migrationResources.map(migration => ({
    name: migration.name,
    version: migration.version
}));
const lastMigration = migrations.getMigrationFiles().slice(-1)[0];
export const currentMigrationVersion = lastMigration ? lastMigration.version : null;
