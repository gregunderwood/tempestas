import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { buildRequestContext, type RequestOptions } from './background-request';
import type {
  AdmitNodePayload,
  CreateDevicePayload,
  DayNightStats,
  Device,
  EquipmentRuntimeQuery,
  EquipmentRuntimeReport,
  FreezeMarginQuery,
  FreezeMarginReport,
  Node,
  NodeHealthQuery,
  NodeHealthReport,
  NodeUpdateRequest,
  Reading,
  ReadingStats,
  ReadingsQuery,
  RulesEvaluation,
  RulesCycle,
  UpdateDevicePayload,
  Zone,
  ZoneHistoryReport,
} from '@tempestas/domain';

const API_ROOT = '/api';

type QueryParameters =
  ReadingsQuery | EquipmentRuntimeQuery | FreezeMarginQuery | NodeHealthQuery;

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  nodes(options: RequestOptions = {}): Observable<Node[]> {
    return this.getFromApi<Node[]>('/nodes', options);
  }

  admitNode(id: string, payload: AdmitNodePayload = {}): Observable<Node> {
    return this.postToApi<Node>(`/nodes/${id}/admit`, payload);
  }

  disableNode(id: string): Observable<Node> {
    return this.postToApi<Node>(`/nodes/${id}/disable`);
  }

  updateNode(id: string, request: NodeUpdateRequest): Observable<Node> {
    return this.postToApi<Node>(`/nodes/${id}/update`, request);
  }

  rollBackNode(id: string, request: NodeUpdateRequest): Observable<Node> {
    return this.postToApi<Node>(`/nodes/${id}/roll-back`, request);
  }

  devices(options: RequestOptions = {}): Observable<Device[]> {
    return this.getFromApi<Device[]>('/devices', options);
  }

  createDevice(payload: CreateDevicePayload): Observable<Device> {
    return this.postToApi<Device>('/devices', payload);
  }

  updateDevice(id: string, payload: UpdateDevicePayload): Observable<Device> {
    return this.http.put<Device>(`${API_ROOT}/devices/${id}`, payload);
  }

  turnOn(id: string): Observable<Device> {
    return this.postToApi<Device>(`/devices/${id}/on`);
  }

  turnOff(id: string): Observable<Device> {
    return this.postToApi<Device>(`/devices/${id}/off`);
  }

  // Bypasses the cooldown, not the already-on check, so it is never a plain toggle.
  forceOn(id: string): Observable<Device> {
    return this.postToApi<Device>(`/devices/${id}/force-on`);
  }

  setRulesEnabled(id: string, rulesEnabled: boolean): Observable<Device> {
    return this.http.patch<Device>(`${API_ROOT}/devices/${id}`, {
      rulesEnabled,
    });
  }

  latestReadings(options: RequestOptions = {}): Observable<Reading[]> {
    return this.getFromApi<Reading[]>('/readings/latest', options);
  }

  readings(
    query: ReadingsQuery = {},
    options: RequestOptions = {},
  ): Observable<Reading[]> {
    return this.getFromApi<Reading[]>('/readings', options, query);
  }

  stats(query: ReadingsQuery = {}): Observable<ReadingStats> {
    return this.getFromApi<ReadingStats>('/readings/stats', {}, query);
  }

  dayNightStats(
    query: ReadingsQuery = {},
    options: RequestOptions = {},
  ): Observable<DayNightStats> {
    return this.getFromApi<DayNightStats>(
      '/readings/stats/day-night',
      options,
      query,
    );
  }

  fetchEquipmentRuntime(
    query: EquipmentRuntimeQuery = {},
    options: RequestOptions = {},
  ): Observable<EquipmentRuntimeReport> {
    return this.getFromApi<EquipmentRuntimeReport>(
      '/reports/equipment-runtime',
      options,
      query,
    );
  }

  fetchFreezeMargin(
    query: FreezeMarginQuery = {},
    options: RequestOptions = {},
  ): Observable<FreezeMarginReport> {
    return this.getFromApi<FreezeMarginReport>(
      '/reports/freeze-margin',
      options,
      query,
    );
  }

  fetchNodeHealth(
    query: NodeHealthQuery = {},
    options: RequestOptions = {},
  ): Observable<NodeHealthReport> {
    return this.getFromApi<NodeHealthReport>(
      '/reports/node-health',
      options,
      query,
    );
  }

  fetchZones(options: RequestOptions = {}): Observable<Zone[]> {
    return this.getFromApi<Zone[]>('/zones', options);
  }

  fetchZoneHistory(
    options: RequestOptions = {},
  ): Observable<ZoneHistoryReport> {
    return this.getFromApi<ZoneHistoryReport>('/zone-history', options);
  }

  fetchLatestRulesCycle(
    options: RequestOptions = {},
  ): Observable<RulesCycle | null> {
    return this.getFromApi<{ cycle: RulesCycle | null }>(
      '/rules/latest-cycle',
      options,
    ).pipe(map((body) => body.cycle));
  }

  lastEvaluation(): Observable<RulesEvaluation[]> {
    return this.getFromApi<RulesEvaluation[]>('/rules/last-evaluation');
  }

  private getFromApi<Payload>(
    path: string,
    options: RequestOptions = {},
    query?: QueryParameters,
  ): Observable<Payload> {
    return this.http.get<Payload>(`${API_ROOT}${path}`, {
      params: query === undefined ? undefined : buildQueryParams(query),
      context: buildRequestContext(options),
    });
  }

  private postToApi<Payload>(
    path: string,
    body: object = {},
  ): Observable<Payload> {
    return this.http.post<Payload>(`${API_ROOT}${path}`, body);
  }
}

// Undefined keys are dropped rather than sent as the string "undefined".
function buildQueryParams(query: QueryParameters): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params = params.set(key, String(value));
    }
  }
  return params;
}
