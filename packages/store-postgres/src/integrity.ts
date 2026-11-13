/** Stored numeric data cannot be consumed without losing its exact integer value. */
export class PostgresIntegrityError extends Error {
  constructor(
    readonly column: string,
    detail: string,
  ) {
    super(`Postgres integrity error in ${column}: ${detail}`);
    this.name = "PostgresIntegrityError";
  }
}
