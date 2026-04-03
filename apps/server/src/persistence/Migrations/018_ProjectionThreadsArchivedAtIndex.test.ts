import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("018_ProjectionThreadsArchivedAtIndex", (it) => {
  it.effect(
    "adds archived_at before creating the index when migration 17 is already recorded",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 16 });

        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (17, 'ProjectionThreadsArchivedAt')
        `;

        yield* runMigrations({ toMigrationInclusive: 18 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        assert.ok(columns.some((column) => column.name === "archived_at"));

        const indexes = yield* sql<{
          readonly seq: number;
          readonly name: string;
          readonly unique: number;
          readonly origin: string;
          readonly partial: number;
        }>`
          PRAGMA index_list(projection_threads)
        `;
        assert.ok(
          indexes.some((index) => index.name === "idx_projection_threads_project_archived_at"),
        );

        const indexColumns = yield* sql<{
          readonly seqno: number;
          readonly cid: number;
          readonly name: string;
        }>`
          PRAGMA index_info('idx_projection_threads_project_archived_at')
        `;
        assert.deepStrictEqual(
          indexColumns.map((column) => column.name),
          ["project_id", "archived_at"],
        );
      }),
  );
});
