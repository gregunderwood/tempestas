import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import type {
  AdmitNodePayload,
  DayNightStats,
  Device,
  Node,
  Reading,
  ReadingStats,
  ReadingsQuery,
  RulesEvaluation,
  RulesCycle,
  Zone,
} from '@tempestas/domain';

/**
 * Every call is typed against `@tempestas/domain` - the same interfaces the
 * server's DTOs `implement`. The old client hand-duplicated its types and got
 * `Reading.id` wrong (declared `number`, actually a UUID); here that mistake
 * cannot compile.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api';

  // ------------------------------------------------------------------ nodes

  nodes(): Observable<Node[]> {
    return this.http.get<Node[]>(`${this.base}/nodes`);
  }

  admitNode(id: string, payload: AdmitNodePayload = {}): Observable<Node> {
    return this.http.post<Node>(`${this.base}/nodes/${id}/admit`, payload);
  }

  disableNode(id: string): Observable<Node> {
    return this.http.post<Node>(`${this.base}/nodes/${id}/disable`, {});
  }

  // ---------------------------------------------------------------- devices

  devices(): Observable<Device[]> {
    return this.http.get<Device[]>(`${this.base}/devices`);
  }

  turnOn(id: string): Observable<Device> {
    return this.http.post<Device>(`${this.base}/devices/${id}/on`, {});
  }

  turnOff(id: string): Observable<Device> {
    return this.http.post<Device>(`${this.base}/devices/${id}/off`, {});
  }

  /** Bypasses the cooldown, not the already-on check. Never a plain toggle. */
  forceOn(id: string): Observable<Device> {
    return this.http.post<Device>(`${this.base}/devices/${id}/force-on`, {});
  }

  setRulesEnabled(id: string, rulesEnabled: boolean): Observable<Device> {
    return this.http.patch<Device>(`${this.base}/devices/${id}`, {
      rulesEnabled,
    });
  }

  // --------------------------------------------------------------- readings

  latestReadings(): Observable<Reading[]> {
    return this.http.get<Reading[]>(`${this.base}/readings/latest`);
  }

  readings(query: ReadingsQuery = {}): Observable<Reading[]> {
    return this.http.get<Reading[]>(`${this.base}/readings`, {
      params: toParams(query),
    });
  }

  stats(query: ReadingsQuery = {}): Observable<ReadingStats> {
    return this.http.get<ReadingStats>(`${this.base}/readings/stats`, {
      params: toParams(query),
    });
  }

  /** The same window split at the zone's own daylight boundary. */
  dayNightStats(query: ReadingsQuery = {}): Observable<DayNightStats> {
    return this.http.get<DayNightStats>(
      `${this.base}/readings/stats/day-night`,
      {
        params: toParams(query),
      },
    );
  }

  // ------------------------------------------------------------------ zones

  zones(): Observable<Zone[]> {
    return this.http.get<Zone[]>(`${this.base}/zones`);
  }

  // ------------------------------------------------------------------ rules

  fetchLatestRulesCycle(): Observable<RulesCycle | null> {
    return this.http
      .get<{ cycle: RulesCycle | null }>(`${this.base}/rules/latest-cycle`)
      .pipe(map((body) => body.cycle));
  }

  /** Every input alongside every decision. The debugging endpoint. */
  lastEvaluation(): Observable<RulesEvaluation[]> {
    return this.http.get<RulesEvaluation[]>(
      `${this.base}/rules/last-evaluation`,
    );
  }
}

/** Undefined keys are dropped rather than sent as the string "undefined". */
export function toParams(query: ReadingsQuery): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params = params.set(key, String(value));
    }
  }
  return params;
}
