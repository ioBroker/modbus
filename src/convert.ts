import type { Register, RegisterType } from './types';
import { tsv2json } from 'tsv-json';
import { readFileSync, existsSync } from 'node:fs';
import { scryptSync, createDecipheriv, type BinaryLike } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // 256 Bit
const IV_LEN = 12; // GCM suggest 12 Byte

type RegisterField = {
    name: string;
    type?: 'checkbox';
};

const coils: RegisterField[] = [
    { name: '_address' },
    { name: 'name' },
    { name: 'description' },
    { name: 'formula' },
    { name: 'role' },
    { name: 'room' },
    { name: 'poll', type: 'checkbox' },
    { name: 'wp', type: 'checkbox' },
    { name: 'cw', type: 'checkbox' },
    { name: 'isScale', type: 'checkbox' },
];

const disInputs: RegisterField[] = [
    { name: '_address' },
    { name: 'name' },
    { name: 'description' },
    { name: 'formula' },
    { name: 'role' },
    { name: 'room' },
    { name: 'cw', type: 'checkbox' },
    { name: 'isScale', type: 'checkbox' },
];

const holdingRegs: RegisterField[] = [
    { name: '_address' },
    { name: 'name' },
    { name: 'description' },
    { name: 'unit' },
    { name: 'type' },
    { name: 'len' },
    { name: 'factor' },
    { name: 'offset' },
    { name: 'formula' },
    { name: 'role' },
    { name: 'room' },
    { name: 'poll', type: 'checkbox' },
    { name: 'wp', type: 'checkbox' },
    { name: 'cw', type: 'checkbox' },
    { name: 'isScale', type: 'checkbox' },
];

const inputRegs: RegisterField[] = [
    { name: '_address' },
    { name: 'name' },
    { name: 'description' },
    { name: 'unit' },
    { name: 'type' },
    { name: 'len' },
    { name: 'factor' },
    { name: 'offset' },
    { name: 'formula' },
    { name: 'role' },
    { name: 'room' },
    { name: 'cw', type: 'checkbox' },
    { name: 'isScale', type: 'checkbox' },
];

export function decrypt(cipherTextB64: string, password: BinaryLike): string {
    const data = Buffer.from(cipherTextB64, 'base64');
    if (typeof password === 'string' && password.length !== 32) {
        password = Buffer.from(password, 'base64');
    }

    const salt = data.subarray(0, 16);
    const iv = data.subarray(16, 16 + IV_LEN);
    const authTag = data.subarray(16 + IV_LEN, 16 + IV_LEN + 16);
    const encrypted = data.subarray(16 + IV_LEN + 16);

    const key = scryptSync(password, salt, KEY_LEN);

    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
}

export default function tsv2registers(type: RegisterType, fileNameOrText: string, password?: string): Register[] {
    if (fileNameOrText.toLowerCase().endsWith('.tsv')) {
        if (existsSync(fileNameOrText)) {
            fileNameOrText = readFileSync(fileNameOrText).toString();
        } else {
            throw new Error(`File name ${fileNameOrText} not found`);
        }
    } else if (fileNameOrText.toLowerCase().endsWith('tsv.enc')) {
        if (existsSync(fileNameOrText)) {
            fileNameOrText = readFileSync(fileNameOrText).toString();
            fileNameOrText = decrypt(fileNameOrText, password || '');
        } else {
            throw new Error(`File name ${fileNameOrText} not found`);
        }
    }
    let propsFields: RegisterField[] | undefined;

    if (type === 'coils') {
        propsFields = coils;
    } else if (type === 'inputRegs') {
        propsFields = inputRegs;
    } else if (type === 'holdingRegs') {
        propsFields = holdingRegs;
    } else if (type === 'disInputs') {
        propsFields = disInputs;
    }

    if (!propsFields) {
        throw new Error('Unknown register type');
    }

    const data: (string | boolean)[][] = tsv2json(
        fileNameOrText.endsWith('\n') ? fileNameOrText : `${fileNameOrText}\n`,
    );
    const fields = data.shift();
    if (fields) {
        for (const index in propsFields) {
            if (propsFields[index].name !== fields[index]) {
                throw new Error(`Unexpected field ${index} for ${fields[index]}`);
            }
        }
    }

    return data.map(itemValues => {
        const item: Register = {} as Register;
        for (const index in propsFields) {
            if (propsFields[index].type === 'checkbox') {
                itemValues[index] = itemValues[index] === 'true';
            }
            (item as unknown as Record<string, string | boolean | number>)[propsFields[index].name] = itemValues[index];
        }
        return item;
    });
}
