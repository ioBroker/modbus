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
const regTypes = {
    coils,
    disInputs,
    holdingRegs,
    inputRegs,
};

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
    const propsFields = regTypes[type];

    if (!propsFields) {
        throw new Error('Unknown register type');
    }

    const data: (string | boolean)[][] = tsv2json(
        fileNameOrText.endsWith('\n') ? fileNameOrText : `${fileNameOrText}\n`,
    );
    const fields = data.shift();
    if (fields) {
        for (const field of fields) {
            if (!propsFields.find(it => it.name === field)) {
                throw new Error(`Unexpected field ${field}`);
            }
        }
    } else {
        throw new Error('No fields found');
    }

    return data.map(itemValues => {
        const item: Register = {} as Register;
        for (let f = 0; f < itemValues.length; f++) {
            const field = fields[f];
            const prop = propsFields.find(it => it.name === field);
            if (!prop) {
                // cannot happen due to check before
                continue;
            }
            if (prop.type === 'checkbox') {
                itemValues[f] = itemValues[f] === 'true';
            }
            (item as unknown as Record<string, string | boolean | number>)[prop.name] = itemValues[f];
        }
        return item;
    });
}
