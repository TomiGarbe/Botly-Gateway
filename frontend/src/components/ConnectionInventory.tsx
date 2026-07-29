import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  ExternalLink,
  FlaskConical,
  HeartPulse,
  LogOut,
  MoreHorizontal,
  RefreshCcw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { KpiCard } from "./DashboardPrimitives";
import type { GatewayConfig } from "../lib/config";
import type {
  Instance,
  OperationType,
  OperationalAlert,
  PipelineEvent,
  Toast,
} from "../types";
import {
  connectionTypeLabel,
  formatActivity,
  isOfficialConnection,
  statusTone,
} from "../lib/connectionUx";

type Signal = "healthy" | "warning" | "error" | "pending";
type FilterValue =
  "all" | "ready" | "provisioning" | "warning" | "error" | "disconnected";
type SortKey =
  | "company"
  | "status"
  | "activity"
  | "health"
  | "created"
  | "messages"
  | "errors"
  | "provisioning";

type InventoryItem = {
  instance: Instance;
  company: string;
  provider: string;
  channel: string;
  method: string;
  events: PipelineEvent[];
  lastActivity?: number;
  lastTest?: PipelineEvent;
  lastError?: PipelineEvent;
  webhook: Signal;
  provisioning: Signal;
  signals: Record<
    "meta" | "gateway" | "evolution" | "webhook" | "messaging" | "provisioning",
    Signal
  >;
  healthScore: number;
  messages: number;
  errors: number;
  state: Exclude<FilterValue, "all">;
  searchText: string;
};

function severity(event: PipelineEvent) {
  if (event.severity) return event.severity;
  return /error|fail|failed/i.test(
    `${event.event} ${event.pipeline?.status || ""}`,
  )
    ? "ERROR"
    : /warning|retry/i.test(`${event.event} ${event.pipeline?.status || ""}`)
      ? "WARNING"
      : "INFO";
}

function component(event: PipelineEvent) {
  if (event.component) return event.component.toLowerCase();
  const value = `${event.event} ${event.pipeline?.stage || ""}`.toLowerCase();
  if (/meta|oauth|phone|discovery|subscription/.test(value)) return "meta";
  if (/evolution/.test(value)) return "evolution";
  if (/webhook|dispatch/.test(value)) return "webhook";
  if (/send|message/.test(value)) return "mensajería";
  return "gateway";
}

function signalFrom(events: PipelineEvent[]): Signal {
  const latest = events[0];
  if (!latest) return "pending";
  const value = severity(latest);
  return value === "ERROR" || value === "CRITICAL"
    ? "error"
    : value === "WARNING"
      ? "warning"
      : "healthy";
}

function stateOf(instance: Instance): Exclude<FilterValue, "all"> {
  if (
    instance.lifecycleState === "failed" ||
    instance.lifecycleState === "token_expired" ||
    instance.lifecycleState === "webhook_invalid" ||
    instance.health === "unhealthy"
  )
    return "error";
  if (instance.status === "close") return "disconnected";
  if (
    instance.status === "connecting" ||
    instance.lifecycleState === "provisioning" ||
    instance.lifecycleState === "configured"
  )
    return "provisioning";
  if (
    instance.lifecycleState === "warning" ||
    instance.lifecycleState === "needs_attention" ||
    instance.health === "degraded"
  )
    return "warning";
  return "ready";
}

function timestamp(value?: string | number | null) {
  if (!value) return 0;
  const date = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(date) ? date : 0;
}

function relative(value?: number) {
  if (!value) return "No disponible";
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
  if (minutes < 1) return "Ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  if (minutes < 1440) return `hace ${Math.floor(minutes / 60)} h`;
  return `hace ${Math.floor(minutes / 1440)} d`;
}

function signalLabel(value: Signal) {
  return value === "healthy"
    ? "Correcto"
    : value === "warning"
      ? "Warning"
      : value === "error"
        ? "Error"
        : "Pendiente";
}
function signalTone(value: Signal) {
  return value === "healthy"
    ? "bg-emerald-400"
    : value === "warning"
      ? "bg-amber-400"
      : value === "error"
        ? "bg-red-400"
        : "bg-zinc-600";
}
function statusToneFor(value: Exclude<FilterValue, "all">) {
  return value === "ready"
    ? "border-emerald-900 bg-emerald-950/30 text-emerald-300"
    : value === "error"
      ? "border-red-900 bg-red-950/30 text-red-300"
      : value === "warning" || value === "provisioning"
        ? "border-amber-900 bg-amber-950/30 text-amber-300"
        : "border-zinc-700 bg-zinc-950/50 text-zinc-400";
}
function statusText(value: Exclude<FilterValue, "all">) {
  return value === "ready"
    ? "READY"
    : value === "provisioning"
      ? "Provisioning"
      : value === "warning"
        ? "Warning"
        : value === "error"
          ? "Error"
          : "Desconectada";
}

function makeItem(
  instance: Instance,
  instanceEvents: PipelineEvent[],
): InventoryItem {
  const events = [...instanceEvents].sort(
    (a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0),
  );
  const signals = {
    meta: isOfficialConnection(instance)
      ? signalFrom(events.filter((event) => component(event) === "meta"))
      : ("pending" as Signal),
    gateway:
      instance.status === "open"
        ? ("healthy" as Signal)
        : instance.status === "connecting"
          ? ("pending" as Signal)
          : ("error" as Signal),
    evolution: signalFrom(
      events.filter((event) => component(event) === "evolution"),
    ),
    webhook: signalFrom(
      events.filter((event) => component(event) === "webhook"),
    ),
    messaging: signalFrom(
      events.filter((event) => component(event) === "mensajería"),
    ),
    provisioning:
      stateOf(instance) === "ready"
        ? ("healthy" as Signal)
        : stateOf(instance) === "error"
          ? ("error" as Signal)
          : stateOf(instance) === "warning"
            ? ("warning" as Signal)
            : ("pending" as Signal),
  };
  const lastActivity =
    Number(events[0]?.timestamp || timestamp(instance.lastSeen)) || undefined;
  const lastTest = events.find((event) =>
    /smoke|test/i.test(`${event.event} ${event.pipeline?.stage || ""}`),
  );
  const lastError = events.find((event) =>
    ["ERROR", "CRITICAL"].includes(severity(event)),
  );
  const state = stateOf(instance);
  let healthScore =
    instance.status === "open" ? 40 : instance.status === "connecting" ? 20 : 0;
  if (signals.provisioning === "healthy") healthScore += 20;
  if (signals.webhook === "healthy") healthScore += 15;
  if (
    lastTest &&
    !["ERROR", "CRITICAL", "WARNING"].includes(severity(lastTest))
  )
    healthScore += 15;
  if (lastActivity && Date.now() - lastActivity < 7 * 86400000)
    healthScore += 10;
  if (lastError && Date.now() - Number(lastError.timestamp) < 7 * 86400000)
    healthScore -= 25;
  if (state === "warning") healthScore -= 10;
  const ids = events
    .flatMap((event) => [
      event.pipeline?.messageId,
      event.pipeline?.conversationId,
      event.details?.wabaId,
      event.details?.phoneNumberId,
    ])
    .filter(Boolean)
    .join(" ");
  const company = instance.profileName || "No disponible";
  const provider = isOfficialConnection(instance) ? "Meta" : "Evolution";
  const channel =
    instance.channelDisplayName || instance.channelId || "WhatsApp";
  const method = instance.methodDisplayName || connectionTypeLabel(instance);
  return {
    instance,
    company,
    provider,
    channel,
    method,
    events,
    lastActivity,
    lastTest,
    lastError,
    webhook: signals.webhook,
    provisioning: signals.provisioning,
    signals,
    healthScore: Math.max(0, Math.min(100, healthScore)),
    messages: events.filter(
      (event) =>
        event.direction === "inbound" ||
        event.direction === "outbound" ||
        event.fromMe,
    ).length,
    errors: events.filter((event) =>
      ["ERROR", "CRITICAL"].includes(severity(event)),
    ).length,
    state,
    searchText:
      `${company} ${instance.name} ${instance.phone || ""} ${instance.id} ${channel} ${provider} ${method} ${ids}`.toLowerCase(),
  };
}

export default function ConnectionInventory({
  config,
  instances,
  events,
  alerts,
  onOpenWorkspace,
  onOpenTests,
  onReconnect,
  onLogout,
  onDelete,
  onOpenActivity,
  onOpenDiagnostics,
  onBulkOperation,
  onToast,
}: {
  config: GatewayConfig;
  instances: Instance[];
  events: PipelineEvent[];
  alerts: OperationalAlert[];
  onOpenWorkspace: (name: string) => void;
  onOpenTests: (name: string) => void;
  onReconnect: (name: string) => void;
  onLogout: (name: string) => void;
  onDelete: (name: string) => void;
  onOpenActivity: (name: string) => void;
  onOpenDiagnostics: (name: string) => void;
  onBulkOperation: (type: OperationType, targets: string[]) => void;
  onToast: (message: string, type?: Toast["type"]) => void;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<FilterValue>("all");
  const [provider, setProvider] = useState("all");
  const [channel, setChannel] = useState("all");
  const [method, setMethod] = useState("all");
  const [company, setCompany] = useState("all");
  const [date, setDate] = useState("all");
  const [provisioning, setProvisioning] = useState("all");
  const [health, setHealth] = useState("all");
  const [activity, setActivity] = useState("all");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [sort, setSort] = useState<SortKey>("activity");
  const [compact, setCompact] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const items = useMemo(() => {
    const eventsByInstance = new Map<string, PipelineEvent[]>();
    events.forEach((event) => {
      if (!event.instance) return;
      const current = eventsByInstance.get(event.instance) || [];
      current.push(event);
      eventsByInstance.set(event.instance, current);
    });
    return instances.map((instance) =>
      makeItem(instance, eventsByInstance.get(instance.name) || []),
    );
  }, [instances, events]);
  const alertCounts = useMemo(() => {
    const counts = new Map<string, number>();
    alerts
      .filter((alert) =>
        ["new", "acknowledged", "in_progress"].includes(alert.status),
      )
      .forEach((alert) => {
        if (alert.connection)
          counts.set(alert.connection, (counts.get(alert.connection) || 0) + 1);
      });
    return counts;
  }, [alerts]);
  const choices = (getter: (item: InventoryItem) => string) =>
    [...new Set(items.map(getter))].sort();
  const filtered = useMemo(() => {
    const now = Date.now();
    const createdMinimum =
      date === "24h"
        ? now - 86400000
        : date === "7d"
          ? now - 7 * 86400000
          : date === "30d"
            ? now - 30 * 86400000
            : 0;
    return items
      .filter((item) => {
        const created = timestamp(item.instance.createdAt);
        const activityAge = item.lastActivity
          ? now - item.lastActivity
          : Infinity;
        const healthBand =
          item.healthScore >= 80
            ? "good"
            : item.healthScore >= 50
              ? "attention"
              : "poor";
        return (
          (!query.trim() ||
            item.searchText.includes(query.trim().toLowerCase())) &&
          (state === "all" || item.state === state) &&
          (provider === "all" || item.provider === provider) &&
          (channel === "all" || item.channel === channel) &&
          (method === "all" || item.method === method) &&
          (company === "all" || item.company === company) &&
          (!createdMinimum || created >= createdMinimum) &&
          (provisioning === "all" || item.provisioning === provisioning) &&
          (health === "all" || healthBand === health) &&
          (activity === "all" ||
            (activity === "recent" && activityAge < 86400000) ||
            (activity === "stale" &&
              activityAge >= 7 * 86400000 &&
              activityAge < Infinity) ||
            (activity === "none" && !item.lastActivity)) &&
          (!onlyErrors || item.errors > 0 || item.state === "error") &&
          (!onlyAlerts || Boolean(alertCounts.get(item.instance.name)))
        );
      })
      .sort((a, b) => {
        if (sort === "company") return a.company.localeCompare(b.company);
        if (sort === "status") return a.state.localeCompare(b.state);
        if (sort === "health") return b.healthScore - a.healthScore;
        if (sort === "created")
          return (
            timestamp(b.instance.createdAt) - timestamp(a.instance.createdAt)
          );
        if (sort === "messages") return b.messages - a.messages;
        if (sort === "errors") return b.errors - a.errors;
        if (sort === "provisioning")
          return a.provisioning.localeCompare(b.provisioning);
        return (b.lastActivity || 0) - (a.lastActivity || 0);
      });
  }, [
    items,
    query,
    state,
    provider,
    channel,
    method,
    company,
    date,
    provisioning,
    health,
    activity,
    onlyErrors,
    onlyAlerts,
    alertCounts,
    sort,
  ]);
  const counts = {
    ready: items.filter((item) => item.state === "ready").length,
    provisioning: items.filter((item) => item.state === "provisioning").length,
    warning: items.filter((item) => item.state === "warning").length,
    error: items.filter((item) => item.state === "error").length,
    stale: items.filter(
      (item) =>
        !item.lastActivity || Date.now() - item.lastActivity >= 7 * 86400000,
    ).length,
    average: items.length
      ? Math.round(
          items.reduce((sum, item) => sum + item.healthScore, 0) / items.length,
        )
      : 0,
  };
  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  const toggleAll = () =>
    setSelected((current) =>
      current.size === filtered.length && filtered.length
        ? new Set()
        : new Set(filtered.map((item) => item.instance.name)),
    );
  const copyCallback = async (item: InventoryItem) => {
    const base = (config.publicBaseUrl || config.url).replace(/\/+$/, "");
    const callback = `${base}/webhooks/${isOfficialConnection(item.instance) ? "meta" : "evolution"}`;
    try {
      await navigator.clipboard.writeText(callback);
      onToast("Callback copiado", "success");
    } catch {
      onToast("No se pudo copiar el callback", "error");
    }
  };
  const reset = () => {
    setQuery("");
    setState("all");
    setProvider("all");
    setChannel("all");
    setMethod("all");
    setCompany("all");
    setDate("all");
    setProvisioning("all");
    setHealth("all");
    setActivity("all");
    setOnlyErrors(false);
    setOnlyAlerts(false);
  };
  const activeFilters =
    [
      state,
      provider,
      channel,
      method,
      company,
      date,
      provisioning,
      health,
      activity,
    ].filter((value) => value !== "all").length +
    (onlyErrors ? 1 : 0) +
    (onlyAlerts ? 1 : 0);
  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-blue-400">
            Infraestructura
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-zinc-100">
            Inventario de Conexiones
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Estado operativo y acciones por conexión, preparado para una flota
            de producción.
          </p>
        </div>
        <button
          onClick={() => setCompact((value) => !value)}
          className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600"
        >
          Vista {compact ? "completa" : "compacta"}
        </button>
      </header>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-7">
        <KpiCard
          label="Total conexiones"
          value={items.length}
          icon={HeartPulse}
        />
        <KpiCard label="READY" value={counts.ready} icon={CheckCircle2} />
        <KpiCard
          label="Provisioning"
          value={counts.provisioning}
          icon={Settings2}
        />
        <KpiCard label="Warning" value={counts.warning} icon={AlertTriangle} />
        <KpiCard label="Errores" value={counts.error} icon={CircleAlert} />
        <KpiCard label="Sin actividad" value={counts.stale} icon={Activity} />
        <KpiCard
          label="Health promedio"
          value={`${counts.average}/100`}
          icon={HeartPulse}
        />
      </div>
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-56 flex-1">
            <Search
              size={14}
              className="absolute left-3 top-2.5 text-zinc-600"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar empresa, nombre, número, ID, WABA o Phone ID"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-2 pl-9 pr-3 text-xs text-zinc-200"
            />
          </label>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300"
          >
            <option value="activity">Ordenar: última actividad</option>
            <option value="company">Empresa</option>
            <option value="status">Estado</option>
            <option value="health">Health Score</option>
            <option value="created">Fecha</option>
            <option value="messages">Mensajes</option>
            <option value="errors">Errores</option>
            <option value="provisioning">Provisioning</option>
          </select>
          <button
            onClick={reset}
            disabled={!activeFilters && !query}
            className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400 hover:border-zinc-700 disabled:opacity-40"
          >
            <X size={13} className="inline" /> Limpiar
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            value={state}
            onChange={(event) => setState(event.target.value as FilterValue)}
            className="filter"
          >
            <option value="all">Estado: todos</option>
            <option value="ready">READY</option>
            <option value="provisioning">Provisioning</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
            <option value="disconnected">Desconectada</option>
          </select>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className="filter"
          >
            <option value="all">Proveedor: todos</option>
            {choices((item) => item.provider).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="filter"
          >
            <option value="all">Canal: todos</option>
            {choices((item) => item.channel).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            className="filter"
          >
            <option value="all">Método: todos</option>
            {choices((item) => item.method).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            className="filter"
          >
            <option value="all">Empresa: todas</option>
            {choices((item) => item.company).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="filter"
          >
            <option value="all">Fecha: todas</option>
            <option value="24h">Últimas 24 h</option>
            <option value="7d">Últimos 7 días</option>
            <option value="30d">Últimos 30 días</option>
          </select>
          <select
            value={provisioning}
            onChange={(event) => setProvisioning(event.target.value)}
            className="filter"
          >
            <option value="all">Provisioning: todos</option>
            <option value="healthy">Correcto</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
            <option value="pending">Pendiente</option>
          </select>
          <select
            value={health}
            onChange={(event) => setHealth(event.target.value)}
            className="filter"
          >
            <option value="all">Health: todos</option>
            <option value="good">80–100</option>
            <option value="attention">50–79</option>
            <option value="poor">0–49</option>
          </select>
          <select
            value={activity}
            onChange={(event) => setActivity(event.target.value)}
            className="filter"
          >
            <option value="all">Actividad: todas</option>
            <option value="recent">Reciente</option>
            <option value="stale">Sin actividad +7 días</option>
            <option value="none">Sin registro</option>
          </select>
          <button
            onClick={() => setOnlyErrors((value) => !value)}
            className={`rounded-md border px-2 py-1.5 text-xs ${onlyErrors ? "border-red-800 bg-red-950/30 text-red-200" : "border-zinc-800 text-zinc-400"}`}
          >
            Errores
          </button>
        </div>
      </section>
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => setOnlyAlerts((value) => !value)}
          className={`rounded-lg border px-3 py-2 text-xs ${onlyAlerts ? "border-red-800 bg-red-950/30 text-red-200" : "border-zinc-800 text-zinc-400"}`}
        >
          Con alertas activas (
          {[...alertCounts.values()].reduce((sum, count) => sum + count, 0)})
        </button>
        <p className="text-xs text-zinc-600">
          Las alertas se calculan y persisten en el Gateway.
        </p>
      </div>
      {selected.size ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-900/70 bg-blue-950/20 px-4 py-3">
          <p className="text-sm text-blue-200">
            {selected.size} conexión{selected.size === 1 ? "" : "es"}{" "}
            seleccionada{selected.size === 1 ? "" : "s"}{" "}
            <span className="text-xs text-blue-300/70">
              · Operaciones masivas preparadas para una fase futura.
            </span>
          </p>
          <div className="flex gap-2">
            <button onClick={() => onBulkOperation("smoke_test", [...selected])} className="rounded border border-blue-800 px-2 py-1.5 text-xs text-blue-200 hover:bg-blue-950/30">
              Smoke Test
            </button>
            <button onClick={() => onBulkOperation("reconnect", [...selected])} className="rounded border border-blue-800 px-2 py-1.5 text-xs text-blue-200 hover:bg-blue-950/30">
              Reconectar
            </button>
            <button onClick={() => onBulkOperation("export", [...selected])} className="rounded border border-blue-800 px-2 py-1.5 text-xs text-blue-200 hover:bg-blue-950/30">
              Exportar
            </button>
          </div>
        </div>
      ) : null}
      <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <p className="text-sm text-zinc-300">
            <span className="font-medium text-zinc-100">{filtered.length}</span>{" "}
            de {items.length} conexiones
          </p>
          <p className="text-xs text-zinc-600">
            Selección múltiple preparada · virtualización futura
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1240px] text-left text-xs">
            <thead className="bg-zinc-950/50 text-zinc-500">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={
                      filtered.length > 0 && selected.size === filtered.length
                    }
                    onChange={toggleAll}
                    aria-label="Seleccionar conexiones"
                  />
                </th>
                <th className="px-3 py-3 font-medium">Empresa / conexión</th>
                <th className="px-3 py-3 font-medium">Canal / proveedor</th>
                <th className="px-3 py-3 font-medium">Estado</th>
                <th className="px-3 py-3 font-medium">Señales</th>
                <th className="px-3 py-3 font-medium">Health</th>
                <th className="px-3 py-3 font-medium">Última actividad</th>
                {!compact ? (
                  <>
                    <th className="px-3 py-3 font-medium">Prueba / error</th>
                    <th className="px-3 py-3 font-medium">Creada</th>
                  </>
                ) : null}
                <th className="w-24 px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const currentActions = actionsFor === item.instance.name;
                const tone = statusTone(item.instance);
                return (
                  <tr
                    key={item.instance.id}
                    className="border-t border-zinc-800 text-zinc-300 hover:bg-zinc-800/30"
                  >
                    <td className="px-4 py-3 align-top">
                      <input
                        type="checkbox"
                        checked={selected.has(item.instance.name)}
                        onChange={() => toggle(item.instance.name)}
                        aria-label={`Seleccionar ${item.instance.name}`}
                      />
                    </td>
                    <td className="px-3 py-3 align-top">
                      <p className="font-medium text-zinc-100">
                        {item.company}
                      </p>
                      <button
                        onClick={() => onOpenWorkspace(item.instance.name)}
                        className="mt-1 text-left text-xs text-blue-300 hover:text-blue-200"
                      >
                        {item.instance.name}
                      </button>
                      {alertCounts.get(item.instance.name) ? (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-900/70 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                          <AlertTriangle size={11} />
                          {alertCounts.get(item.instance.name)} alerta{alertCounts.get(item.instance.name) === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      <p className="mt-1 text-zinc-600">
                        {item.instance.phone || "Número no disponible"}
                      </p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <p>{item.channel}</p>
                      <p className="mt-1 text-zinc-500">
                        {item.provider} · {item.method}
                      </p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${statusToneFor(item.state)}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${tone.dot}`}
                        />
                        {statusText(item.state)}
                      </span>
                      <p className="mt-2 text-zinc-500">
                        Provisioning:{" "}
                        <span className="text-zinc-300">
                          {signalLabel(item.provisioning)}
                        </span>
                      </p>
                      <p className="mt-1 text-zinc-500">
                        Webhook:{" "}
                        <span className="text-zinc-300">
                          {signalLabel(item.webhook)}
                        </span>
                      </p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex gap-1.5">
                        {(
                          Object.entries(item.signals) as Array<
                            [string, Signal]
                          >
                        ).map(([name, value]) => (
                          <span
                            key={name}
                            title={`${name}: ${signalLabel(value)}`}
                            className={`h-2.5 w-2.5 rounded-full ${signalTone(value)}`}
                          />
                        ))}
                      </div>
                      <p className="mt-2 text-zinc-600">
                        Meta · GW · Evo · WH · Msg · Prov
                      </p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <p
                        className={`font-semibold ${item.healthScore >= 80 ? "text-emerald-300" : item.healthScore >= 50 ? "text-amber-300" : "text-red-300"}`}
                      >
                        {item.healthScore}/100
                      </p>
                      <div className="mt-2 h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className={`h-full ${item.healthScore >= 80 ? "bg-emerald-400" : item.healthScore >= 50 ? "bg-amber-400" : "bg-red-400"}`}
                          style={{ width: `${item.healthScore}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <p>{relative(item.lastActivity)}</p>
                      {item.lastActivity ? (
                        <p className="mt-1 text-zinc-600">
                          {formatActivity(item.lastActivity)}
                        </p>
                      ) : null}
                    </td>
                    {!compact ? (
                      <>
                        <td className="px-3 py-3 align-top">
                          <p>
                            {item.lastTest
                              ? `${relative(Number(item.lastTest.timestamp))} · ${severity(item.lastTest)}`
                              : "Prueba no disponible"}
                          </p>
                          <p
                            className={`mt-1 max-w-44 truncate ${item.lastError ? "text-red-300" : "text-zinc-600"}`}
                            title={
                              item.lastError?.error?.message ||
                              String(item.lastError?.details?.error || "")
                            }
                          >
                            {item.lastError
                              ? item.lastError.error?.message ||
                                String(
                                  item.lastError.details?.error ||
                                    "Error registrado",
                                )
                              : "Sin error registrado"}
                          </p>
                        </td>
                        <td className="px-3 py-3 align-top text-zinc-500">
                          {formatActivity(item.instance.createdAt)}
                        </td>
                      </>
                    ) : null}
                    <td className="relative px-3 py-3 align-top">
                      <button
                        onClick={() =>
                          setActionsFor(
                            currentActions ? null : item.instance.name,
                          )
                        }
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                        aria-label={`Acciones para ${item.instance.name}`}
                      >
                        <MoreHorizontal size={16} />
                      </button>
                      {currentActions ? (
                        <div className="absolute right-3 top-10 z-20 w-48 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
                          <button
                            onClick={() => onOpenWorkspace(item.instance.name)}
                            className="action"
                          >
                            Abrir Workspace
                          </button>
                          <button
                            onClick={() => onOpenTests(item.instance.name)}
                            className="action"
                          >
                            <FlaskConical size={13} />
                            Ejecutar Smoke Test
                          </button>
                          <button
                            onClick={() => onReconnect(item.instance.name)}
                            className="action"
                          >
                            <RefreshCcw size={13} />
                            Reconectar
                          </button>
                          {item.instance.status === "open" &&
                          !isOfficialConnection(item.instance) ? (
                            <button
                              onClick={() => onLogout(item.instance.name)}
                              className="action"
                            >
                              <LogOut size={13} />
                              Desconectar
                            </button>
                          ) : null}
                          <button
                            onClick={() =>
                              window.open(
                                "https://business.facebook.com/latest/whatsapp_manager",
                                "_blank",
                                "noopener,noreferrer",
                              )
                            }
                            className="action"
                          >
                            <ExternalLink size={13} />
                            Abrir Meta
                          </button>
                          <button
                            onClick={() => void copyCallback(item)}
                            className="action"
                          >
                            <Clipboard size={13} />
                            Copiar callback
                          </button>
                          <button
                            onClick={() => onOpenActivity(item.instance.name)}
                            className="action"
                          >
                            <Activity size={13} />
                            Ver actividad
                          </button>
                          <button
                            onClick={() =>
                              onOpenDiagnostics(item.instance.name)
                            }
                            className="action"
                          >
                            <Settings2 size={13} />
                            Ver diagnóstico
                          </button>
                          <button
                            onClick={() => onDelete(item.instance.name)}
                            className="action text-red-300"
                          >
                            <Trash2 size={13} />
                            Eliminar
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={compact ? 8 : 10}
                    className="px-4 py-12 text-center text-sm text-zinc-500"
                  >
                    No hay conexiones que coincidan con los filtros.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
