import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type StoredGeneratedSite = {
  pages: Record<string, string>;
  css: string;
  js: string;
  media?: Record<string, {
    id: string;
    name: string;
    mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif";
    dataUrl: string;
  }>;
};

export const clientPreviewsTable = pgTable(
  "client_previews",
  {
    idHash: text("id_hash").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    editorHash: text("editor_hash").notNull(),
    projectId: text("project_id").notNull(),
    projectUpdatedAt: bigint("project_updated_at", { mode: "number" }).notNull(),
    site: jsonb("site").$type<StoredGeneratedSite>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("client_previews_editor_hash_idx").on(table.editorHash),
    index("client_previews_expires_at_idx").on(table.expiresAt),
    uniqueIndex("client_previews_editor_project_idx").on(
      table.editorHash,
      table.projectId,
    ),
  ],
);

export const insertClientPreviewSchema = createInsertSchema(clientPreviewsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertClientPreview = z.infer<typeof insertClientPreviewSchema>;
export type ClientPreview = typeof clientPreviewsTable.$inferSelect;