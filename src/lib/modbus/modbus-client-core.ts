import { EventEmitter } from 'node:events';
import Put from '../Put';

const ExceptionMessage: { [error: number]: string } = {
    0x01: 'ILLEGAL FUNCTION',
    0x02: 'ILLEGAL DATA ADDRESS',
    0x03: 'ILLEGAL DATA VALUE',
    0x04: 'SLAVE DEVICE FAILURE',
    0x05: 'ACKNOWLEDGE',
    0x06: 'SLAVE DEVICE BUSY',
    0x08: 'MEMORY PARITY ERROR',
    0x0a: 'GATEWAY PATH UNAVAILABLE',
    0x0b: 'GATEWAY TARGET DEVICE FAILED TO RESPOND',
};

/** Function code names used in log messages */
const FUNCTION_NAMES: { [fc: number]: string } = {
    1: 'read coils',
    2: 'read discrete inputs',
    3: 'read holding registers',
    4: 'read input registers',
    5: 'write single coil',
    6: 'write single register',
    15: 'write multiple coils',
    16: 'write multiple registers',
};

/**
 * One line description of a request for log messages, e.g.
 * `FC16 write multiple registers, address 6609, quantity 1, unit 1`.
 *
 * Without it a timeout or a device exception only says THAT something failed, but not for which
 * register, function code or device - the first question of every analysis (issue #811).
 */
export function describeRequest(request: { fc: number; unitId: number; pdu: Buffer }): string {
    const name = FUNCTION_NAMES[request.fc];
    const parts = [`FC${request.fc}${name ? ` ${name}` : ''}`];

    if (request.pdu.length >= 5) {
        parts.push(`address ${request.pdu.readUInt16BE(1)}`);
        // FC5/FC6 carry the written value where the other function codes carry the quantity
        parts.push(
            request.fc === 5 || request.fc === 6
                ? `value 0x${request.pdu.readUInt16BE(3).toString(16).padStart(4, '0')}`
                : `quantity ${request.pdu.readUInt16BE(3)}`,
        );
    }
    parts.push(`unit ${request.unitId}`);

    return parts.join(', ');
}

/** Payload of the `trashCurrentRequest` event: why the pending request was dropped */
export interface TrashedRequestInfo {
    /** Reason, e.g. `timeout after 5000 ms` */
    reason: string;
    /** Request description, see {@link describeRequest} */
    request: string;
    fc: number;
    unitId: number;
    /** The expired request timeout in ms */
    timeout?: number;
}

/**
 * `Error` for a failed request that keeps the Modbus details.
 *
 * The request callbacks report an object with the exception and timeout information, but the promise
 * of every function code used to reject with `new Error(err.message)` - so everything but `timeout`
 * or the exception text was lost before it reached the adapter's log (issue #811).
 */
function requestError(err: {
    message: string;
    timeout?: number;
    errorCode?: number;
    exceptionCode?: number;
    request?: string;
}): Error {
    const parts = [err.message === 'timeout' && err.timeout ? `timeout after ${err.timeout} ms` : err.message];

    if (err.exceptionCode !== undefined) {
        parts.push(`exception 0x${err.exceptionCode.toString(16).padStart(2, '0')}`);
    }
    if (err.request) {
        parts.push(err.request);
    }

    return Object.assign(new Error(parts.join(' - ')), {
        errorCode: err.errorCode,
        exceptionCode: err.exceptionCode,
        timeout: err.timeout,
        request: err.request,
    });
}

export type ModbusReadResultBinary = {
    unitId: number;
    fc: number;
    byteCount: number;
    payload: Buffer;
    data: boolean[];
};

type ModbusReadResultNumber = {
    unitId: number;
    fc: number;
    byteCount: number;
    payload: Buffer;
    register: number[];
};

type ModbusWriteResultMultiple = {
    unitId: number;
    fc: number;
    startAddress: number;
    quantity: number;
};

type ModbusWriteResultSingleCoil = {
    unitId: number;
    fc: number;
    outputAddress: number;
    outputValue?: boolean;
};

type ModbusWriteResultSingleRegister = {
    unitId: number;
    fc: number;
    registerAddress: number;
    registerValue: number;
    registerAddressRaw: Buffer;
    registerValueRaw: Buffer;
};

type ModbusFcHandler = (
    error: {
        message: string;
        timeout?: number;
        errorCode?: number;
        exceptionCode?: number;
        /** Request description, see {@link describeRequest} */
        request?: string;
    } | null,
    response?:
        | ModbusReadResultBinary
        | ModbusReadResultNumber
        | ModbusWriteResultMultiple
        | ModbusWriteResultSingleCoil
        | ModbusWriteResultSingleRegister,
) => void;

type ModbusRequest = {
    timeout?: NodeJS.Timeout;
    cb: ModbusFcHandler;
    unitId: number;
    fc: number;
    pdu: Buffer;
};
type ModbusFcState = 'waiting' | 'init' | 'error' | 'ready' | 'connect' | 'closed';

export default abstract class ModbusClientCore extends EventEmitter {
    protected readonly log: ioBroker.Logger;
    private readonly responseHandler: {
        [fc: number]: (unitId: number, pdu: Buffer, cb: ModbusFcHandler) => void;
    } = {};
    private currentRequest: ModbusRequest | null = null;

    private reqFifo: ModbusRequest[] = [];
    private readonly timeout: number;
    /** Optional per-device settings, keyed by unitId. `timeout` overrides `timeout` for that device (issue #605) */
    private readonly deviceTimeouts?: { [unitId: number]: { timeout?: number; waitTime?: number } };
    private currentState: ModbusFcState = 'init';

    protected constructor(options: {
        logger: ioBroker.Logger;
        timeout?: number;
        deviceTimeouts?: { [unitId: number]: { timeout?: number; waitTime?: number } };
    }) {
        super();
        this.log = options.logger;
        this.timeout ||= options.timeout || 5 * 1000; // 5s
        this.deviceTimeouts = options.deviceTimeouts;

        this.on('data', this.onData);
        this.on('newState_ready', this.flush);
        this.on('newState_closed', this.onClosed);

        this.responseHandler = {
            1: this.#onReadCoils,
            2: this.#onReadDiscreteInputs,
            3: this.#onReadHoldingRegisters,
            4: this.#onReadInputRegisters,
            5: this.#onWriteSingleCoil,
            6: this.#onWriteSingleRegister,
            15: this.#onWriteMultipleCoils,
            16: this.#onWriteMultipleRegisters,
        };
    }

    inState(state: ModbusFcState): boolean {
        return this.currentState === state;
    }

    getState(): ModbusFcState {
        return this.currentState;
    }

    setState(newState: ModbusFcState): void {
        const oldState = this.currentState;

        this.currentState = newState;

        this.emit('stateChanged', oldState, newState);
        this.emit(`newState_${newState}`);
    }

    flush = (): void => {
        if (this.reqFifo.length) {
            // Capture the request the timer belongs to: `this.currentRequest` may already be the next
            // one by the time the timeout fires
            const request = (this.currentRequest = this.reqFifo.shift()!);

            // Per-device timeout overrides the global one for this unit ID (issue #605)
            const timeout = this.deviceTimeouts?.[request.unitId]?.timeout || this.timeout;

            request.timeout = setTimeout(() => {
                const description = describeRequest(request);
                request.timeout = undefined;
                request.cb?.({ message: 'timeout', timeout, request: description });
                const info: TrashedRequestInfo = {
                    reason: `timeout after ${timeout} ms`,
                    request: description,
                    fc: request.fc,
                    unitId: request.unitId,
                    timeout,
                };
                this.emit('trashCurrentRequest', info);
                this.log.error(`Request timed out after ${timeout} ms: ${description}`);
                this.setState('error');
            }, timeout);

            this.setState('waiting');
            this.emit('send', request.pdu, request.unitId);
        }
    };

    onClosed(): void {
        if (this.currentRequest) {
            this.log.debug('Clearing timeout of the current request.');
            if (this.currentRequest.timeout) {
                clearTimeout(this.currentRequest.timeout);
                this.currentRequest.timeout = undefined;
            }
        }

        this.log.debug('Cleaning up request fifo.');
        this.reqFifo = [];
    }

    handleErrorPDU(pdu: Buffer): boolean {
        const errorCode = pdu.readUInt8(0);

        // if error code is smaller than 0x80
        // ths pdu describes no error

        if (errorCode < 0x80) {
            return false;
        }

        // pdu describes an error
        const exceptionCode = pdu.readUInt8(1);
        const message = ExceptionMessage[exceptionCode];

        const err = {
            errorCode,
            exceptionCode,
            message,
            request: this.currentRequest ? describeRequest(this.currentRequest) : undefined,
        };

        // call the desired deferred
        this.currentRequest?.cb(err);

        return true;
    }

    /**
     *  Handle the incoming data, cut out the packet and send the pdu to the listener
     */
    onData = (pdu: Buffer, unitId: number): void => {
        if (!this.currentRequest) {
            this.log.debug('No current request.');
            return;
        }

        if (this.currentRequest.timeout) {
            clearTimeout(this.currentRequest.timeout);
            this.currentRequest.timeout = undefined;
        }

        try {
            // check pdu for error
            if (this.handleErrorPDU(pdu)) {
                this.log.debug('Received pdu describes an error.');
                this.currentRequest = null;
                this.setState('ready');
                return;
            }
        } catch {
            // ignore
        }

        // handle pdu
        const handler = this.responseHandler[this.currentRequest!.fc];
        if (!handler) {
            this.log.warn(`Found no handler for fc ${this.currentRequest!.fc}`);
            throw new Error(`No handler implemented for fc ${this.currentRequest!.fc}`);
        }

        try {
            handler(unitId, pdu, this.currentRequest!.cb);
        } catch (err) {
            this.log.warn(`Error in handler for FC${this.currentRequest!.fc}: ${err}`);
        }

        this.setState('ready');
    };

    queueRequest = (unitId: number, fc: number, pdu: Buffer, cb: ModbusFcHandler): void => {
        this.reqFifo.push({ unitId, fc, pdu, cb });

        if (this.inState('ready')) {
            this.flush();
        }
    };

    abstract connect(): void;
    abstract reconnect(): void;
    abstract close(): void;

    // FC 1 - Read Coils
    #onReadCoils = (unitId: number, pdu: Buffer, cb: ModbusFcHandler): void => {
        const fc = pdu.readUInt8(0);

        // Check if this is an error response (FC + 0x80)
        if (fc === 1 + 0x80) {
            // This is a ModBus error response for ReadCoils
            const exceptionCode = pdu.readUInt8(1);

            const message = ExceptionMessage[exceptionCode] || `Unknown exception code: ${exceptionCode}`;
            cb({
                errorCode: fc,
                exceptionCode,
                message: `ReadCoils: ${message}`,
            });
        } else if (fc !== 1) {
            cb({ message: `ReadCoils: Invalid FC ${fc}` });
        } else {
            const byteCount = pdu.readUInt8(1);
            // let bitCount    = byteCount * 8;
            const resp: ModbusReadResultBinary = {
                unitId,
                fc,
                byteCount,
                payload: pdu.slice(2),
                data: [],
            };

            let counter = 0;
            for (let i = 0; i < byteCount; i += 1) {
                let h = 1;
                const cur = pdu.readUInt8(2 + i);
                for (let j = 0; j < 8; j++) {
                    resp.data[counter] = (cur & h) > 0;
                    h = h << 1;
                    counter += 1;
                }
            }

            cb(null, resp);
        }
    };
    readCoils = (unitId: number, start: number, quantity: number): Promise<ModbusReadResultBinary> => {
        return new Promise<ModbusReadResultBinary>((resolve, reject) => {
            const pdu = new Put().word8(1).word16be(start).word16be(quantity).buffer();

            this.queueRequest(unitId, 1, pdu, (err, resp): void => {
                if (err) {
                    reject(requestError(err));
                } else {
                    resolve(resp as ModbusReadResultBinary);
                }
            });
        });
    };

    // FC 2 - Read Discrete Inputs
    #onReadDiscreteInputs = (unitId: number, pdu: Buffer, cb: ModbusFcHandler): void => {
        const fc = pdu.readUInt8(0);

        // Check if this is an error response (FC + 0x80)
        if (fc === 2 + 0x80) {
            // This is a ModBus error response for ReadDiscreteInputs
            const exceptionCode = pdu.readUInt8(1);
            const message = ExceptionMessage[exceptionCode] || `Unknown exception code: ${exceptionCode}`;
            cb({
                errorCode: fc,
                exceptionCode,
                message: `ReadDiscreteInputs: ${message}`,
            });
        } else if (fc !== 2) {
            cb({ message: `ReadDiscreteInputs: Invalid FC ${fc}` });
        } else {
            const byteCount = pdu.readUInt8(1);
            let counter = 0;
            const resp: ModbusReadResultBinary = {
                unitId,
                fc,
                byteCount,
                payload: pdu.slice(2),
                data: [],
            };

            for (let i = 0; i < byteCount; i++) {
                let h = 1;
                const cur = pdu.readUInt8(2 + i);
                for (let j = 0; j < 8; j += 1) {
                    resp.data[counter] = (cur & h) > 0;
                    h = h << 1;
                    counter += 1;
                }
            }

            cb(null, resp);
        }
    };
    readDiscreteInputs = (unitId: number, start: number, quantity: number): Promise<ModbusReadResultBinary> => {
        return new Promise<ModbusReadResultBinary>((resolve, reject) => {
            if (quantity > 2000) {
                return reject(new Error('quantity is too big'));
            }

            const pdu = new Put().word8be(2).word16be(start).word16be(quantity).buffer();

            this.queueRequest(unitId, 2, pdu, (err, resp) => {
                if (err) {
                    reject(requestError(err));
                } else {
                    resolve(resp as ModbusReadResultBinary);
                }
            });
        });
    };

    // FC 3 - Read Holding Registers
    #onReadHoldingRegisters = (unitId: number, pdu: Buffer, cb: ModbusFcHandler): void => {
        const fc = pdu.readUInt8(0);

        // Check if this is an error response (FC + 0x80)
        if (fc === 3 + 0x80) {
            // This is a ModBus error response for ReadHoldingRegisters
            const exceptionCode = pdu.readUInt8(1);
            const message = ExceptionMessage[exceptionCode] || `Unknown exception code: ${exceptionCode}`;
            cb({
                errorCode: fc,
                exceptionCode,
                message: `ReadHoldingRegisters: ${message}`,
            });
        } else if (fc !== 3) {
            cb({ message: `ReadHoldingRegisters: Invalid FC ${fc}` });
        } else {
            const byteCount = pdu.readUInt8(1);

            const resp: ModbusReadResultNumber = {
                unitId,
                fc,
                byteCount,
                payload: pdu.slice(2),
                register: [],
            };
            const registerCount = byteCount / 2;

            if (byteCount + 2 > pdu.byteLength) {
                cb({
                    message: `ReadHoldingRegisters: Response length is invalid. Received ${pdu.byteLength} bytes, expected ${byteCount + 2} bytes`,
                });
                return;
            }

            for (let i = 0; i < registerCount; i++) {
                resp.register.push(pdu.readUInt16BE(2 + i * 2));
            }

            cb(null, resp);
        }
    };
    readHoldingRegisters = (unitId: number, start: number, quantity: number): Promise<ModbusReadResultNumber> => {
        return new Promise<ModbusReadResultNumber>((resolve, reject) => {
            const pdu = new Put().word8be(3).word16be(start).word16be(quantity).buffer();

            this.queueRequest(unitId, 3, pdu, (err, resp) => {
                if (err) {
                    reject(requestError(err));
                } else {
                    resolve(resp as ModbusReadResultNumber);
                }
            });
        });
    };

    // FC 4 - Read Input Registers
    #onReadInputRegisters = (unitId: number, pdu: Buffer, cb: ModbusFcHandler): void => {
        const fc = pdu.readUInt8(0);

        // Check if this is an error response (FC + 0x80)
        if (fc === 4 + 0x80) {
            // This is a ModBus error response for ReadInputRegisters
            const exceptionCode = pdu.readUInt8(1);
            const message = ExceptionMessage[exceptionCode] || `Unknown exception code: ${exceptionCode}`;
            cb({
                errorCode: fc,
                exceptionCode,
                message: `ReadInputRegisters: ${message}`,
            });
        } else if (fc !== 4) {
            cb({ message: `ReadInputRegisters: Invalid FC ${fc}` });
        } else {
            const byteCount = pdu.readUInt8(1);

            const resp: ModbusReadResultNumber = {
                unitId,
                fc,
                byteCount,
                payload: pdu.slice(2),
                register: [],
            };
            const registerCount = byteCount / 2;

            if (byteCount + 2 > pdu.byteLength) {
                cb({
                    message: `ReadInputRegisters: Response length is invalid. Received ${pdu.byteLength} bytes, expected ${byteCount + 2} bytes`,
                });
                return;
            }

            for (let i = 0; i < registerCount; i++) {
                resp.register.push(pdu.readUInt16BE(2 + i * 2));
            }

            cb(null, resp);
        }
    };
    readInputRegisters = (unitId: number, start: number, quantity: number): Promise<ModbusReadResultNumber> => {
        return new Promise((resolve, reject) => {
            const pdu = new Put().word8be(4).word16be(start).word16be(quantity).buffer();

            this.queueRequest(unitId, 4, pdu, (err, resp) => {
                if (err) {
                    reject(requestError(err));
                } else {
                    resolve(resp as ModbusReadResultNumber);
                }
            });
        });
    };

    // FC 5 - Write Single Coil
    #onWriteSingleCoil = (unitId: number, pdu: Buffer, cb: ModbusFcHandler): void => {
        const fc = pdu.readUInt8(0);
        const outputAddress = pdu.readUInt16BE(1);
        const outputValue = pdu.readUInt16BE(3);

        const resp: ModbusWriteResultSingleCoil = {
            unitId,
            fc,
            outputAddress,
            outputValue: outputValue === 0x0000 ? false : outputValue === 0xff00 ? true : undefined,
        };

        if (fc !== 5) {
            cb({ message: `WriteSingleCoil: Invalid FC ${fc}` });
        } else {
            cb(null, resp);
        }
    };
    writeSingleCoil = (
        unitId: number,
        address: number,
        value: boolean | Buffer,
    ): Promise<ModbusWriteResultSingleCoil> => {
        return new Promise((resolve, reject) => {
            const payload: boolean = value instanceof Buffer ? value.readUInt8(0) > 0 : (value as boolean);
            const pdu = new Put()
                .word8be(5)
                .word16be(address)
                .word16be(payload ? 0xff00 : 0x0000);

            this.queueRequest(unitId, 5, pdu.buffer(), (err, resp) => {
                if (err) {
                    reject(requestError(err));
                } else {
                    resolve(resp as ModbusWriteResultSingleCoil);
                }
            });
        });
    };

    // FC 6 - Write Single Register
    #onWriteSingleRegister = (unitId: number, pdu: Buffer, cb: ModbusFcHandler): void => {
        const fc = pdu.readUInt8(0);
        const registerAddress = pdu.readUInt16BE(1);
        const registerValue = pdu.readUInt16BE(3);

        const resp: ModbusWriteResultSingleRegister = {
            unitId,
            fc,
            registerAddress,
            registerValue,
            registerAddressRaw: pdu.slice(1, 3),
            registerValueRaw: pdu.slice(3, 5),
        };

        if (fc !== 6) {
            cb({ message: `WriteSingleRegister: Invalid FC ${fc}` });
        } else {
            cb(null, resp);
        }
    };
    writeSingleRegister = (
        unitId: number,
        address: number,
        value: Buffer | number,
    ): Promise<ModbusWriteResultSingleRegister> => {
        return new Promise((resolve, reject) => {
            const payload = value instanceof Buffer ? value : new Put().word16be(value as number).buffer();
            const pdu = new Put().word8be(6).word16be(address).put(payload);

            this.queueRequest(unitId, 6, pdu.buffer(), (err, resp) => {
                if (err) {
                    reject(requestError(err));
                } else {
                    resolve(resp as ModbusWriteResultSingleRegister);
                }
            });
        });
    };

    // FC 15 - Write Multiple Coils
    #onWriteMultipleCoils = (unitId: number, pdu: Buffer, cb: ModbusFcHandler): void => {
        const fc = pdu.readUInt8(0);
        const startAddress = pdu.readUInt16BE(1);
        const quantity = pdu.readUInt16BE(3);

        const resp: ModbusWriteResultMultiple = {
            unitId,
            fc,
            startAddress,
            quantity,
        };

        if (fc !== 15) {
            cb({ message: `WriteMultipleCoils: Invalid FC ${fc}` });
        } else {
            cb(null, resp);
        }
    };
    writeMultipleCoils = (
        unitId: number,
        startAddress: number,
        data: Buffer | number[],
        N?: number,
    ): Promise<ModbusWriteResultMultiple> => {
        return new Promise((resolve, reject) => {
            const pdu = new Put().word8(15).word16be(startAddress);

            if (data instanceof Buffer) {
                pdu.word16be(N!).word8(data.length).put(data);
            } else if (data instanceof Array) {
                if (data.length > 1968) {
                    reject(new Error('Length is too big'));
                    return;
                }

                const byteCount = Math.ceil(data.length / 8);
                let curByte = 0;
                let cntr = 0;

                pdu.word16be(data.length).word8(byteCount);

                for (let i = 0; i < data.length; i++) {
                    curByte += data[i] ? Math.pow(2, cntr) : 0;

                    cntr = (cntr + 1) % 8;

                    if (cntr === 0 || i === data.length - 1) {
                        pdu.word8(curByte);
                        curByte = 0;
                    }
                }
            }

            this.queueRequest(unitId, 15, pdu.buffer(), (err, resp) => {
                if (err) {
                    reject(requestError(err));
                } else {
                    resolve(resp as ModbusWriteResultMultiple);
                }
            });
        });
    };

    // FC 16 - Write Multiple Registers
    #onWriteMultipleRegisters = (unitId: number, pdu: Buffer, cb: ModbusFcHandler): void => {
        const fc = pdu.readUInt8(0);

        if (fc !== 16) {
            cb({ message: `WriteMultipleRegisters: Invalid FC ${fc}` });
        } else {
            const startAddress = pdu.readUInt16BE(1);
            const quantity = pdu.readUInt16BE(3);

            const resp: ModbusWriteResultMultiple = {
                unitId,
                fc,
                startAddress,
                quantity,
            };
            cb(null, resp);
        }
    };
    writeMultipleRegisters = (
        unitId: number,
        startAddress: number,
        data: Buffer | number[],
    ): Promise<ModbusWriteResultMultiple> => {
        return new Promise<ModbusWriteResultMultiple>((resolve, reject) => {
            const pdu = new Put().word8(16).word16be(startAddress);
            if (data instanceof Buffer) {
                if (data.length / 2 > 0x007b) {
                    reject(new Error('Length is too big'));
                    return;
                }

                pdu.word16be(data.length / 2)
                    .word8(data.length)
                    .put(data);
            } else if (data instanceof Array) {
                if (data.length > 0x007b) {
                    reject(new Error('Length is too big'));
                    return;
                }

                const byteCount = Math.ceil(data.length * 2);
                pdu.word16be(data.length).word8(byteCount);

                for (let i = 0; i < data.length; i += 1) {
                    pdu.word16be(data[i]);
                }
            } else {
                reject(new Error('Invalid data'));
                return;
            }

            this.queueRequest(unitId, 16, pdu.buffer(), (err, resp) => {
                if (err) {
                    reject(requestError(err));
                } else {
                    resolve(resp as ModbusWriteResultMultiple);
                }
            });
        });
    };
}
