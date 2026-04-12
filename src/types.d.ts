/** Definitions for Modbus adapter for ioBroker */

/** Data types for registers */
export type RegisterEntryType =
    | ''
    | 'string'
    | 'stringle'
    | 'string16'
    | 'string16le'
    | 'rawhex'
    | 'uint16be'
    | 'uint16le'
    | 'int16be'
    | 'int16le'
    | 'uint8be'
    | 'uint8le'
    | 'int8be'
    | 'int8le'
    | 'uint32be'
    | 'uint32le'
    | 'uint32sw'
    | 'uint32sb'
    | 'int32be'
    | 'int32le'
    | 'int32sw'
    | 'int32sb'
    | 'int64be'
    | 'int64le'
    | 'floatbe'
    | 'floatle'
    | 'floatsw'
    | 'floatsb'
    | 'uint64be'
    | 'uint64le'
    | 'doublebe'
    | 'doublele';

/** Definition of one Modbus register */
export interface Register {
    /** Parsed numeric address of the register */
    address: number;
    /** Raw address as entered by the user (maybe a string like "0" or a number) */
    _address: string | number;
    /** Modbus device/unit ID. Used when multiDeviceId is enabled */
    deviceId?: string | number;
    /** Name of the register, used to build the ioBroker state ID */
    name: string;
    /** Human-readable description of the register */
    description?: string;
    /** JavaScript formula for value transformation, e.g. `"x * sf['40065'] + 50"`. `x` is the raw value, `sf` is the scale-factor map */
    formula?: string;
    /** ioBroker role for the created state object, e.g. `"level"`, `"value.temperature"` */
    role?: string;
    /** Unit of measurement, e.g. `"°C"`, `"kWh"` */
    unit?: string;
    /** Room assignment for the state (enum) */
    room?: string;
    /** If true, this register is included in the cyclic poll (used for coils and holding registers) */
    poll?: boolean;
    /** Write-pulse: if true, the coil is written as a pulse with the configured pulse time */
    wp?: boolean;
    /** Read-poll: if true, this register is polled for reading */
    rp?: boolean;
    /** Cyclic-write: if true, the holding register value is re-written on every poll cycle */
    cw?: boolean;
    /** Read-calculate: if true, the value is calculated from a formula on each read */
    rc?: boolean;
    /** Number of Modbus registers (16-bit words) this entry occupies. Default is 1 */
    len?: number | string;
    /** Data type for encoding/decoding the register value, e.g. `"uint16be"`, `"floatbe"`, `"string"` */
    type: RegisterEntryType;
    /** Multiplication factor applied to the raw value: `result = raw * factor + offset` */
    factor?: number | string;
    /** Additive offset applied after the factor: `result = raw * factor + offset` */
    offset?: number | string;
    /** If true, this register stores a dynamic scale factor used in formulas of other registers via `sf[address]` */
    isScale?: boolean;
    /** Enable value sanitization for invalid values (NaN, Infinity, extreme floats) */
    sanitize?: boolean;
    /** Action to take when an invalid value is detected */
    sanitizeAction?: 'keepLastValid' | 'replaceWithZero';
    /** Minimum valid value threshold (optional) */
    minValidValue?: number | string;
    /** Maximum valid value threshold (optional) */
    maxValidValue?: number | string;
}

export interface RegisterInternal extends Omit<Register, '_address' | 'len' | 'factor' | 'offset'> {
    _address: number;
    id: string;
    fullId: string;
    len: number;
    offset: number;
    factor: number;
}
export type RegisterType = 'disInputs' | 'coils' | 'inputRegs' | 'holdingRegs';
export type ModbusTransport = 'tcp' | 'serial' | 'tcprtu' | 'tcp-ssl';

interface DeviceOption {
    fullIds: string[];
    addressHigh: number;
    addressLow: number;
    length: number;
    offset: number;
    config: RegisterInternal[];
}

export interface DeviceSlaveOption extends DeviceOption {
    changed: boolean;
    values: (number | boolean)[];
    mapping: { [address: number]: string };

    lastStart?: number;
    lastEnd?: number;
}

export interface DeviceMasterOption extends DeviceOption {
    deviceId: number;
    blocks: { start: number; count: number; startIndex: number; endIndex: number }[];
    // IDs of the objects that must be cyclically written (full ID)
    cyclicWrite?: string[];
}

export type MasterDevice = {
    disInputs: DeviceMasterOption;
    coils: DeviceMasterOption;
    inputRegs: DeviceMasterOption;
    holdingRegs: DeviceMasterOption;
};

export type SlaveDevice = {
    disInputs: DeviceSlaveOption;
    coils: DeviceSlaveOption;
    inputRegs: DeviceSlaveOption;
    holdingRegs: DeviceSlaveOption;
};

export interface Options {
    config: {
        type: ModbusTransport;
        slave: boolean;
        alwaysUpdate: boolean;
        round: number;
        timeout: number;
        defaultDeviceId: number;
        doNotIncludeAdrInId: boolean;
        preserveDotsInId: boolean;
        writeInterval: number;
        doNotUseWriteMultipleRegisters: boolean;
        onlyUseWriteMultipleRegisters: boolean;
        multiDeviceId?: boolean;

        // Only for master
        poll?: number;
        recon?: number;
        maxBlock?: number;
        maxBoolBlock?: number;
        pulseTime?: number;
        waitTime?: number;
        readInterval?: number;
        keepAliveInterval?: number;
        disableLogging?: boolean;
        /** Enable automatic sanitization of invalid register values */
        enableSanitization?: boolean;

        tcp?: {
            port: number;
            ip?: string;
        };

        ssl?: {
            rejectUnauthorized: boolean;
            key: string;
            cert: string;
            ca?: string;
        };

        serial?: {
            comName: string;
            baudRate: number;
            dataBits: 5 | 6 | 7 | 8;
            stopBits: 1 | 2;
            parity: 'none' | 'even' | 'mark' | 'odd' | 'space';
        };
    };
    devices: {
        [deviceId: number]: MasterDevice | SlaveDevice;
    };
    objects: { [id: string]: ioBroker.StateObject | null | undefined };
}

/** Modbus adapter parameters as stored in the adapter configuration (all optional; values may be strings from the UI) */
export interface ModbusParameters {
    /** Transport type: TCP, Serial, TCP-RTU, or TCP with SSL. Default: `"tcp"` */
    type?: ModbusTransport;
    /** TCP bind address for slave mode */
    bind?: string;
    /** TCP host/IP address to connect to (master mode) */
    host?: string;
    /** TCP port number. Default: 502 */
    port?: number | string;
    /** Serial port name, e.g. `"/dev/ttyUSB0"` or `"COM3"` */
    comName?: string;
    /** Serial baud rate, e.g. 9600, 19200, 115200 */
    baudRate?: number;
    /** Serial data bits: 5, 6, 7, or 8 */
    dataBits?: 5 | 6 | 7 | 8 | string;
    /** Serial stop bits: 1 or 2 */
    stopBits?: 1 | 2 | string;
    /** Serial parity mode */
    parity?: 'none' | 'even' | 'mark' | 'odd' | 'space';
    /** Default Modbus device/unit ID */
    deviceId?: number | string | null;
    /** Timeout of one read/write cycle in ms */
    timeout?: number | string;
    /** Adapter role: `"0"` = master, `"1"` = slave. Default: `"0"` (master) */
    slave?: '0' | '1';
    /** Poll interval in ms (master mode). Default: 1000 */
    poll?: number | string;
    /** Reconnect interval in ms after connection loss (master mode) */
    recon?: number | string;
    /** Keep-alive interval in ms (master mode, TCP) */
    keepAliveInterval?: number | string;
    /** Maximum number of registers to read in one block (master mode) */
    maxBlock?: number | string;
    /** Maximum number of boolean (coil/discrete input) registers to read in one block (master mode) */
    maxBoolBlock?: number | string;
    /** Enable multiple device IDs — each register can specify its own deviceId */
    multiDeviceId?: boolean | 'true';
    /** Pulse time for coil writes in ms (master mode) */
    pulseTime?: number | string;
    /** Wait time between two Modbus requests in ms (master mode) */
    waitTime?: number | string;
    /** Address offset for discrete inputs. Default: 10001 */
    disInputsOffset?: number | string;
    /** Address offset for coils. Default: 1 */
    coilsOffset?: number | string;
    /** Address offset for input registers. Default: 30001 */
    inputRegsOffset?: number | string;
    /** Address offset for holding registers. Default: 40001 */
    holdingRegsOffset?: number | string;
    /** Show Modbus aliases instead of zero-based addresses (e.g. 40001 instead of 0) */
    showAliases?: boolean | 'true';
    /** Use direct addresses for binary registers (coils/discrete inputs) */
    directAddresses?: boolean | 'true';
    /** Do not include the register address in the ioBroker state ID */
    doNotIncludeAdrInId?: boolean | 'true';
    /** Remove the leading underscore from state names (only when doNotIncludeAdrInId is true) */
    removeUnderscorePrefix?: boolean | 'true';
    /** Preserve dots in the state ID instead of replacing them with underscores */
    preserveDotsInId?: boolean | 'true';
    /** Include the register type in the state name. If a string, used as a channel name */
    registerTypeInName?: boolean | string;
    /** Number of decimal digits for rounding values. 0 means integer */
    round?: number | string;
    /** If true, update the state on every poll even if the value has not changed */
    alwaysUpdate?: boolean;
    /** Do not round register addresses to the next word boundary for multi-word registers */
    doNotRoundAddressToWord?: boolean | 'true';
    /** Disable WriteMultipleRegisters (FC16) — use WriteSingleRegister (FC06) instead */
    doNotUseWriteMultipleRegisters?: boolean | 'true';
    /** Only use WriteMultipleRegisters (FC16) for all holding register writes */
    onlyUseWriteMultipleRegisters?: boolean | 'true';
    /** Interval in ms to check for queued write operations (master mode) */
    writeInterval?: number | string;
    /** Interval in ms between read cycles (master mode). 0 = continuous polling */
    readInterval?: number | string;
    /** Disable connection error logging */
    disableLogging?: boolean;
    /** Name of the private key certificate for SSL/TLS connections */
    certPrivate?: string;
    /** Name of the public certificate for SSL/TLS connections */
    certPublic?: string;
    /** Name of the chained/CA certificate for SSL/TLS connections */
    certChained?: string;
    /** Allow self-signed certificates for SSL/TLS connections */
    sslAllowSelfSigned?: boolean;
    /** Enable automatic sanitization of invalid register values (NaN, Infinity, extreme floats, out-of-range) */
    enableSanitization?: boolean;
}

export interface ModbusParametersTyped extends ModbusParameters {
    /** Slave (1) or Master (0) */
    slave: '0' | '1'; // default master
    /** Transport type */
    type: ModbusTransport; // default tcp

    /** TCP IP bind is 'tcp', 'tcprtu' or 'tcp-ssl' and slave */
    bind: string;
    /** TCP port if the type is 'tcp', 'tcprtu' or 'tcp-ssl' */
    port: number | string;
    /** TCP host if the type is 'tcp', 'tcprtu' or 'tcp-ssl' and master */
    host: string;
    /** Private key for SSL connection if the type is 'tcp-ssl' */
    certPrivate: string;
    /** Public certificate for SSL connection if the type is 'tcp-ssl' */
    certPublic: string;
    /** Chained certificate for SSL connection if the type is 'tcp-ssl' */
    certChained: string;
    /** Allow self-signed certificates for SSL connection if the type is 'tcp-ssl' */
    sslAllowSelfSigned: boolean;

    /** Serial port name if the type is 'serial' */
    comName: string;
    /** Serial baud rate if the type is 'serial' */
    baudRate: number | string;
    /** Serial data bits if the type is 'serial' */
    dataBits: 5 | 6 | 7 | 8 | string;
    /** Serial stop bits if the type is 'serial' */
    stopBits: 1 | 2 | string;
    /** Serial parity if the type is 'serial' */
    parity: 'none' | 'even' | 'mark' | 'odd' | 'space';

    /** Default device ID */
    deviceId: number | string | null;

    /** Maximum number of registers to read in one block (for master) */
    maxBlock: number | string;
    /** Maximum number of boolean registers to read in one block (for master) */
    maxBoolBlock: number | string;
    /** Use multiple device IDs (for master) */
    multiDeviceId: boolean | 'true';

    /** Timeout of one read/write cycle in ms */
    timeout: number | string;
    /** Poll interval in ms (for master) */
    poll: number | string;
    /** Reconnect interval in ms (for master) */
    recon: number | string;
    /** The keep-alive interval in ms (for master and tcp) */
    keepAliveInterval: number | string;
    /** Pulse time for coils in ms (for master and write) */
    pulseTime: number | string;
    /** Wait time between two requests in ms (for master) */
    waitTime: number | string;

    /** Interval in ms to check for values to write (for master and write) */
    writeInterval: number | string;
    /** Interval in ms to read registers (for master and read) */
    readInterval: number | string;

    /** Offset for discrete inputs. Default 10001 */
    disInputsOffset: number | string;
    /** Offset for coils. Default 00001 */
    coilsOffset: number | string;
    /** Offset for input registers. Default 30001 */
    inputRegsOffset: number | string;
    /** Offset for holding registers. Default 40001 */
    holdingRegsOffset: number | string;

    /** Show aliases instead of addresses. If true, the address will be 40001 and not 0 */
    showAliases: boolean | 'true';
    /** For binary registers */
    directAddresses: boolean | 'true';
    /**
     * Do not include the address in the ID.
     * The name will be "_PV_consumption" and not "40001_PV_consumption".
     * To remove the leading "_", activate removeUnderscorePrefix attribute.
     * This is only active if `showAliases` is false.
     */
    doNotIncludeAdrInId: boolean | 'true';
    /** If doNotIncludeAdrInId is true, remove the leading "_" */
    removeUnderscorePrefix: boolean | 'true';
    /** Preserve dots in ID, else they will be replaced with "_" */
    preserveDotsInId: boolean | 'true';
    /** No register type in name if `true` or channel name as string */
    registerTypeInName?: boolean | string;
    /** Do not round address to the next word for registers with len > 1 */
    doNotRoundAddressToWord: boolean | 'true';

    /** Number of digits after comma to round the value. 0 means integer */
    round: number | string;
    /** If alwaysUpdate is true, the value will be written even if it is the same as before */
    alwaysUpdate: boolean;
    /** Do not use WriteMultipleRegisters (FC16) function for writing holding registers */
    doNotUseWriteMultipleRegisters: boolean | 'true';
    /** Only use WriteMultipleRegisters (FC16) function for writing holding registers */
    onlyUseWriteMultipleRegisters: boolean | 'true';

    /** Disable logging of errors and info */
    disableLogging: boolean;
    /** Enable automatic sanitization of invalid register values */
    enableSanitization?: boolean;
}

export interface ModbusAdapterConfig extends ioBroker.AdapterConfig {
    /** Configuration of the adapter */
    params: ModbusParametersTyped;

    /** Definition of the registers */
    disInputs: Register[];
    coils: Register[];
    inputRegs: Register[];
    holdingRegs: Register[];
}
