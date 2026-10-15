/**
 * Cổng (port) phát WebSocket `notification:new`.
 *
 * `NotificationsService` phát qua cổng này; monolith nối cổng tới gateway WS cùng process.
 * Service KHÔNG import thẳng module notification để build độc lập vẫn chạy được.
 */
export const CRM_WS_EMIT_PORT = Symbol('CRM_WS_EMIT_PORT');

export interface WsEmitItem {
  recipient_id: number;
  title: string;
  body: string;
  event_type: string;
  action_url: string | null;
}

export interface WsEmitPort {
  emit(items: WsEmitItem[]): Promise<unknown>;
}
