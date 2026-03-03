import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {
    ACCESSORY_INFO_PATH,
    API_PATH,
    DEFAULT_PORT,
    HTTP_TIMEOUT_SECONDS,
} from './constants.js';

export class ElgatoClient {
    constructor(address, port = DEFAULT_PORT) {
        this._address = address;
        this._port = port;
        this._baseUrl = `http://${address}:${port}`;
        this._session = new Soup.Session();
        this._session.timeout = HTTP_TIMEOUT_SECONDS;
        this._textDecoder = new TextDecoder();
        this._textEncoder = new TextEncoder();
    }

    async getAccessoryInfo() {
        return this._requestJson('GET', ACCESSORY_INFO_PATH, null);
    }

    async getLights() {
        return this._requestJson('GET', API_PATH, null);
    }

    async setLights(lightPatch) {
        return this._requestJson('PUT', API_PATH, {
            numberOfLights: 1,
            lights: [lightPatch],
        });
    }

    destroy() {
        if (!this._session)
            return;
        this._session.abort();
        this._session = null;
    }

    async _requestJson(method, path, payload) {
        if (!this._session)
            throw new Error('Session is closed');

        const message = Soup.Message.new(method, `${this._baseUrl}${path}`);
        if (payload !== null) {
            const raw = this._textEncoder.encode(JSON.stringify(payload));
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(raw));
        }

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });

        if (message.status_code < 200 || message.status_code >= 300)
            throw new Error(`HTTP ${message.status_code} from ${this._baseUrl}${path}`);

        const data = this._textDecoder.decode(bytes.get_data());
        return JSON.parse(data);
    }
}
