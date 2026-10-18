/**
 * Shared shapes for every async read. A failed read is never rendered as
 * "none": view models carry the reads that failed in `failures`, and the
 * places where a cap stopped a walk early in `caps` ("showing first N").
 */

export interface Failure {
  /** Which read failed, in words a page can show ("active polls", "DPNS archive"). */
  source: string;
  message: string;
}

export interface Cap {
  source: string;
  /** How many items the walk stopped at. */
  limit: number;
}
