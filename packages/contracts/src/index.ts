/**
 * @depsis/contracts — the single source of truth for the DEPSIS HTTP API surface.
 *
 * Scope note (ADR-0006): the SYSTEM AGENT IPC schema is NOT here. It is owned by the Rust agent
 * and emitted from its own types via schemars, because the side that enforces a trust boundary
 * must own the contract for it. The generated .d.ts is committed and CI fails on drift; the
 * unprivileged side never gets to define what the privileged side accepts.
 */

export * from './errors.js';

/*
 * Sayfalama sabitleri BURADA DEĞİL, belgede.
 *
 * `pagination.ts` `MAX_PAGE_SIZE = 200` / `DEFAULT_PAGE_SIZE = 50` ilan ediyordu ve hiçbir yerden
 * okunmuyordu — sunucu kendi tavanlarını uyguluyor (`/files` 100/500, `/search` ve `/audit`
 * 50/200), yani iki gerçeklik sessizce yan yana yaşıyordu. Sözleşmede sayılan tek yer
 * `openapi/depsis.yaml`in `Limit` ve `FilesLimit` parametreleri; kullanılmayan ikinci bir liste,
 * gün gelip ayrıştığında kimsenin fark etmeyeceği bir liste demekti.
 */

/**
 * The generated view of `openapi/depsis.yaml`.
 *
 * Re-exported under a namespace rather than flattened, because these names come from the document
 * and the document owns them: a collision between a generated `LoginRequest` and a hand-written one
 * should be impossible to create by accident.
 *
 * Server code importing this is what turns contract drift into a compile error rather than a
 * discrepancy somebody notices later. `apps/api` types its request and response bodies against
 * `components['schemas'][...]`, so renaming a field in the YAML breaks the build.
 */
export type * as OpenApi from './generated/api.js';
