import type { EventLedger, SupervisorHealthSink } from "../core/index.js";
import {
  PROTOCOL_VERSION,
  isProtocolCompatible,
  parseProtocolVersion,
  type ArtifactRef,
  type CoordinationTransport,
  type ManagerAdapter,
  type ReviewVerdict,
  type WorkerBackend,
  type WorkerProcessManager,
  type WorkOrderCodec
} from "../protocol/src/index.js";
import type { SandboxBackend } from "../sandbox/index.js";

export const EXTENSION_API_VERSION = "0.1.1" as const;
export { PROTOCOL_VERSION };

export type ProgressState = "active" | "completed" | "blocked" | "failed";

export interface ProgressSurfaceStatus {
  state: "confirmed" | "unconfirmed" | "disabled" | "absent";
  reference_id?: string;
  last_published_at?: string;
}

export interface ProgressSnapshot {
  task_id: string;
  execution_id: string;
  state: ProgressState;
  updated_at: string;
  started_at?: string;
  heartbeat_at?: string;
  phase?: string;
  /** Must be bounded and safe to expose to the configured progress sink. */
  latest_action?: string;
  /** Numeric activity counters only; raw tool inputs do not belong here. */
  activity?: Readonly<Record<string, number>>;
  surface?: ProgressSurfaceStatus;
}

export interface ProgressSink {
  publish(snapshot: ProgressSnapshot): Promise<void>;
}

export interface SteeringActor {
  actor_id: string;
  kind: "human" | "manager" | "operator";
  display_name?: string;
}

export interface SteeringAttachmentRef {
  attachment_id: string;
  name?: string;
  media_type?: string;
}

export interface ExecutionSteeringRequest {
  steering_id: string;
  task_id: string;
  execution_id: string;
  created_at: string;
  actor: SteeringActor;
  instruction: string;
  attachments?: SteeringAttachmentRef[];
}

export interface SteeringPolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface SteeringPolicy {
  authorize(request: ExecutionSteeringRequest): Promise<SteeringPolicyDecision>;
}

export interface WorkerControlReceipt {
  steering_id: string;
  task_id: string;
  execution_id: string;
  accepted_at: string;
}

export interface WorkerControl {
  /** Steering is append-only intervention on the current execution, never a new task/attempt. */
  steer(request: ExecutionSteeringRequest): Promise<WorkerControlReceipt>;
}

export type TaskAnnotationVisibility = "private" | "operator" | "manager" | "audit";

export interface TaskAnnotation {
  annotation_id: string;
  task_id: string;
  execution_id?: string;
  kind: string;
  actor_id: string;
  created_at: string;
  text: string;
  visibility: TaskAnnotationVisibility;
}

export interface TaskAnnotationQuery {
  task_id: string;
  execution_id?: string;
}

export interface TaskAnnotationStore {
  /** Annotation writes MUST NOT cause worker side effects. */
  append(annotation: TaskAnnotation): Promise<void>;
  list(query: TaskAnnotationQuery): Promise<TaskAnnotation[]>;
}

export type ReviewFindingSeverity = "blocking" | "advisory";

export interface ReviewFinding {
  id: string;
  severity: ReviewFindingSeverity;
  type: string;
  requirement: string;
}

export interface RecoveryReviewAssessment {
  verdict: ReviewVerdict | "blocked";
  classification?: string;
  findings: ReviewFinding[];
}

export type RecoveryAction = "retry" | "repair" | "escalate" | "stop";

export interface RecoveryPolicyContext {
  task_id: string;
  execution_id: string;
  attempt: number;
  max_attempts: number;
  prior_actions: RecoveryAction[];
  review: RecoveryReviewAssessment;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
  scope_finding_ids?: string[];
}

export interface RecoveryPolicy {
  evaluate(context: RecoveryPolicyContext): Promise<RecoveryDecision>;
}

export type PublicationKind = "accepted" | "partial";

export interface ResultPublicationRequest {
  publication_id: string;
  task_id: string;
  execution_id: string;
  kind: PublicationKind;
  summary: string;
  artifacts: ArtifactRef[];
  /** Stable hash of the frozen publication payload. */
  payload_fingerprint: string;
}

export interface ResultPublicationReceipt {
  publication_id: string;
  state: "confirmed" | "unknown";
  confirmed_at?: string;
  external_references?: string[];
}

export interface ResultPublisher {
  /** Repeating the same publication id + fingerprint must be idempotent. */
  publish(request: ResultPublicationRequest): Promise<ResultPublicationReceipt>;
  /** Inspect uncertain delivery before considering any retry. */
  inspect(publication_id: string): Promise<ResultPublicationReceipt | undefined>;
}

export type ExtensionPointKind =
  | "manager_adapter"
  | "coordination_transport"
  | "work_order_codec"
  | "sandbox_backend"
  | "worker_backend"
  | "worker_process_manager"
  | "health_sink"
  | "event_ledger"
  | "progress_sink"
  | "worker_control"
  | "steering_policy"
  | "annotation_store"
  | "recovery_policy"
  | "result_publisher"
  | "custom";

export interface ExtensionPoint<T> {
  readonly id: string;
  readonly kind: ExtensionPointKind;
  /** Compile-time brand only. */
  readonly __value?: T;
}

export interface ExtensionProviderDeclaration {
  point: string;
  name: string;
}

export interface ExtensionManifest {
  id: string;
  version: string;
  api_version: string;
  protocol_version: string;
  provides: ExtensionProviderDeclaration[];
}

export interface ExtensionLogSink {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ExtensionContext {
  extension_api_version: typeof EXTENSION_API_VERSION;
  protocol_version: typeof PROTOCOL_VERSION;
  now(): Date;
  log: ExtensionLogSink;
}

export interface ExtensionRegistrar {
  provide<T>(point: ExtensionPoint<T>, name: string, value: T): void;
}

export interface AgentCoordinatorExtension {
  manifest: ExtensionManifest;
  register(registrar: ExtensionRegistrar, context: ExtensionContext): void | Promise<void>;
}

export interface InstalledExtension {
  id: string;
  version: string;
  providers: ExtensionProviderDeclaration[];
}

const ID_PATTERN = /^[a-z][a-z0-9.-]{1,95}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9._-]{0,95}$/;

export function defineExtensionPoint<T>(id: string, kind: ExtensionPointKind = "custom"): ExtensionPoint<T> {
  if (!ID_PATTERN.test(id)) throw new Error("extension point id must be a lowercase namespaced identifier");
  return Object.freeze({ id, kind }) as ExtensionPoint<T>;
}

export const MANAGER_ADAPTER_POINT = defineExtensionPoint<ManagerAdapter>("agent.manager", "manager_adapter");
export const COORDINATION_TRANSPORT_POINT = defineExtensionPoint<CoordinationTransport>(
  "agent.transport",
  "coordination_transport"
);
export const WORK_ORDER_CODEC_POINT = defineExtensionPoint<WorkOrderCodec>("agent.codec", "work_order_codec");
export const SANDBOX_BACKEND_POINT = defineExtensionPoint<SandboxBackend>("agent.sandbox", "sandbox_backend");
export const WORKER_BACKEND_POINT = defineExtensionPoint<WorkerBackend>("agent.worker", "worker_backend");
export const WORKER_PROCESS_MANAGER_POINT = defineExtensionPoint<WorkerProcessManager>(
  "agent.process-manager",
  "worker_process_manager"
);
export const HEALTH_SINK_POINT = defineExtensionPoint<SupervisorHealthSink>("agent.health-sink", "health_sink");
export const EVENT_LEDGER_POINT = defineExtensionPoint<EventLedger>("agent.event-ledger", "event_ledger");
export const PROGRESS_SINK_POINT = defineExtensionPoint<ProgressSink>("agent.progress-sink", "progress_sink");
export const WORKER_CONTROL_POINT = defineExtensionPoint<WorkerControl>("agent.worker-control", "worker_control");
export const STEERING_POLICY_POINT = defineExtensionPoint<SteeringPolicy>("agent.steering-policy", "steering_policy");
export const TASK_ANNOTATION_STORE_POINT = defineExtensionPoint<TaskAnnotationStore>(
  "agent.annotation-store",
  "annotation_store"
);
export const RECOVERY_POLICY_POINT = defineExtensionPoint<RecoveryPolicy>("agent.recovery-policy", "recovery_policy");
export const RESULT_PUBLISHER_POINT = defineExtensionPoint<ResultPublisher>("agent.result-publisher", "result_publisher");

function compatibleApiVersion(peerVersion: string): boolean {
  const peer = parseProtocolVersion(peerVersion);
  const local = parseProtocolVersion(EXTENSION_API_VERSION);
  return local.major === 0
    ? peer.major === local.major && peer.minor === local.minor
    : peer.major === local.major;
}

function providerKey(point: string, name: string): string {
  return `${point}\u0000${name}`;
}

function validateProviderDeclaration(value: ExtensionProviderDeclaration): ExtensionProviderDeclaration {
  if (!ID_PATTERN.test(value.point)) throw new Error(`invalid extension point id: ${value.point}`);
  if (!PROVIDER_PATTERN.test(value.name)) throw new Error(`invalid extension provider name: ${value.name}`);
  return { point: value.point, name: value.name };
}

export function validateExtensionManifest(manifest: ExtensionManifest): ExtensionManifest {
  if (!ID_PATTERN.test(manifest.id)) throw new Error("extension id must be a lowercase namespaced identifier");
  parseProtocolVersion(manifest.version);
  parseProtocolVersion(manifest.api_version);
  parseProtocolVersion(manifest.protocol_version);
  if (!compatibleApiVersion(manifest.api_version)) {
    throw new Error(`incompatible extension API version: local=${EXTENSION_API_VERSION} extension=${manifest.api_version}`);
  }
  if (!isProtocolCompatible(manifest.protocol_version)) {
    throw new Error(`incompatible extension protocol version: local=${PROTOCOL_VERSION} extension=${manifest.protocol_version}`);
  }
  const provides = manifest.provides.map(validateProviderDeclaration);
  const keys = provides.map((item) => providerKey(item.point, item.name));
  if (new Set(keys).size !== keys.length) throw new Error("extension manifest contains duplicate provider declarations");
  return { ...manifest, provides };
}

const NULL_LOGGER: ExtensionLogSink = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
});

export class ExtensionRegistry {
  readonly #providers = new Map<string, unknown>();
  readonly #extensions = new Map<string, InstalledExtension>();
  readonly #now: () => Date;
  readonly #log: ExtensionLogSink;
  #installChain: Promise<void> = Promise.resolve();

  constructor(options: { now?: () => Date; log?: ExtensionLogSink } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? NULL_LOGGER;
  }

  install(extension: AgentCoordinatorExtension): Promise<InstalledExtension> {
    const run = this.#installChain.then(() => this.#installNow(extension));
    this.#installChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async #installNow(extension: AgentCoordinatorExtension): Promise<InstalledExtension> {
    const manifest = validateExtensionManifest(extension.manifest);
    if (this.#extensions.has(manifest.id)) throw new Error(`extension already installed: ${manifest.id}`);
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error("extension context now() must return a valid Date");

    const expected = new Map(manifest.provides.map((item) => [providerKey(item.point, item.name), item]));
    const staged = new Map<string, unknown>();
    const registrar: ExtensionRegistrar = {
      provide: <T>(point: ExtensionPoint<T>, name: string, value: T) => {
        const declaration = validateProviderDeclaration({ point: point.id, name });
        const key = providerKey(declaration.point, declaration.name);
        if (!expected.has(key)) throw new Error(`extension registered undeclared provider: ${point.id}/${name}`);
        if (value === undefined || value === null) throw new Error(`extension provider value is required: ${point.id}/${name}`);
        if (staged.has(key)) throw new Error(`extension registered provider twice: ${point.id}/${name}`);
        if (this.#providers.has(key)) throw new Error(`extension provider already exists: ${point.id}/${name}`);
        staged.set(key, value);
      }
    };
    const context: ExtensionContext = Object.freeze({
      extension_api_version: EXTENSION_API_VERSION,
      protocol_version: PROTOCOL_VERSION,
      now: this.#now,
      log: this.#log
    });

    await extension.register(registrar, context);
    if (staged.size !== expected.size) {
      const missing = [...expected.keys()].filter((key) => !staged.has(key));
      throw new Error(`extension did not register all declared providers: ${missing.join(", ")}`);
    }

    // Commit only after the entire registration callback succeeds and matches
    // its manifest. Failed installs leave the live registry unchanged.
    for (const [key, value] of staged) this.#providers.set(key, value);
    const installed: InstalledExtension = {
      id: manifest.id,
      version: manifest.version,
      providers: manifest.provides.map((item) => ({ ...item }))
    };
    this.#extensions.set(manifest.id, installed);
    return { ...installed, providers: installed.providers.map((item) => ({ ...item })) };
  }

  resolve<T>(point: ExtensionPoint<T>, name: string): T | undefined {
    if (!PROVIDER_PATTERN.test(name)) throw new Error(`invalid extension provider name: ${name}`);
    return this.#providers.get(providerKey(point.id, name)) as T | undefined;
  }

  require<T>(point: ExtensionPoint<T>, name: string): T {
    const value = this.resolve(point, name);
    if (value === undefined) throw new Error(`extension provider not found: ${point.id}/${name}`);
    return value;
  }

  installed(): InstalledExtension[] {
    return [...this.#extensions.values()]
      .map((item) => ({ ...item, providers: item.providers.map((provider) => ({ ...provider })) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
