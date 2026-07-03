import Put from '../../Put';
import { createSocket, type Socket } from 'node:dgram';
import ModbusClientCore from '../modbus-client-core';

/**
 * Modbus/UDP master transport.
 *
 * Modbus/UDP uses the same MBAP header + PDU framing as Modbus/TCP (transaction id, protocol id,
 * length, unit id), but each request/response is carried in a single UDP datagram instead of a TCP
 * stream. That makes framing simpler (one datagram = one complete frame, no reassembly), but UDP is
 * connectionless and unreliable: a request to an offline device usually produces no socket error,
 * it just times out (handled by ModbusClientCore's per-request timeout).
 *
 * The class mirrors `ModbusClientTCP` so it plugs into the same core state machine: the socket
 * `close` event drives the state back to `closed`, and reconnection is left to the caller (Master).
 */
export default class ModbusClientUDP extends ModbusClientCore {
    private reqId = 0;
    private currentRequestId = 0;
    private closedOnPurpose = false;
    #reconnect = false;
    private trashRequestId: number | undefined;
    private socket: Socket | null = null;
    private udp: {
        host: string;
        port: number;
        protocolVersion: number;
        autoReconnect: boolean;
        reconnectTimeout: number;
    };
    private unitId: number;

    constructor(options: {
        udp: {
            host?: string;
            port?: number;
            protocolVersion?: number;
            autoReconnect?: boolean;
            reconnectTimeout?: number;
        };
        unitId?: number;
        logger: ioBroker.Logger;
        timeout?: number;
        deviceTimeouts?: { [unitId: number]: { timeout?: number; waitTime?: number } };
    }) {
        super(options);

        this.setState('init');
        this.udp = options.udp as {
            host: string;
            port: number;
            protocolVersion: number;
            autoReconnect: boolean;
            reconnectTimeout: number;
        };
        this.unitId = options.unitId || 1;

        this.udp.protocolVersion ||= 0;
        this.udp.port ||= 502;
        this.udp.host ||= 'localhost';
        this.udp.autoReconnect ||= false;
        this.udp.reconnectTimeout ||= 0;

        this.on('send', this.#onSend);
        this.on('newState_error', this.#onError);
        this.on('trashCurrentRequest', this.#onTrashCurrentRequest);
    }

    #onSocketConnect = (): void => {
        this.emit('connect');
        this.setState('ready');
    };

    #onSocketClose = (): void => {
        this.log.debug('Socket closed');

        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket = null;
        }

        this.setState('closed');
        this.emit('close');

        if (!this.closedOnPurpose && (this.udp.autoReconnect || this.#reconnect)) {
            setTimeout(() => {
                this.#reconnect = false;
                this.connect();
            }, this.udp.reconnectTimeout);
        }
    };

    #onSocketError = (err: Error | string): void => {
        this.log.error(`Socket Error ${err}`);
        this.setState('error');
        this.emit('error', err);
    };

    #onSocketMessage = (msg: Buffer): void => {
        // A UDP datagram carries exactly one complete MBAP + PDU frame, so no stream reassembly.
        if (msg.length <= 8) {
            this.log.debug('UDP datagram too short for an MBAP header');
            return;
        }

        // 1. extract mbap
        const id = msg.readUInt16BE(0);
        const len = msg.readUInt16BE(4);
        const unitId = msg.readUInt8(6);

        // 2. extract pdu (length counts unit id + pdu, so pdu length is len - 1)
        if (msg.length < 7 + len - 1) {
            this.log.debug('UDP datagram shorter than the announced MBAP length');
            return;
        }

        const pdu = msg.subarray(7, 7 + len - 1);

        if (id === this.trashRequestId) {
            this.log.debug('current mbap contains trashed request id.');
        } else {
            // emit data event and let the listener handle the pdu
            this.emit('data', pdu, unitId);
        }
    };

    #onError = (): void => {
        this.log.error(`Client in error state.`);
        // Close the datagram socket; the 'close' event moves the FSM to 'closed'.
        this.#safeClose();
    };

    #onSend = (pdu: Buffer, unitId?: number): void => {
        this.reqId = (this.reqId + 1) % 0xffff;

        const pkt = new Put()
            .word16be(this.reqId) // transaction id
            .word16be(this.udp.protocolVersion) // protocol version
            .word16be(pdu.length + 1) // pdu length
            .word8((unitId === undefined ? this.unitId : unitId) || 0) // unit id
            .put(pdu) // the actual pdu
            .buffer();

        this.currentRequestId = this.reqId;

        // The socket is connected to the remote peer, so send() needs no explicit address.
        this.socket?.send(pkt, err => {
            if (err) {
                this.#onSocketError(err);
            }
        });
    };

    #onTrashCurrentRequest = (): void => {
        this.trashRequestId = this.currentRequestId;
    };

    #safeClose(): void {
        try {
            this.socket?.close();
        } catch {
            // socket not running / already closing – the 'close' handler still fires
        }
    }

    connect(): void {
        this.setState('connect');

        // Start every (re)connection from a clean state.
        this.trashRequestId = undefined;
        this.closedOnPurpose = false;

        if (!this.socket) {
            this.socket = createSocket('udp4');
            this.socket.on('connect', this.#onSocketConnect);
            this.socket.on('close', this.#onSocketClose);
            this.socket.on('error', this.#onSocketError);
            this.socket.on('message', this.#onSocketMessage);
        }

        // `connect` fixes the remote peer (and does the DNS lookup); afterwards send()/message
        // only talk to that peer and it emits 'connect'. UDP has no real handshake.
        this.socket.connect(this.udp.port, this.udp.host);
    }

    reconnect(): void {
        if (!this.inState('closed')) {
            return;
        }

        this.closedOnPurpose = false;
        this.#reconnect = true;

        this.log.debug('Reconnecting client.');

        this.#safeClose();
    }

    close(): void {
        this.closedOnPurpose = true;
        this.log.debug('Closing client on purpose.');
        this.#safeClose();
    }
}
