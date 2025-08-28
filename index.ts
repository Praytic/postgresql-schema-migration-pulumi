import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const config = new pulumi.Config("postgresql")

async function withPgClient<T>(callback: (client: any) => Promise<T>): Promise<T> {
  const { Client } = require("pg");
  const client = new Client({
    host: config.require("host"),
    port: config.requireNumber("port"),
    database: config.require("database"),
    user: config.require("username"),
    password: config.require("password"), // Use require instead of requireSecret
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.end();
  }
}

interface SchemaVersionArgs {
  version: string;
  name: string;
  upSql: string;
  downSql?: string;
  database: string;
}

interface SchemaVersionState {
  version: string;
  name: string;
  upSqlChecksum: string;
  downSqlChecksum?: string;
  appliedAt: string;
}

const provider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: SchemaVersionArgs): Promise<pulumi.dynamic.CreateResult> {
    return await withPgClient(async (client) => {
      await client.query(inputs.upSql);
      const upChecksum = crypto
        .createHash('sha256')
        .update(inputs.upSql)
        .digest('hex');
      
      const downChecksum = inputs.downSql ? crypto
        .createHash('sha256')
        .update(inputs.downSql)
        .digest('hex') : undefined;

      console.log(`Applied migration: ${inputs.version} - ${inputs.name}`);

      return {
        id: `${inputs.database}-${inputs.version}-${Date.now()}`,
        outs: {
          version: inputs.version,
          name: inputs.name,
          upSqlChecksum: upChecksum,
          downSqlChecksum: downChecksum,
          appliedAt: new Date().toISOString(),
        }
      };
    }).catch(error => {
      if (error instanceof Error) {
        console.error("Migration error details:", {
          stack: error.stack,
          ...error
        });
      }
      throw new Error(`Failed to apply migration ${inputs.version}: ${error}`);
    });
  },

  async diff(id: string, olds: SchemaVersionState, news: SchemaVersionArgs): Promise<pulumi.dynamic.DiffResult> {
    const currentUpChecksum = crypto
      .createHash('sha256')
      .update(news.upSql)
      .digest('hex');
    
    const currentDownChecksum = news.downSql ? crypto
      .createHash('sha256')
      .update(news.downSql)
      .digest('hex') : undefined;

    if (olds.upSqlChecksum !== currentUpChecksum) {
      throw new Error(`Migration ${news.version} UP SQL checksum mismatch. SchemaVersion resources are immutable once applied.`);
    }
    
    if (olds.downSqlChecksum !== currentDownChecksum) {
      throw new Error(`Migration ${news.version} DOWN SQL checksum mismatch. SchemaVersion resources are immutable once applied.`);
    }

    return { changes: false };
  },

  async update(id: string, olds: SchemaVersionState, news: SchemaVersionArgs): Promise<pulumi.dynamic.UpdateResult> {
    throw new Error(`Migration ${news.version} cannot be updated. SchemaVersion resources are immutable.`);
  },

  async delete(id: string, props: SchemaVersionState): Promise<void> {
    const migrationManager = new FileMigrationManager(path.join(__dirname, "sql"));
    const migrationFiles = migrationManager.getMigrationFiles();
    const migration = migrationFiles.find(m => m.version === props.version);

    if (!migration?.downPath || !fs.existsSync(migration.downPath)) {
      console.warn(`No down migration found for ${props.version}, skipping rollback`);
      return;
    }

    await withPgClient(async (client) => {
      const downSql = fs.readFileSync(migration.downPath!, 'utf-8');
      await client.query(downSql);
      console.log(`Rolled back migration: ${props.version} - ${props.name}`);
    }).catch(error => {
      console.error(`Failed to rollback migration ${props.version}:`, error);
      throw error;
    });
  },

  async read(id: string, props: SchemaVersionState): Promise<pulumi.dynamic.ReadResult> {
    // This is called during refresh operations
    return {
      id: id,
      props: props
    };
  }
};

class SchemaVersion extends pulumi.dynamic.Resource {
  constructor(name: string, args: SchemaVersionArgs, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, {
      ...args,
      upSqlChecksum: "",
      downSqlChecksum: "",
      appliedAt: ""
    }, {
      ...opts,
    }, undefined, "postgresql:SchemaVersion");
  }
}

interface MigrationFile {
  version: string;
  name: string;
  upPath: string;
  downPath?: string;
}

class FileMigrationManager {
  private migrationFiles: MigrationFile[] = [];

  constructor(private migrationsPath: string) {
    this.loadMigrationFiles();
  }

  private loadMigrationFiles(): void {
    if (!fs.existsSync(this.migrationsPath)) {
      throw new Error(`Migrations directory not found: ${this.migrationsPath}`);
    }

    const files = fs.readdirSync(this.migrationsPath).sort();
    const migrationMap = new Map<string, MigrationFile>();

    for (const file of files) {
      // Parse migration files with pattern: V{version}__{description}.{up|down}.sql
      // Examples: V001__create_users.up.sql, V001__create_users.down.sql
      const versionMatch = file.match(/^V(\d+)__(.+)\.(up|down)\.sql$/);

      if (versionMatch) {
        const [, version, description, direction] = versionMatch;
        const key = `V${version}__${description}`;

        if (!migrationMap.has(key)) {
          migrationMap.set(key, {
            version: version,
            name: description.replace(/_/g, '-'),
            upPath: '',
            downPath: undefined
          });
        }

        const migration = migrationMap.get(key)!;
        const filePath = path.join(this.migrationsPath, file);

        if (direction === 'up') {
          migration.upPath = filePath;
        } else {
          migration.downPath = filePath;
        }
      }
    }

    this.migrationFiles = Array.from(migrationMap.values())
      .filter(m => m.upPath)
      .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));

    if (this.migrationFiles.length === 0) {
      console.warn(`No migration files found in ${this.migrationsPath}`);
    } else {
      console.log(`Found ${this.migrationFiles.length} migrations to process`);
    }
  }

  createMigrationResources(): SchemaVersion[] {
    const migrations: SchemaVersion[] = [];
    let previousMigration: SchemaVersion | undefined;

    for (const migrationFile of this.migrationFiles) {
      const upSql = this.readSqlFile(migrationFile.upPath);
      const downSql = migrationFile.downPath
        ? this.readSqlFile(migrationFile.downPath)
        : undefined;

      const resourceName = path.basename(migrationFile.upPath, '.sql');

      const migration = new SchemaVersion(resourceName, {
        version: migrationFile.version,
        name: migrationFile.name,
        upSql: upSql,
        downSql: downSql,
        database: config.require("database")
      }, {
        dependsOn: previousMigration ? [previousMigration] : []
      });

      migrations.push(migration);
      previousMigration = migration;
    }

    return migrations;
  }

  private readSqlFile(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      throw new Error(`SQL file not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  getMigrationFiles(): MigrationFile[] {
    return this.migrationFiles;
  }
}

const migrations = new FileMigrationManager(path.join(__dirname, "sql"));
const migrationResources = migrations.createMigrationResources();

const lastMigration = migrations.getMigrationFiles().slice(-1)[0];
export const currentMigrationVersion = lastMigration ? lastMigration.version : null;
export const migrationCount = migrationResources.length;
