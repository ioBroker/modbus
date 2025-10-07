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

/** Definition of one register */
export interface Register {
    address: number;
    _address: string | number;
    deviceId?: string | number;
    name: string;
    description?: string;
    formula?: string;
    role?: string;
    unit?: string;
    room?: string;
    poll?: boolean;
    wp?: boolean;
    rp?: boolean;
    cw?: boolean;
    rc?: boolean;
    len?: number | string;
    type: RegisterEntryType;
    factor?: number | string;
    offset?: number | string;
    isScale?: boolean;
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
    // IDs of the objects that must be cyclic written (full ID)
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

        tcp?: {
            port: number;
            bind?: string;
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

export interface ModbusParameters {
    type?: ModbusTransport; // default tcp
    bind?: string;
    port?: number | string;
    comName?: string;
    baudRate?: number;
    dataBits?: 5 | 6 | 7 | 8 | string;
    stopBits?: 1 | 2 | string;
    parity?: 'none' | 'even' | 'mark' | 'odd' | 'space';
    deviceId?: number | string | null;
    timeout?: number | string;
    slave?: '0' | '1'; // default master
    poll?: number | string;
    recon?: number | string;
    keepAliveInterval?: number | string;
    maxBlock?: number | string;
    maxBoolBlock?: number | string;
    multiDeviceId?: boolean | 'true';
    pulseTime?: number | string;
    waitTime?: number | string;
    disInputsOffset?: number | string;
    coilsOffset?: number | string;
    inputRegsOffset?: number | string;
    holdingRegsOffset?: number | string;
    showAliases?: true | 'true';
    directAddresses?: boolean | 'true';
    doNotIncludeAdrInId?: boolean | 'true';
    removeUnderscorePrefix?: boolean | 'true';
    preserveDotsInId?: boolean | 'true';
    round?: number | string;
    alwaysUpdate?: boolean;
    doNotRoundAddressToWord?: boolean | 'true';
    doNotUseWriteMultipleRegisters?: boolean | 'true';
    onlyUseWriteMultipleRegisters?: boolean | 'true';
    writeInterval?: number | string;
    readInterval?: number | string;
    disableLogging?: boolean;
    certPrivate?: string;
    certPublic?: string;
    certChained?: string;
    sslAllowSelfSigned?: true;
}

export interface ModbusParametersTyped extends ModbusParameters {
    /** Slave (1) or Master (0) */
    slave: '0' | '1'; // default master
    /** Transport type */
    type: ModbusTransport; // default tcp

    /** TCP IP bind (for slave) or host (for master) address */
    bind: string;
    /** TCP port if type is 'tcp', 'tcprtu' or 'tcp-ssl */
    port: number | string;

    /** Serial port name if type is 'serial' */
    comName: string;
    /** Serial baud rate if type is 'serial' */
    baudRate: number;
    /** Serial data bits if type is 'serial' */
    dataBits: 5 | 6 | 7 | 8 | string;
    /** Serial stop bits if type is 'serial' */
    stopBits: 1 | 2 | string;
    /** Serial parity if type is 'serial' */
    parity: 'none' | 'even' | 'mark' | 'odd' | 'space';

    /** Default device ID */
    deviceId: number | string | null;

    /** Timeout of one read/write cycle in ms */
    timeout: number | string;
    /** Poll interval in ms (for master) */
    poll: number | string;
    /** Reconnect interval in ms (for master) */
    recon: number | string;
    /** Keep alive interval in ms (for master and tcp) */
    keepAliveInterval: number | string;
    /** Maximum number of registers to read in one block (for master) */
    maxBlock: number | string;
    /** Maximum number of boolean registers to read in one block (for master) */
    maxBoolBlock: number | string;
    /** Use multiple device IDs (for master) */
    multiDeviceId: boolean | 'true';
    /** Pulse time for coils in ms (for master and write) */
    pulseTime: number | string;
    /** Wait time between two requests in ms (for master) */
    waitTime: number | string;

    /** Offset for discrete inputs. Default 10001 */
    disInputsOffset: number | string;
    /** Offset for coils. Default 00001 */
    coilsOffset: number | string;
    /** Offset for input registers. Default 30001 */
    inputRegsOffset: number | string;
    /** Offset for holding registers. Default 40001 */
    holdingRegsOffset: number | string;

    /** Show aliases instead of addresses. If true, the address will be 40001 and not 0 */
    showAliases: true | 'true';
    /** For binary registers */
    directAddresses: boolean | 'true';
    /** Do not include the address in the ID. The name will be "_PV_consumption" and not "40001_PV_consumption". To remove leading "_" activate removeUnderscorePrefix attribute */
    doNotIncludeAdrInId: boolean | 'true';
    /** If doNotIncludeAdrInId is true, remove the leading "_" */
    removeUnderscorePrefix: boolean | 'true';
    /** Preserve dots in ID, else they will be replaced with "_" */
    preserveDotsInId: boolean | 'true';
    /** Number of digits after comma to round the value. 0 means integer */
    round: number | string;
    /** If alwaysUpdate is true, the value will be written even if it is the same as before */
    alwaysUpdate: boolean;
    /** Do not round address to next word for registers with len > 1 */
    doNotRoundAddressToWord: boolean | 'true';
    /** Do not use WriteMultipleRegisters (FC16) function for writing holding registers */
    doNotUseWriteMultipleRegisters: boolean | 'true';
    /** Only use WriteMultipleRegisters (FC16) function for writing holding registers */
    onlyUseWriteMultipleRegisters: boolean | 'true';

    /** Interval in ms to check for values to write (for master and write) */
    writeInterval: number | string;
    /** Interval in ms to read registers (for master and read) */
    readInterval: number | string;
    /** Disable logging of errors and info */
    disableLogging: boolean;

    /** Private key for SSL connection if type is 'tcp-ssl' */
    certPrivate: string;
    /** Public certificate for SSL connection if type is 'tcp-ssl' */
    certPublic: string;
    /** Chained certificate for SSL connection if type is 'tcp-ssl' */
    certChained: string;
    /** Allow self-signed certificates for SSL connection if type is 'tcp-ssl' */
    sslAllowSelfSigned: true;
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
