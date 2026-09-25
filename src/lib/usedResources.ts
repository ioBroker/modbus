/*
 * Reports the exclusive resources an instance occupies to the per-host registry js-controller 8
 * keeps (`system.host.<hostname>.usedResources.<type>`).
 *
 * The registry answers "who already holds this serial port / this TCP port", so a user configuring a
 * second instance sees what is taken instead of running into EADDRINUSE or "Resource temporarily
 * unavailable". js-controller derives an entry for an adapter that declares nothing, but only from
 * `native.port` - which is no help here: a Modbus adapter keeps its settings in `native.params`, and
 * a master in TCP mode does not occupy a local port at all, it dials a foreign one.
 *
 * So what is reported is what was really opened, once it is open:
 * - master over serial, slave over serial → the serial port
 * - slave over TCP, and the proxy endpoint → the port it listens on
 * - master over TCP/UDP/SSL → nothing, the endpoint belongs to the other side
 *
 * The adapter using this library has to declare that it does this itself, with
 * `"declareUsedResources": true` in the `common` part of its io-package.json. Without it the host
 * refuses the registrations, and this module stays silent.
 *
 * Nothing here is required for Modbus to work - every failure is logged and swallowed.
 */

/** Feature a js-controller announces once it maintains the registry. Since js-controller 8. */
const USED_RESOURCES_FEATURE = 'CONTROLLER_USED_RESOURCES';

/**
 * Addresses that stand for every interface. A socket bound to one of them occupies the port in both
 * address families (a wildcard listener is dual-stack), so the family must not be reported for it.
 */
const WILDCARD_ADDRESSES = ['0.0.0.0', '::', '*', ''];

/** A serial port occupied by an instance */
export interface UsedSerialPort {
    /** Path or name of the port as it is opened, e.g. `/dev/ttyUSB0`, a `/dev/serial/by-id/...` link or `COM3` */
    port: string;
    /** Baud rate the port is opened with */
    baudRate?: number;
}

/** A TCP port occupied by an instance */
export interface UsedTcpPort {
    /** TCP port number */
    port: number;
    /** Address the socket is bound to, `0.0.0.0` or `::` for every interface */
    bind?: string;
    /** Address family, only reported for a concrete bind address */
    family?: 4 | 6;
}

/** The resource types this library can occupy, with the payload the registry wants for each */
interface UsedResourceDataMap {
    serialPort: UsedSerialPort;
    tcpPort: UsedTcpPort;
}

/** Kind of an exclusive resource */
export type UsedResourceType = keyof UsedResourceDataMap;

/** One entry of the registry, as `checkUsedResource` returns it */
export interface RegisteredResource<T extends UsedResourceType = UsedResourceType> {
    /** Instance that occupies the resource, e.g. `modbus.1` */
    instance: string;
    /** Whether that instance is running and really holds it now */
    isBlocked: boolean;
    /** What it holds */
    data: UsedResourceDataMap[T];
}

/**
 * The part of the adapter API this module uses, all of it optional: the methods exist since
 * js-controller 8, and `supportsFeature()` is typed against a union of known features that does not
 * contain {@link USED_RESOURCES_FEATURE} in older types - this library builds against those.
 */
interface UsedResourcesApi {
    registerUsedResource?: <T extends UsedResourceType>(type: T, data: UsedResourceDataMap[T]) => Promise<void>;
    freeUsedResource?: <T extends UsedResourceType>(type: T, data?: Partial<UsedResourceDataMap[T]>) => Promise<void>;
    checkUsedResource?: <T extends UsedResourceType>(
        type: T,
        data?: Partial<UsedResourceDataMap[T]>,
    ) => Promise<RegisteredResource<T>[]>;
    supportsFeature?: (feature: string) => boolean;
}

/** `common` of the instance object, with the flag deciding who fills the registry for it */
type UsedResourcesCommon = ioBroker.AdapterCommon & {
    /**
     * `true`: the adapter declares its resources itself, which is what this module does.
     * Not set: js-controller derives them from `native.port`. `false`: the instance has no entries.
     */
    declareUsedResources?: boolean;
};

/**
 * Log without ever throwing.
 *
 * A free arrives while the adapter is being torn down, at which point its logger can already be
 * gone. A throwing log statement in one of these calls would end up as a rejection nobody listens
 * to, which terminates the adapter - a lot of damage for a line that only says a port was reported.
 *
 * @param adapter the ioBroker adapter
 * @param level the log level to write with
 * @param message what to write
 */
function log(adapter: ioBroker.Adapter, level: 'debug' | 'warn', message: string): void {
    try {
        adapter.log[level](message);
    } catch {
        // There is nothing left that could report this
    }
}

/** The fields of a resource payload that can appear in a log line */
interface DescribableResource {
    port?: string | number;
    baudRate?: number;
    bind?: string;
}

/**
 * How a resource is named in the log.
 *
 * @param type the kind of resource
 * @param data what is occupied
 */
function describe(type: UsedResourceType, data: DescribableResource): string {
    if (type === 'serialPort') {
        return `${data.port}${data.baudRate ? ` @ ${data.baudRate}` : ''}`;
    }
    if (!data.bind) {
        return `${data.port}`;
    }
    return data.bind.includes(':') ? `[${data.bind}]:${data.port}` : `${data.bind}:${data.port}`;
}

/**
 * Whether this instance may report its used resources to the host.
 *
 * All three reasons against it are perfectly normal - an older controller, an adapter built against
 * an older `@iobroker/adapter-core`, an adapter that does not declare its resources - so none is
 * worth more than a debug line. A host that knows no `registerUsedResource` does not refuse the
 * call, it simply never answers it, so every single one would first sit out the five second timeout
 * of the adapter API. That is why the feature is asked for before anything is sent.
 *
 * @param adapter the ioBroker adapter
 */
function canReportUsedResources(adapter: ioBroker.Adapter): boolean {
    const api = adapter as unknown as UsedResourcesApi;

    if (typeof api.registerUsedResource !== 'function' || typeof api.freeUsedResource !== 'function') {
        // Told apart from the feature below only to name the half that is missing: this one can be
        // fixed by the adapter, by updating its @iobroker/adapter-core
        log(adapter, 'debug', 'Used resources are not reported: @iobroker/adapter-core is older than js-controller 8');
        return false;
    }

    if (typeof api.supportsFeature !== 'function' || !api.supportsFeature(USED_RESOURCES_FEATURE)) {
        log(
            adapter,
            'debug',
            `Used resources are not reported: js-controller keeps no registry of used resources (feature "${USED_RESOURCES_FEATURE}")`,
        );
        return false;
    }

    if ((adapter.common as UsedResourcesCommon | undefined)?.declareUsedResources !== true) {
        // The host would refuse the registration in this case, and asking it first only to be told
        // so costs a message round-trip
        log(
            adapter,
            'debug',
            'Used resources are not reported: set "declareUsedResources" to true in the "common" part of io-package.json',
        );
        return false;
    }

    return true;
}

/**
 * Report a resource as occupied by this instance.
 *
 * Registering is additive, one call per resource - a proxy that serves TCP while it talks to a
 * serial device reports both. The host drops what this instance registered before whenever it
 * starts, so a stale registration of a previous configuration cannot survive a restart.
 *
 * @param adapter the ioBroker adapter
 * @param type the kind of resource
 * @param data what is occupied
 * @returns whether the host accepted the registration
 */
export async function registerUsedResource<T extends UsedResourceType>(
    adapter: ioBroker.Adapter,
    type: T,
    data: UsedResourceDataMap[T],
): Promise<boolean> {
    if (!canReportUsedResources(adapter)) {
        return false;
    }

    try {
        await (adapter as unknown as UsedResourcesApi).registerUsedResource!(type, data);
        log(adapter, 'debug', `Registered ${type} ${describe(type, data)} as used by this instance`);
        return true;
    } catch (e: any) {
        log(adapter, 'warn', `Could not register ${type} ${describe(type, data)} as used: ${e.message}`);
        return false;
    }
}

/**
 * Take previously reported resources back.
 *
 * `data` is a filter and not the exact payload: every field it names has to match, fields it leaves
 * out are ignored - so omitting it frees every resource of that type. Freeing on shutdown is not
 * needed, the host marks the entries of a stopped instance as no longer held by itself.
 *
 * @param adapter the ioBroker adapter
 * @param type the kind of resource
 * @param data the fields identifying what to free; everything of this type without it
 * @returns whether the host accepted the request
 */
export async function freeUsedResource<T extends UsedResourceType>(
    adapter: ioBroker.Adapter,
    type: T,
    data?: Partial<UsedResourceDataMap[T]>,
): Promise<boolean> {
    if (!canReportUsedResources(adapter)) {
        return false;
    }

    try {
        await (adapter as unknown as UsedResourcesApi).freeUsedResource!(type, data);
        log(adapter, 'debug', `Freed ${type} ${data ? describe(type, data) : 'registrations'} of this instance`);
        return true;
    } catch (e: any) {
        log(adapter, 'warn', `Could not free ${type} ${data ? describe(type, data) : 'registrations'}: ${e.message}`);
        return false;
    }
}

/**
 * Say in the log which other instance holds a resource this adapter is about to open.
 *
 * Asked before opening it: afterwards the operating system has already decided the conflict, and all
 * this could do is improve the wording of the error. The answer is a hint and not a permission - the
 * registry knows what adapters declare, so an empty result does not promise the resource is free,
 * and a program outside ioBroker holding it is not in the registry at all.
 *
 * @param adapter the ioBroker adapter
 * @param type the kind of resource
 * @param data what is about to be opened
 * @param what which part of the adapter wants it, for the log line
 */
export async function reportResourceConflict<T extends UsedResourceType>(
    adapter: ioBroker.Adapter,
    type: T,
    data: Partial<UsedResourceDataMap[T]>,
    what: string,
): Promise<RegisteredResource<T>[]> {
    if (!canReportUsedResources(adapter)) {
        return [];
    }

    let holders: RegisteredResource<T>[];
    try {
        holders = (await (adapter as unknown as UsedResourcesApi).checkUsedResource!(type, data)) || [];
    } catch (e: any) {
        log(adapter, 'debug', `Could not ask which instance uses ${type} ${describe(type, data)}: ${e.message}`);
        return [];
    }

    if (holders.length) {
        const running = holders.filter(holder => holder.isBlocked);
        log(
            adapter,
            'warn',
            `${type === 'serialPort' ? 'Serial port' : 'TCP port'} ${describe(type, data)} for ${what} is declared by ${holders
                .map(holder => holder.instance)
                .join(', ')}${running.length ? '' : ' (not running at the moment)'}`,
        );
    }

    return holders;
}

/**
 * What a listening server occupies, as the registry wants it.
 *
 * @param address what `server.address()` returned
 */
export function listeningPort(address: unknown): UsedTcpPort | undefined {
    if (!address || typeof address !== 'object') {
        // A pipe or a UNIX socket - no port, and no resource type the registry knows for it
        return undefined;
    }

    const { port, address: bind, family } = address as { port?: number; address?: string; family?: string };
    if (typeof port !== 'number') {
        return undefined;
    }

    const data: UsedTcpPort = { port, bind };

    if (bind !== undefined && !WILDCARD_ADDRESSES.includes(bind)) {
        // Named only for a concrete address: on a wildcard one the port is occupied in both families,
        // and the host treats a family it is not told about as "every family", which is exactly that.
        data.family = family === 'IPv6' ? 6 : 4;
    }

    return data;
}
