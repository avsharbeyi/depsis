import { z } from 'zod';

/**
 * Cursor pagination. Master prompt §14: "Cursor pagination; büyük listelerde offset kullanma."
 *
 * Offset pagination is not merely slower on large folders — it is incorrect while the
 * underlying set is changing, which for a NAS is all the time. A file inserted above the
 * current offset shifts every later page, so a client walking pages silently skips entries.
 * For a file manager that means a "copy this folder" job quietly missing files.
 */

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export const cursorRequestSchema = z.object({
  /** Opaque. Clients must never construct or parse one — the encoding is server-owned and
   *  free to change. */
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type CursorRequest = z.infer<typeof cursorRequestSchema>;

export interface CursorPage<T> {
  items: T[];
  /** Absent when there is no further page. */
  nextCursor?: string;
  /**
   * Deliberately NOT a total count.
   *
   * A total is an existence oracle: computing it over the unfiltered set leaks how many rows
   * the caller is not allowed to see, which is precisely the leak ADR-0013 §2.2 and the threat
   * model §5.5 describe. If a count is ever needed it must be computed under the same ACL and
   * RLS scope as the page itself, and it gets its own field with its own review.
   */
  hasMore: boolean;
}

export function cursorPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
    hasMore: z.boolean(),
  });
}
