//
// lib/pagination.ts — turning `?page=`/`?limit=` into a safe LIMIT/OFFSET.
//
// ⛔ THIS IS A CLASS OF BUG, NOT TWO INSTANCES. `app/api/devices` and
// `app/api/audit` both built their OFFSET out of a bare `parseInt`, and every
// one of the three failure shapes is reachable by an ordinary authenticated
// user with a query string:
//
//   limit=99999999 -> a single SELECT over the whole of `v_devices_flat`, which
//                     is a denial of service sized by the caller;
//   page=0         -> offset -50, and PostgreSQL rejects a negative OFFSET, so
//                     the route answers 500;
//   limit=abc      -> NaN, which travels all the way into the query as a
//                     parameter and answers 500 as well.
//
// ⛔ ONE HELPER, SO A NEW PAGINATED ROUTE CANNOT REINTRODUCE IT. `app/api/
// admin/eol-seed` already clamped its own pair correctly and inline, which is
// exactly how the other two came to differ from it — the correct version was
// never somewhere a third route could reuse. `tests/systemSeams.test.ts`
// enumerates the routes that read these parameters and requires each one to go
// through here, rather than naming the two that were just fixed.
//
// ⛔ NOTHING IS IMPORTED HERE ON PURPOSE. This has to stay usable from a route,
// a client component and a plain `node --test` file alike.

/** What a route gets when the caller says nothing. */
export const DEFAULT_PAGE_SIZE = 50

/**
 * The largest page any caller may ask for.
 *
 * ⛔ A CEILING, NOT A SUGGESTION. The point is that the cost of one request is
 * bounded by the SERVER, not by the query string; a route that needs a bigger
 * page passes its own `maxLimit` and owns that decision explicitly.
 */
export const MAX_PAGE_SIZE = 200

export type Paging = {
  /** 1-based, always >= 1. */
  page: number
  /** Always between 1 and the effective maximum. */
  limit: number
  /** Always >= 0, so it can never produce a negative OFFSET. */
  offset: number
}

/** Anything with a `get` — `URLSearchParams`, or a plain map in a test. */
export type ParamSource = { get(name: string): string | null }

/**
 * Clamp a page/limit pair into something a query can be built from.
 *
 * ⛔ A NON-NUMBER FALLS BACK TO THE DEFAULT RATHER THAN REFUSING. These are
 * list endpoints behind a session; a stray `?page=` from a half-built link
 * should show the first page, not a 400 the operator has to decode. What must
 * never happen is the value reaching the query unexamined.
 */
export function resolvePaging(
  params: ParamSource,
  opts: {
    defaultLimit?: number
    maxLimit?: number
    /**
     * Set when the route does NOT let the caller choose a page size (the audit
     * log fixes it at 50). The `limit` parameter is then ignored entirely
     * rather than silently honoured.
     */
    fixedLimit?: number
  } = {},
): Paging {
  const maxLimit = Math.max(1, Math.floor(opts.maxLimit ?? MAX_PAGE_SIZE))
  const page = clampInt(params.get('page'), 1, 1, Number.MAX_SAFE_INTEGER)
  const limit =
    opts.fixedLimit !== undefined
      ? Math.min(maxLimit, Math.max(1, Math.floor(opts.fixedLimit)))
      : clampInt(params.get('limit'), opts.defaultLimit ?? DEFAULT_PAGE_SIZE, 1, maxLimit)
  // ⛔ COMPUTED HERE, NOT BY THE CALLER. `(page - 1) * limit` written out at
  // each call site is how `page=0` became a negative OFFSET in the first place.
  //
  // ⛔ THE `page >= 1` CLAMP ABOVE IS WHAT ACTUALLY PREVENTS A NEGATIVE OFFSET,
  // and the floor here is belt-and-braces behind it — unreachable while that
  // clamp holds, which is why no test can single out its removal (measured: a
  // mutation dropping it changes no observable behaviour). It is kept because
  // the one promise this module makes is that nothing escapes, and that promise
  // should not rest on a single expression. `tests/systemSeams.test.ts` pins the
  // clamp itself: `page=-5` must come back as page 1.
  const offset = (page - 1) * limit
  return { page, limit, offset: offset > 0 ? offset : 0 }
}

/**
 * Parse an integer and keep it inside [min, max].
 *
 * ⛔ `Number.parseInt` ALONE IS THE BUG. It yields NaN for 'abc' and a
 * caller-sized number for '99999999', and both of those used to travel into a
 * SQL parameter. A non-finite value becomes the fallback; a finite one is
 * clamped, never rejected.
 */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return clamp(fallback, min, max)
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return clamp(fallback, min, max)
  return clamp(n, min, max)
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return Math.floor(n)
}
