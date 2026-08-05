from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from app.domain.connection import Connection
from app.domain.dashboard import (
    DashboardActivity,
    DashboardAttention,
    DashboardMetrics,
    DashboardOverallStatus,
    DashboardReference,
    DashboardSnapshot,
)
from app.services.connection_operations import ConnectionOperationsService, get_connection_operations_service
from app.services.connections import ConnectionService, get_connection_service
from app.services.clients import ClientService, get_client_service
from app.services.normalization import list_events


_HEARTBEAT_MAX_AGE = timedelta(minutes=15)
_ACTIVITY_LIMIT = 12


class DashboardService:
    """Build the operational Gateway overview in one backend-owned snapshot."""

    def __init__(
        self,
        connections: ConnectionService | None = None,
        clients: ClientService | None = None,
        operations: ConnectionOperationsService | None = None,
        events_reader: Callable[..., list[dict[str, Any]]] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._connections = connections or get_connection_service()
        self._clients = clients or get_client_service()
        self._operations = operations or get_connection_operations_service()
        self._events_reader = events_reader or list_events
        self._now = now or (lambda: datetime.now(timezone.utc))

    async def snapshot(self) -> DashboardSnapshot:
        connections = await self._connections.list_connections()
        clients = self._clients.list_clients()
        client_references = {client.id: DashboardReference(id=client.id, name=client.name) for client in clients}
        runtime_names = {
            self._connections.connection_runtime_name(connection.id): connection
            for connection in connections
        }
        attention = self._attention(connections)
        activity = self._activity(runtime_names, client_references, connections, clients)

        critical = any(item.severity == "critical" for item in attention)
        overall = DashboardOverallStatus(
            state="critical" if critical else "attention" if attention else "healthy",
            label="Problemas críticos" if critical else "Requiere atención" if attention else "Todo funcionando",
        )
        return DashboardSnapshot(
            overall=overall,
            metrics=DashboardMetrics(
                clients=len(client_references),
                connections=len(connections),
                connected=sum(connection.status.state == "connected" for connection in connections),
                active_alerts=len(attention),
            ),
            recent_activity=tuple(activity),
            attention=tuple(attention),
        )

    @staticmethod
    def _reference(connection: Connection) -> DashboardReference:
        return DashboardReference(id=connection.id, name=connection.name)

    @staticmethod
    def _client_reference(connection: Connection) -> DashboardReference:
        client = connection.client
        return DashboardReference(id=connection.client_id, name=client.name if client else "Cliente")

    def _attention(self, connections: list[Connection]) -> list[DashboardAttention]:
        items: list[DashboardAttention] = []
        for connection in connections:
            problem = self._connection_problem(connection)
            if problem is None:
                continue
            severity, status = problem
            items.append(
                DashboardAttention(
                    severity=severity,
                    status=status,
                    client=self._client_reference(connection),
                    connection=self._reference(connection),
                )
            )
        return sorted(items, key=lambda item: (item.severity != "critical", item.client.name.lower(), item.connection.name.lower()))

    def _connection_problem(self, connection: Connection) -> tuple[str, str] | None:
        lifecycle = (connection.status.lifecycle or "").lower()
        state = connection.status.state
        if "auth" in lifecycle or "token" in lifecycle:
            return "critical", "Error de autenticación"
        if state == "disconnected":
            return "critical", "Desconectada"
        if connection.status.health == "unhealthy":
            return "critical", "Error de conexión"
        if state in {"pending", "connecting"}:
            return "warning", "Pendiente de finalizar onboarding"
        if connection.status.health == "degraded":
            return "warning", "Estado degradado"

        try:
            webhook = self._operations.webhook(connection.id)
        except Exception:
            webhook = None
        if webhook and webhook.get("last_error"):
            return "warning", "Webhook con errores"

        heartbeat_at = self._parse_datetime(connection.id)
        if heartbeat_at and self._now() - heartbeat_at > _HEARTBEAT_MAX_AGE:
            return "warning", "Heartbeat vencido"
        return None

    def _parse_datetime(self, connection_id: str) -> datetime | None:
        try:
            value = self._connections.connection_last_heartbeat_at(connection_id)
            if not isinstance(value, str) or not value:
                return None
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None

    def _activity(
        self,
        runtime_names: dict[str, Connection],
        client_references: dict[str, DashboardReference],
        connections: list[Connection],
        clients: list[Any],
    ) -> list[DashboardActivity]:
        items: list[DashboardActivity] = []
        for event in self._events_reader(limit=80):
            if not isinstance(event, dict):
                continue
            activity = self._activity_item(event, runtime_names, client_references)
            if activity is not None:
                items.append(activity)
            if len(items) == _ACTIVITY_LIMIT:
                break
        items.extend(self._creation_activity(connections, clients))
        return sorted(items, key=lambda item: item.occurred_at, reverse=True)[:_ACTIVITY_LIMIT]

    def _creation_activity(self, connections: list[Connection], clients: list[Any]) -> list[DashboardActivity]:
        items: list[DashboardActivity] = []
        for client in clients:
            occurred_at = self._timestamp(getattr(client, "created_at", None))
            if occurred_at is None:
                continue
            items.append(
                DashboardActivity(
                    id=f"client-created-{client.id}",
                    kind="client_created",
                    description="Cliente creado",
                    occurred_at=occurred_at,
                    severity="normal",
                    client=DashboardReference(id=client.id, name=client.name),
                )
            )
        for connection in connections:
            occurred_at = self._timestamp(connection.created_at)
            if occurred_at is None:
                continue
            items.append(
                DashboardActivity(
                    id=f"connection-created-{connection.id}",
                    kind="connection_created",
                    description="Conexión creada",
                    occurred_at=occurred_at,
                    severity="normal",
                    client=self._client_reference(connection),
                    connection=self._reference(connection),
                )
            )
        return items

    @staticmethod
    def _timestamp(value: str | None) -> int | None:
        if not value:
            return None
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None

    def _activity_item(
        self,
        event: dict[str, Any],
        runtime_names: dict[str, Connection],
        client_references: dict[str, DashboardReference],
    ) -> DashboardActivity | None:
        details = event.get("details") if isinstance(event.get("details"), dict) else {}
        pipeline = event.get("pipeline") if isinstance(event.get("pipeline"), dict) else {}
        stage = str(pipeline.get("stage") or "").lower()
        event_name = str(event.get("event") or "").upper()
        severity = str(event.get("severity") or "INFO").lower()
        runtime_name = str(event.get("instance") or "")
        connection = runtime_names.get(runtime_name)
        client_id = str(details.get("client_id") or "")

        kind, description = self._activity_summary(event_name, stage, str(event.get("direction") or ""), severity, details)
        if kind is None:
            return None
        if connection is None and kind not in {"client_created", "client_updated"}:
            return None

        client = self._client_reference(connection) if connection else None
        if client_id and client_id in client_references:
            client = client_references[client_id]
        if kind in {"client_created", "client_updated"}:
            client_name = str(details.get("client_name") or "Cliente")
            client = DashboardReference(id=client_id or str(event.get("id") or "client"), name=client_name)

        return DashboardActivity(
            id=str(event.get("id") or f"activity-{event.get('timestamp') or 0}"),
            kind=kind,
            description=description,
            occurred_at=int(event.get("timestamp") or 0),
            severity="critical" if severity in {"critical", "error"} else "warning" if severity == "warning" else "normal",
            client=client,
            connection=self._reference(connection) if connection else None,
        )

    @staticmethod
    def _activity_summary(
        event_name: str,
        stage: str,
        direction: str,
        severity: str,
        details: dict[str, Any],
    ) -> tuple[str | None, str]:
        if event_name == "CLIENT_CREATED":
            return "client_created", "Cliente creado"
        if event_name == "CONNECTION_CREATED":
            return "connection_created", "Conexión creada"
        if severity in {"error", "critical"} or "failed" in stage or "error" in event_name:
            return "error", "Error en la conexión"
        if direction == "outbound" or "send" in stage:
            return "message_sent", "Mensaje enviado"
        if direction == "inbound":
            return "message_received", "Mensaje recibido"
        if "reconnect" in stage or "RECONNECT" in event_name:
            return "reconnect", "Reconexión iniciada"
        if "webhook" in stage or "WEBHOOK" in event_name:
            return "webhook", "Webhook actualizado"
        if "onboarding" in stage and str(details.get("status") or "") == "ready":
            return "connection_created", "Conexión lista"
        if "onboarding" in stage and "ready" in str(event_name).lower():
            return "connection_created", "Conexión lista"
        if "connection" in stage or "status" in stage:
            return "status_changed", "Estado de conexión actualizado"
        return None, ""


def get_dashboard_service() -> DashboardService:
    return DashboardService()
