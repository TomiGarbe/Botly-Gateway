import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  CircleOff,
  Cloud,
  Cable,
  MessageCircle,
  PlugZap,
  Plus,
  Radio,
  RefreshCw,
  Send,
  ServerCog,
  ShieldAlert,
  TestTube2,
  Workflow,
} from "lucide-react";
import ActivityCenter from "./ActivityCenter";
import {
  DashboardCard,
  HealthCard,
  KpiCard,
  PendingWorkCard,
  QuickAction,
  StatusCard,
  type OperationalTone,
} from "./DashboardPrimitives";
import type { AutomationExecution, Instance, OperationJob, OperationalAlert, OperationalAutomation, PipelineEvent } from "../types";
import { formatActivity, statusLabel } from "../lib/connectionUx";

type Props = {
  instances: Instance[];
  events: PipelineEvent[];
  alerts: OperationalAlert[];
  automations: OperationalAutomation[];
  automationExecutions: AutomationExecution[];
  operations: OperationJob[];
  isLoading?: boolean;
  onNewConnection: () => void;
  onOpenTests: () => void;
  onOpenActivity: () => void;
  onOpenAlerts: () => void;
  onOpenAutomations: () => void;
  onOpenOperations: () => void;
  onOpenConnections: () => void;
  onOpenWorkspace: (name: string) => void;
};

function eventSeverity(event: PipelineEvent) {
  if (event.severity) return event.severity;
  const value =
    `${event.event} ${event.pipeline?.status || ""} ${event.error?.message || ""}`.toLowerCase();
  return /error|failed|fail/.test(value)
    ? "ERROR"
    : /warning|retry|ignored/.test(value)
      ? "WARNING"
      : "INFO";
}

function eventComponent(event: PipelineEvent) {
  if (event.component) return event.component;
  const value = `${event.event} ${event.pipeline?.stage || ""}`.toLowerCase();
  if (/meta|oauth|phone|subscription|discovery/.test(value)) return "Meta";
  if (/webhook|dispatch/.test(value)) return "Webhooks";
  if (/send|message/.test(value)) return "Mensajería";
  if (/evolution/.test(value)) return "Evolution";
  return "Gateway";
}

function relative(value?: number | string | null) {
  if (!value) return "Sin eventos";
  const timestamp =
    typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Sin eventos";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  if (minutes < 1440) return `hace ${Math.floor(minutes / 60)} h`;
  return `hace ${Math.floor(minutes / 1440)} d`;
}

function componentHealth(
  name: string,
  events: PipelineEvent[],
  available: boolean,
): {
  status: string;
  tone: OperationalTone;
  incidents: number | null;
  latest: string;
} {
  const relevant = events.filter((event) => eventComponent(event) === name);
  const errors = relevant.filter((event) =>
    ["ERROR", "CRITICAL"].includes(eventSeverity(event)),
  ).length;
  const warnings = relevant.filter(
    (event) => eventSeverity(event) === "WARNING",
  ).length;
  if (!available || relevant.length === 0)
    return {
      status: "No disponible",
      tone: "unknown",
      incidents: null,
      latest: "No disponible",
    };
  if (errors)
    return {
      status: "Con error",
      tone: "error",
      incidents: errors,
      latest: relative(relevant[0]?.timestamp),
    };
  if (warnings)
    return {
      status: "Revisar",
      tone: "attention",
      incidents: warnings,
      latest: relative(relevant[0]?.timestamp),
    };
  return {
    status: "Operativo",
    tone: "healthy",
    incidents: 0,
    latest: relative(relevant[0]?.timestamp),
  };
}

export default function OperationalDashboard({
  instances,
  events,
  alerts,
  automations,
  automationExecutions,
  operations,
  isLoading,
  onNewConnection,
  onOpenTests,
  onOpenActivity,
  onOpenAlerts,
  onOpenAutomations,
  onOpenOperations,
  onOpenConnections,
  onOpenWorkspace,
}: Props) {
  const ordered = [...events].sort(
    (a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0),
  );
  const errors = instances.filter(
    (instance) =>
      instance.lifecycleState === "failed" ||
      instance.lifecycleState === "token_expired" ||
      instance.lifecycleState === "webhook_invalid" ||
      instance.health === "unhealthy",
  );
  const warnings = instances.filter(
    (instance) =>
      !errors.includes(instance) &&
      (instance.lifecycleState === "warning" ||
        instance.lifecycleState === "needs_attention" ||
        instance.health === "degraded"),
  );
  const provisioning = instances.filter(
    (instance) =>
      instance.status === "connecting" ||
      instance.lifecycleState === "provisioning" ||
      instance.lifecycleState === "configured",
  );
  const disconnected = instances.filter(
    (instance) => instance.status === "close",
  );
  const ready = instances.filter(
    (instance) =>
      instance.status === "open" &&
      !warnings.includes(instance) &&
      !errors.includes(instance),
  );
  const sent = ordered.filter(
    (event) => event.direction === "outbound" || event.fromMe,
  ).length;
  const received = ordered.filter(
    (event) => event.direction === "inbound",
  ).length;
  const webhookEvents = ordered.filter(
    (event) => eventComponent(event) === "Webhooks",
  ).length;
  const errorEvents = ordered.filter((event) =>
    ["ERROR", "CRITICAL"].includes(eventSeverity(event)),
  ).length;
  const latencySamples = ordered
    .filter(
      (event) =>
        eventComponent(event) === "Webhooks" &&
        Number.isFinite(Number(event.durationMs)) &&
        Number(event.durationMs) > 0,
    )
    .map((event) => Number(event.durationMs));
  const averageLatency = latencySamples.length
    ? `${Math.round(latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length)} ms`
    : "No disponible";
  const latestSync = ordered.find((event) =>
    /sync|synchron/i.test(`${event.event} ${event.pipeline?.stage || ""}`),
  );
  const activeAlerts = alerts.filter((alert) =>
    ["new", "acknowledged", "in_progress"].includes(alert.status),
  );
  const criticalAlerts = activeAlerts.filter(
    (alert) => alert.severity === "CRITICAL",
  );
  const activeAutomations = automations.filter((automation) => automation.status === "active");
  const failedAutomations = automations.filter((automation) => automation.status === "error");
  const latestAutomationExecution = automationExecutions[0];
  const activeOperations = operations.filter((operation) => ["running", "retrying"].includes(operation.status));
  const failedOperations = operations.filter((operation) => operation.status === "error");
  const pending = [
    ...errors.map((instance) => ({
      title: `${instance.name}: requiere atención`,
      detail: statusLabel(instance),
      tone: "error" as OperationalTone,
      instance,
    })),
    ...warnings.map((instance) => ({
      title: `${instance.name}: revisar conexión`,
      detail: statusLabel(instance),
      tone: "attention" as OperationalTone,
      instance,
    })),
    ...provisioning
      .filter(
        (instance) =>
          !errors.includes(instance) && !warnings.includes(instance),
      )
      .map((instance) => ({
        title: `${instance.name}: provisioning pendiente`,
        detail: "Completa el onboarding o la conexión.",
        tone: "attention" as OperationalTone,
        instance,
      })),
    ...ordered
      .filter(
        (event) =>
          /smoke|test/i.test(`${event.event} ${event.pipeline?.stage || ""}`) &&
          ["ERROR", "CRITICAL"].includes(eventSeverity(event)),
      )
      .slice(0, 2)
      .map((event) => ({
        title: "Prueba fallida",
        detail: event.instance || "Conexión no disponible",
        tone: "error" as OperationalTone,
        instance: instances.find((item) => item.name === event.instance),
      })),
    ...instances
      .filter(
        (instance) =>
          instance.status === "open" &&
          (!instance.lastSeen ||
            Date.now() - new Date(instance.lastSeen).getTime() > 7 * 86400000),
      )
      .slice(0, 2)
      .map((instance) => ({
        title: `${instance.name}: sin actividad reciente`,
        detail: "No hay señal reciente disponible.",
        tone: "unknown" as OperationalTone,
        instance,
      })),
  ].slice(0, 7);
  const health = [
    [
      "Meta",
      componentHealth(
        "Meta",
        ordered,
        instances.some((item) => item.connectionType === "cloud"),
      ),
      Cloud,
    ],
    [
      "Gateway",
      componentHealth("Gateway", ordered, instances.length > 0),
      Cable,
    ],
    [
      "Evolution",
      componentHealth(
        "Evolution",
        ordered,
        instances.some((item) => item.connectionType !== "cloud"),
      ),
      PlugZap,
    ],
    [
      "Webhooks",
      componentHealth(
        "Webhooks",
        ordered,
        ordered.some((event) => eventComponent(event) === "Webhooks"),
      ),
      Radio,
    ],
    [
      "Mensajería",
      componentHealth(
        "Mensajería",
        ordered,
        ordered.some((event) => eventComponent(event) === "Mensajería"),
      ),
      MessageCircle,
    ],
    [
      "Provisioning",
      provisioning.length
        ? {
            status: "En curso",
            tone: "attention" as OperationalTone,
            incidents: provisioning.length,
            latest: "Pendiente",
          }
        : {
            status: instances.length ? "Sin pendientes" : "No disponible",
            tone: instances.length
              ? ("healthy" as OperationalTone)
              : ("unknown" as OperationalTone),
            incidents: instances.length ? 0 : null,
            latest: "No disponible",
          },
      Workflow,
    ],
  ] as const;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-blue-400">
            Centro de operaciones
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-zinc-100">
            Dashboard Operativo
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Estado, trabajo pendiente y actividad del Gateway en un solo lugar.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onOpenAlerts}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs ${criticalAlerts.length ? "border-red-800 bg-red-950/25 text-red-200" : "border-zinc-700 text-zinc-200"}`}
          >
            <BellRing size={13} />
            {activeAlerts.length} alertas
          </button>
          <button
            onClick={onOpenConnections}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600"
          >
            <RefreshCw size={13} />
            Conexiones
          </button>
          <button
            onClick={onNewConnection}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500"
          >
            <Plus size={13} />
            Nueva conexión
          </button>
        </div>
      </header>

      <DashboardCard>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><ServerCog size={16} className="text-cyan-300" /><h3 className="font-semibold text-zinc-100">Operaciones masivas</h3></div><p className="mt-1 text-xs text-zinc-500">Jobs encolados y ejecutados fuera de la interfaz.</p></div><button onClick={onOpenOperations} className="text-xs text-blue-300 hover:text-blue-200">Abrir Centro de Operaciones</button></div>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3"><div className="rounded-lg border border-blue-900/70 bg-blue-950/20 p-3"><p className="text-xs text-blue-300">Activas</p><p className="mt-1 text-xl font-semibold text-blue-100">{activeOperations.length}</p></div><div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"><p className="text-xs text-zinc-500">En cola</p><p className="mt-1 text-xl font-semibold text-zinc-100">{operations.filter(operation => operation.status === 'pending').length}</p></div><div className="rounded-lg border border-red-900/70 bg-red-950/20 p-3"><p className="text-xs text-red-300">Con error</p><p className="mt-1 text-xl font-semibold text-red-100">{failedOperations.length}</p></div></div>
      </DashboardCard>

      <DashboardCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><Workflow size={16} className="text-violet-300" /><h3 className="font-semibold text-zinc-100">Automatizaciones operativas</h3></div>
            <p className="mt-1 text-xs text-zinc-500">Ejecuciones programadas o por evento, con historial persistente.</p>
          </div>
          <button onClick={onOpenAutomations} className="text-xs text-blue-300 hover:text-blue-200">Abrir Centro de Automatizaciones</button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3">
          <div className="rounded-lg border border-violet-900/70 bg-violet-950/20 p-3"><p className="text-xs text-violet-300">Activas</p><p className="mt-1 text-xl font-semibold text-violet-100">{activeAutomations.length}</p></div>
          <div className="rounded-lg border border-red-900/70 bg-red-950/20 p-3"><p className="text-xs text-red-300">Con error</p><p className="mt-1 text-xl font-semibold text-red-100">{failedAutomations.length}</p></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"><p className="text-xs text-zinc-500">Última ejecución</p><p className="mt-1 truncate text-sm text-zinc-200">{latestAutomationExecution ? `${latestAutomationExecution.automationName} · ${latestAutomationExecution.status}` : 'Sin ejecuciones'}</p></div>
        </div>
      </DashboardCard>

      <DashboardCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <BellRing
                size={16}
                className={
                  criticalAlerts.length ? "text-red-400" : "text-zinc-500"
                }
              />
              <h3 className="font-semibold text-zinc-100">
                Alertas operativas
              </h3>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Incidentes persistentes que requieren atención; no son logs.
            </p>
          </div>
          <button
            onClick={onOpenAlerts}
            className="text-xs text-blue-300 hover:text-blue-200"
          >
            Abrir Centro de Alertas
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3">
          <div className="rounded-lg border border-red-900/70 bg-red-950/20 p-3">
            <p className="text-xs text-red-300">Críticas</p>
            <p className="mt-1 text-xl font-semibold text-red-100">
              {criticalAlerts.length}
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
            <p className="text-xs text-zinc-500">Activas</p>
            <p className="mt-1 text-xl font-semibold text-zinc-100">
              {activeAlerts.length}
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
            <p className="text-xs text-zinc-500">Última alerta</p>
            <p className="mt-1 truncate text-sm text-zinc-200">
              {activeAlerts[0]?.message || "Sin alertas activas"}
            </p>
          </div>
        </div>
      </DashboardCard>

      <DashboardCard>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-zinc-100">Estado general</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Las tarjetas conservan el destino para el futuro listado filtrado.
            </p>
          </div>
          <span className="text-xs text-zinc-600">
            {isLoading ? "Actualizando…" : "Información actual"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <StatusCard
            label="Total conexiones"
            value={instances.length}
            tone="unknown"
            icon={Cable}
            onClick={onOpenConnections}
          />
          <StatusCard
            label="READY"
            value={ready.length}
            tone="healthy"
            icon={CheckCircle2}
            onClick={onOpenConnections}
          />
          <StatusCard
            label="Provisioning"
            value={provisioning.length}
            tone="attention"
            icon={Workflow}
            onClick={onOpenConnections}
          />
          <StatusCard
            label="Warning"
            value={warnings.length}
            tone="attention"
            icon={AlertTriangle}
            onClick={onOpenConnections}
          />
          <StatusCard
            label="Con error"
            value={errors.length}
            tone="error"
            icon={ShieldAlert}
            onClick={onOpenConnections}
          />
          <StatusCard
            label="Desconectadas"
            value={disconnected.length}
            tone="unknown"
            icon={CircleOff}
            onClick={onOpenConnections}
          />
        </div>
      </DashboardCard>

      <DashboardCard>
        <div className="mb-4">
          <h3 className="font-semibold text-zinc-100">Salud del sistema</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Incidencias y última señal según los eventos y estados disponibles.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {health.map(([name, summary, Icon]) => (
            <HealthCard key={name} name={name} {...summary} icon={Icon} />
          ))}
        </div>
      </DashboardCard>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        <DashboardCard className="xl:col-span-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-zinc-100">Trabajo pendiente</h3>
              <p className="mt-1 text-xs text-zinc-500">
                Prioridades que requieren revisión del operador.
              </p>
            </div>
            <AlertTriangle size={17} className="text-amber-400" />
          </div>
          <div className="mt-4 space-y-2">
            {pending.length ? (
              pending.map((item, index) => (
                <PendingWorkCard
                  key={`${item.title}-${index}`}
                  title={item.title}
                  detail={item.detail}
                  tone={item.tone}
                  onClick={
                    item.instance
                      ? () => onOpenWorkspace(item.instance!.name)
                      : undefined
                  }
                />
              ))
            ) : (
              <div className="rounded-lg border border-emerald-900/70 bg-emerald-950/20 p-4 text-sm text-emerald-300">
                No hay trabajo pendiente con la información disponible.
              </div>
            )}
          </div>
        </DashboardCard>
        <DashboardCard className="xl:col-span-3">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-zinc-100">
                Actividad reciente
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Últimos eventos relevantes de todas las conexiones.
              </p>
            </div>
            <button
              onClick={onOpenActivity}
              className="text-xs text-blue-300 hover:text-blue-200"
            >
              Abrir actividad
            </button>
          </div>
          <ActivityCenter events={ordered.slice(0, 8)} compact />
        </DashboardCard>
      </div>

      <DashboardCard>
        <div className="mb-4">
          <h3 className="font-semibold text-zinc-100">KPIs operativos</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Solo métricas observadas por el Gateway.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-7">
          <KpiCard label="Mensajes enviados" value={sent} icon={Send} />
          <KpiCard
            label="Mensajes recibidos"
            value={received}
            icon={MessageCircle}
          />
          <KpiCard
            label="Webhooks procesados"
            value={webhookEvents}
            icon={Radio}
          />
          <KpiCard
            label="Errores registrados"
            value={errorEvents}
            icon={ShieldAlert}
          />
          <KpiCard
            label="Promedio onboarding"
            value="No disponible"
            icon={Workflow}
          />
          <KpiCard
            label="Latencia promedio"
            value={averageLatency}
            icon={Activity}
          />
          <KpiCard
            label="Última sincronización"
            value={
              latestSync ? relative(latestSync.timestamp) : "No disponible"
            }
            icon={RefreshCw}
          />
        </div>
      </DashboardCard>

      <DashboardCard>
        <div className="mb-4">
          <h3 className="font-semibold text-zinc-100">Acciones rápidas</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Accesos a capacidades existentes; no crean automatizaciones.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <QuickAction
            label="Nueva conexión"
            description="Iniciar el flujo existente."
            icon={Plus}
            primary
            onClick={onNewConnection}
          />
          <QuickAction
            label="Ejecutar Smoke Test"
            description="Abrir el Centro de Pruebas."
            icon={TestTube2}
            onClick={onOpenTests}
          />
          <QuickAction
            label="Centro de Actividad"
            description="Revisar timeline y correlación."
            icon={Activity}
            onClick={onOpenActivity}
          />
          <QuickAction
            label="Centro de Pruebas"
            description="Pruebas operativas disponibles."
            icon={TestTube2}
            onClick={onOpenTests}
          />
          <QuickAction
            label="Abrir Workspace"
            description={
              instances[0]
                ? `Ir a ${instances[0].name}.`
                : "Disponible al crear una conexión."
            }
            icon={Cable}
            onClick={() =>
              instances[0]
                ? onOpenWorkspace(instances[0].name)
                : onNewConnection()
            }
          />
        </div>
      </DashboardCard>

      {ordered.length ? (
        <p className="text-center text-[11px] text-zinc-600">
          Último evento global: {formatActivity(ordered[0].timestamp)}
        </p>
      ) : null}
    </div>
  );
}
