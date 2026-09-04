import { Controller, Req, Sse, UnauthorizedException, UseGuards } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { ProblemException } from '../common/problem.filter.js';
import { EventsService, type DepsisEvent } from './events.service.js';

/** What `@Sse` serialises. Nest's own `MessageEvent` type, restated so the mapping is visible. */
interface SseFrame {
  type: string;
  id: string;
  data: unknown;
}

/**
 * §14's event stream.
 *
 * ONE ENDPOINT, NOT ONE PER RESOURCE. A browser holds a small number of connections per origin,
 * and a stream per screen would spend them on idle sockets — the file manager, the jobs board and
 * the transfers panel open together would be three. So the transport carries typed events and the
 * client dispatches on `event.type`, which is what SSE's event name is for.
 *
 * SSE AND NOT A WEBSOCKET, and the choice is already made: ADR-0018 argued it for the console and
 * the reasons hold here more strongly, because this stream is one-directional by nature. Nest has
 * `@Sse` in the framework, a WebSocket needs a gateway and a dependency, and `EventSource`
 * reconnects on its own and resends `Last-Event-ID` — which is precisely what §14 asks for. The
 * console's `@Sse(':id/stream')` is the working precedent in this codebase.
 *
 * WHAT EACH SUBSCRIBER IS ALLOWED TO SEE is decided in the service and matches the REST routes
 * exactly: `job` events go to administrators, because `GET /jobs` is admin-only; `transfer` events
 * go to the person whose upload it is, because `GET /transfers` shows a person their own. A stream
 * that widened either would be a leak with no endpoint to blame it on.
 */
@Controller('events')
@UseGuards(SessionGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * Subscribe.
   *
   * `Last-Event-ID` is read here because Nest does not: `@Sse` wires up the response framing and
   * leaves the resume header to the handler. The browser sends it automatically on every
   * reconnect, so honouring it is the difference between a dropped Wi-Fi connection costing
   * nothing and costing every event that happened while it was down.
   *
   * REWOUND BY A MILLISECOND. The id is `updated_at` in epoch milliseconds and PostgreSQL keeps
   * microseconds, so two rows can share an id; resuming strictly after it would drop the second.
   * A millisecond of overlap re-sends at most a handful of events the client already has, and
   * every event carries the whole row, so a duplicate is a no-op where a gap is a job that stays
   * "running" on screen forever.
   */
  @Sse()
  subscribe(@Req() request: AuthenticatedRequest): Observable<SseFrame> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();

    if (this.events.full) {
      // A real refusal rather than a silent queue. `EventSource` retries on its own, so a client
      // that arrives during a spike comes back — and `Retry-After` tells anything that reads it
      // how long to wait instead of hammering.
      throw new ProblemException(
        'rate-limited',
        'Bu cihazda aynı anda açılabilecek olay akışı sayısına ulaşıldı.',
        undefined,
        5,
      );
    }

    return this.events
      .subscribe(
        session.organizationId,
        session.userId,
        session.role === 'admin',
        resumeFrom(request),
      )
      .pipe(map(toFrame));
  }
}

function toFrame(event: DepsisEvent): SseFrame {
  return { type: event.type, id: event.id, data: event.data };
}

/**
 * The point to resume from, or nothing.
 *
 * A header a client controls, so it is parsed defensively: anything that is not a plausible epoch
 * is ignored rather than refused. A malformed resume point is a client bug whose worst outcome
 * should be a fresh stream, not a sign-in screen.
 *
 * TABANLI. Bir gün uyuyan dizüstü uyanınca dünkü kimlikle bağlanıyor, ve filigran kiracının
 * ortağı olduğu için o geri sarma o an bağlı HER yöneticiye dünkü geçmişi yeniden akıtırdı —
 * `Last-Event-ID: 1` yazan sıradan bir üye de aynısını isteyerek yaptırabilirdi. Kayıp yok: akışa
 * bağlanan istemci zaten REST anlık görüntüsünü çekiyor. Servis aynı tabanı kendi içinde de
 * uyguluyor; bu buradaki denetimin yerine geçmez, iki katman aynı kararı veriyor.
 */
function resumeFrom(request: AuthenticatedRequest): Date | null {
  const raw = request.headers['last-event-id'];
  const text = typeof raw === 'string' ? raw : '';
  const millis = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(millis) || millis <= 0) return null;

  const at = new Date(Math.max(millis - 1, Date.now() - EventsService.MAX_REWIND_MS));
  // A resume point in the future would seed a watermark nothing can ever pass, and the stream
  // would go permanently silent for everybody in the organisation.
  if (at.getTime() > Date.now()) return null;
  return at;
}
