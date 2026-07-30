/**
 * HTTP plumbing: bounded bodies, JSON responses, security headers, and the static shell.
 *
 * Nothing here knows about workouts. It exists so that `routes.ts` can be about transactions
 * and `index.ts` can be about starting up, and so that the three things that are easy to get
 * subtly wrong — an unbounded request body, a path that escapes the served directory, and a
 * Content-Security-Policy that is present but permissive — each have one place to be right.
 */

import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/**
 * One mebibyte for an ordinary command; eight for an import.
 *
 * The point of a cap is that a client — or something pretending to be one — cannot make this
 * process allocate without limit before authentication has even been checked. The import
 * allowance is separate and larger because it legitimately carries a whole challenge, its plan
 * and its history in one body: the owner's real 29 sessions are about 200 KB, so eight
 * mebibytes is roughly forty times the real thing and still bounded.
 */
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024;

/**
 * How far past the limit an oversized body is drained before the socket is simply cut.
 *
 * Draining lets the client read the 413 instead of seeing a reset. Draining *forever* would let
 * anyone who can reach the port keep this process reading, so there is a ceiling.
 */
export const DRAIN_FACTOR = 4;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Headers every response carries.
 *
 * The CSP is the load-bearing one. `default-src 'self'` with no `unsafe-eval` and no remote
 * origins means an injected `<script src="https://…">` does not execute, `connect-src 'self'`
 * means an injected exfiltration `fetch` has nowhere to send anything, and `frame-ancestors
 * 'none'` means this app cannot be framed and clickjacked into performing a command.
 *
 * `style-src` carries `'unsafe-inline'` and that is a deliberate, narrow concession: React sets
 * inline `style` attributes for the rest timer and the chart geometry, and CSP treats a style
 * *attribute* as inline style. Inline style cannot execute script; the risk it leaves is
 * presentational (an injected style could reposition an element), which is not the risk this
 * header is here to close.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string | string[]>> = {},
): void {
  const payload = JSON.stringify(body);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // No API response is ever cacheable: a stale snapshot is a stale training history.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(Buffer.byteLength(payload)));
  res.end(payload);
}

export function sendError(res: ServerResponse, error: HttpError): void {
  const body: Record<string, unknown> = { error: error.code, message: error.message };
  if (error.details !== undefined) body['details'] = error.details;
  sendJson(res, error.status, body);
}

export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string | string[]>> = {},
): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/**
 * Read and parse a JSON body, refusing anything oversized or mislabelled.
 *
 * The declared `Content-Length` is checked first so an obviously oversized body is rejected
 * before a byte of it is buffered, and the running total is checked as well so a chunked body
 * that lies about its size — or declares no size at all — is cut off at the same limit.
 */
export async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(
      415,
      'unsupported_media_type',
      'This endpoint accepts application/json only.',
    );
  }

  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'body_too_large', `The request body exceeds ${String(limit)} bytes.`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;

  // Read with events rather than `for await`. Breaking out of an async iterator destroys the
  // stream, which cuts the connection while the client is still uploading — and a client that
  // gets a TCP reset never reads the 413 that explains why. So once the limit is passed the
  // chunks are dropped on the floor but the socket keeps draining, up to a hard cut-off, and
  // the client gets a real answer. Memory is bounded either way; only bandwidth is spent.
  await new Promise<void>((settle, fail) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        exceeded = true;
        chunks.length = 0;
        if (total > limit * DRAIN_FACTOR) {
          req.destroy();
          settle();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', settle);
    req.on('close', settle);
    req.on('error', fail);
  });

  if (exceeded) {
    throw new HttpError(413, 'body_too_large', `The request body exceeds ${String(limit)} bytes.`);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    throw new HttpError(400, 'empty_body', 'This endpoint requires a JSON body.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

// ── The static shell ────────────────────────────────────────────────────────────────────────

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a URL path inside `root`, or return `undefined` if it escapes.
 *
 * `normalize` collapses `..` before the join, and the resolved path is then checked to still be
 * under the root — belt and braces, because a single missed encoding here serves arbitrary
 * files off the machine to anyone who can reach the port.
 */
export function resolveStaticPath(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;

  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const absolute = resolve(join(root, relative));
  const rootResolved = resolve(root);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + sep)) return undefined;
  return absolute;
}

/**
 * Cache policy: fingerprinted assets forever, everything else never.
 *
 * Vite emits `assets/name-<hash>.js`, so those are immutable by construction. `index.html` and
 * the service worker must never be cached by an intermediary, or a deploy would leave a browser
 * pinned to the previous build's shell — which for this app means a UI talking to an API it no
 * longer matches.
 */
export function cacheControlFor(relativePath: string): string {
  if (relativePath.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/** Serve one file, or return false when it is not there and the caller should fall back. */
export async function sendFile(
  res: ServerResponse,
  absolutePath: string,
  relativePath: string,
  method: string,
): Promise<boolean> {
  let stats;
  try {
    // `lstat`, not `stat`: the containment check in `resolveStaticPath` is lexical, and `stat`
    // follows symlinks. A symlink inside the served directory pointing anywhere on the disk
    // would otherwise pass containment and then be read from its target. Refusing anything that
    // is not a plain file closes that without needing a second realpath comparison, and costs
    // nothing — Vite's output contains no symlinks.
    stats = await lstat(absolutePath);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;

  res.statusCode = 200;
  res.setHeader('Content-Type', CONTENT_TYPES[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(stats.size));
  res.setHeader('Cache-Control', cacheControlFor(relativePath));
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(absolutePath);
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
    stream.pipe(res);
  });
  return true;
}
