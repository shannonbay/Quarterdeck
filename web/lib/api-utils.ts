import { NextResponse } from 'next/server'
import { schemaOutdated } from './db'

/** What the web app answers to a change once a newer Quarterdeck has upgraded the database. */
export const OUTDATED_WEB_MESSAGE =
  'Quarterdeck was updated by a newer version elsewhere, and this web app still runs the older one, which could misread newer goal data. Restart the web app (after updating it) before changing goals.'

/**
 * A 409 for a route that changes goals or settles items while the database is newer than
 * this code (#60), or null when it may go ahead. Reads stay open, so the page still shows
 * everything. Every mutating /api/goals route calls this first.
 */
export function refuseIfOutdated(): NextResponse | null {
  return schemaOutdated() ? err(OUTDATED_WEB_MESSAGE, 409) : null
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status })
}

export function err(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

export function notFound(what = 'Resource'): NextResponse {
  return err(`${what} not found`, 404)
}

export function conflict(message: string): NextResponse {
  return err(message, 409)
}

export function serverError(e: unknown): NextResponse {
  const message = e instanceof Error ? e.message : String(e)
  console.error('[API Error]', e)
  return err(message, 500)
}
