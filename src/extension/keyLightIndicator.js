import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {ElgatoClient} from './elgatoClient.js';
import {AvahiDiscovery} from './avahiDiscovery.js';
import {
    AVAHI_SERVICE_TYPE,
    AVAHI_SERVICE_DOMAIN,
    BRIGHTNESS_MIN,
    BRIGHTNESS_MAX,
    KELVIN_MIN,
    KELVIN_MAX,
    MIRED_MIN,
    MIRED_MAX,
    POLL_INTERVAL_SECONDS,
    UPDATE_DEBOUNCE_MS,
    DISCOVERY_TIMEOUT_SECONDS,
    ELGATO_HTTP_PORT,
    SUBNET_SCAN_MAX_HOSTS,
    SUBNET_SCAN_CONCURRENCY,
    BRIGHTNESS_STEP,
    DEFAULT_DEVICE_BRIGHTNESS_MAX,
    BRIGHTNESS_COLOR_LOW,
    BRIGHTNESS_COLOR_HIGH,
    TEMPERATURE_COLOR_WARM,
    TEMPERATURE_COLOR_COOL,
} from './constants.js';
import {
    clamp,
    snapToStep,
    mixRgb,
    rgbToCss,
    miredToKelvin,
    kelvinToMired,
} from './utils.js';

export const KeyLightIndicator = GObject.registerClass(
class KeyLightIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Key Light Controller');

        this._devices = new Map();
        this._pollSourceId = 0;
        this._discoveryTimeoutId = 0;
        this._probedDiscoveryAddresses = new Set();

        this.add_child(new St.Icon({
            icon_name: 'display-brightness-symbolic',
            style_class: 'system-status-icon',
        }));

        this._statusItem = new PopupMenu.PopupMenuItem('Discovering Key Lights...', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._statusItem);

        this._devicesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._devicesSection);

        this._discovery = new AvahiDiscovery(
            device => this._ensureDevice(device),
            deviceId => this._removeDevice(deviceId),
            error => this._setStatus(`Discovery error: ${error.message}`)
        );
        this._startDiscovery('Discovering Key Lights...');

        this._pollSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => this._pollAllDevices()
        );
    }

    destroy() {
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = 0;
        }

        this._clearDiscoveryTimeout();

        if (this._discovery)
            this._discovery.stop();

        for (const device of this._devices.values()) {
            this._clearPendingTimeouts(device);
            device.client?.destroy?.();
        }
        this._devices.clear();

        super.destroy();
    }

    _setStatus(text) {
        this._statusItem.label.text = text;
    }

    _setDeviceCountStatus() {
        const count = this._devices.size;
        const noun = count === 1 ? 'device' : 'devices';
        this._setStatus(`${count} ${noun} found`);
    }

    _startDiscovery(statusText) {
        this._setStatus(statusText);
        this._probedDiscoveryAddresses.clear();
        this._discovery.start();
        this._armDiscoveryTimeout();
        this._scanViaAvahiBrowse();
        this._scanNeighborsForKeyLights();
        this._scanLocalSubnetForKeyLights();
    }

    _armDiscoveryTimeout() {
        this._clearDiscoveryTimeout();
        this._discoveryTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            DISCOVERY_TIMEOUT_SECONDS,
            () => {
                this._discoveryTimeoutId = 0;
                if (this._devices.size === 0)
                    this._setStatus('No Key Light devices found');
                else
                    this._setDeviceCountStatus();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _clearDiscoveryTimeout() {
        if (this._discoveryTimeoutId) {
            GLib.source_remove(this._discoveryTimeoutId);
            this._discoveryTimeoutId = 0;
        }
    }

    async _scanViaAvahiBrowse() {
        try {
            const proc = Gio.Subprocess.new(
                ['avahi-browse', '-rtp', AVAHI_SERVICE_TYPE],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            const [ok, stdoutBytes, stderrBytes] = await new Promise((resolve, reject) => {
                proc.communicate_async(null, null, (p, result) => {
                    try {
                        resolve(p.communicate_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            if (!ok)
                return;

            const stdout = new TextDecoder().decode(stdoutBytes.get_data());
            const stderr = new TextDecoder().decode(stderrBytes.get_data());
            if (stderr && stderr.trim().length > 0)
                log(`[${this.constructor.name}] avahi-browse stderr: ${stderr.trim()}`);

            const lines = stdout.split('\n');
            for (const line of lines) {
                // Parseable mode:
                // =;iface;proto;name;_elg._tcp;local;host.local;192.168.x.x;9123;txt
                if (!line.startsWith('=;'))
                    continue;

                const parts = line.split(';');
                if (parts.length < 9)
                    continue;

                const name = parts[3];
                const type = parts[4];
                const domain = parts[5];
                const host = parts[6];
                const address = parts[7];
                const port = Number(parts[8]);

                if (type !== AVAHI_SERVICE_TYPE || domain !== AVAHI_SERVICE_DOMAIN)
                    continue;
                if (!address || !Number.isFinite(port) || port <= 0)
                    continue;

                this._ensureDevice({
                    id: `${address}:${port}`,
                    address,
                    port,
                    name,
                    host,
                });
            }
        } catch (error) {
            logError(error, `${this.constructor.name}: avahi-browse scan failed`);
        }
    }

    async _scanNeighborsForKeyLights() {
        try {
            const proc = Gio.Subprocess.new(
                ['ip', '-4', 'neigh', 'show'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            const [ok, stdoutBytes] = await new Promise((resolve, reject) => {
                proc.communicate_async(null, null, (p, result) => {
                    try {
                        resolve(p.communicate_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            if (!ok)
                return;

            const stdout = new TextDecoder().decode(stdoutBytes.get_data());
            const candidates = new Set();
            for (const line of stdout.split('\n')) {
                // Example: 192.168.68.74 dev wlp0s20f3 lladdr xx:xx:xx:xx:xx:xx REACHABLE
                const ip = line.split(' ')[0]?.trim();
                if (ip && this._isIPv4(ip))
                    candidates.add(ip);
            }

            const probes = [];
            for (const ip of candidates)
                probes.push(this._probePotentialKeyLight(ip));

            await Promise.allSettled(probes);
        } catch (error) {
            logError(error, `${this.constructor.name}: neighbor scan failed`);
        }
    }

    async _scanLocalSubnetForKeyLights() {
        try {
            const proc = Gio.Subprocess.new(
                ['ip', '-4', '-o', 'addr', 'show', 'scope', 'global'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            const [ok, stdoutBytes] = await new Promise((resolve, reject) => {
                proc.communicate_async(null, null, (p, result) => {
                    try {
                        resolve(p.communicate_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            if (!ok)
                return;

            const stdout = new TextDecoder().decode(stdoutBytes.get_data());
            const candidates = new Set();

            for (const line of stdout.split('\n')) {
                const match = line.match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\b/);
                if (!match)
                    continue;

                const localIp = match[1];
                const prefix = Number(match[2]);
                if (!this._isIPv4(localIp) || !Number.isFinite(prefix) || prefix < 0 || prefix > 32)
                    continue;

                // Avoid excessively large scans on unusual networks.
                if (prefix < 23)
                    continue;

                const hostIps = this._expandSubnetHosts(localIp, prefix, SUBNET_SCAN_MAX_HOSTS);
                for (const ip of hostIps) {
                    if (ip !== localIp)
                        candidates.add(ip);
                }
            }

            const addresses = [...candidates];
            await this._runWithConcurrency(addresses, SUBNET_SCAN_CONCURRENCY, async ip => {
                await this._probePotentialKeyLight(ip);
            });
        } catch (error) {
            logError(error, `${this.constructor.name}: subnet scan failed`);
        }
    }

    _isIPv4(value) {
        const parts = value.split('.');
        if (parts.length !== 4)
            return false;
        for (const part of parts) {
            if (!/^\d+$/.test(part))
                return false;
            const n = Number(part);
            if (n < 0 || n > 255)
                return false;
        }
        return true;
    }

    _ipv4ToInt(ip) {
        const parts = ip.split('.').map(Number);
        return ((((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
    }

    _intToIpv4(value) {
        return [
            (value >>> 24) & 255,
            (value >>> 16) & 255,
            (value >>> 8) & 255,
            value & 255,
        ].join('.');
    }

    _expandSubnetHosts(localIp, prefix, maxHosts) {
        if (prefix >= 31)
            return [];

        const hostBits = 32 - prefix;
        const maxSubnetHosts = Math.pow(2, hostBits) - 2;
        const hostCount = Math.min(maxSubnetHosts, maxHosts);
        if (hostCount <= 0)
            return [];

        const localInt = this._ipv4ToInt(localIp);
        const mask = (0xFFFFFFFF << hostBits) >>> 0;
        const network = localInt & mask;
        const out = [];

        for (let i = 1; i <= hostCount; i++)
            out.push(this._intToIpv4((network + i) >>> 0));

        return out;
    }

    async _runWithConcurrency(items, concurrency, worker) {
        let index = 0;
        const runner = async () => {
            while (index < items.length) {
                const current = index;
                index++;
                try {
                    await worker(items[current]);
                } catch (_error) {
                    // Ignore individual probe errors.
                }
            }
        };

        const workers = [];
        const count = Math.max(1, Math.min(concurrency, items.length));
        for (let i = 0; i < count; i++)
            workers.push(runner());
        await Promise.allSettled(workers);
    }

    async _probePotentialKeyLight(address) {
        if (this._probedDiscoveryAddresses.has(address))
            return;
        this._probedDiscoveryAddresses.add(address);

        const client = new ElgatoClient(address, ELGATO_HTTP_PORT);
        try {
            const info = await client.getAccessoryInfo();
            const productName = `${info?.productName ?? ''}`.toLowerCase();
            const preferredDisplayName = `${info?.displayName ?? ''}`.trim();
            const fallbackName = `${info?.productName ?? ''}`.trim();
            const displayName = preferredDisplayName || fallbackName || `Key Light (${address})`;

            // Accept known Elgato products; this avoids false positives on random hosts.
            if (!productName.includes('key light') && !productName.includes('elgato'))
                return;

            this._ensureDevice({
                id: `${address}:${ELGATO_HTTP_PORT}`,
                address,
                port: ELGATO_HTTP_PORT,
                name: displayName,
                host: '',
            });
        } catch (_error) {
            // Expected for most non-Key-Light neighbors; ignore quietly.
        } finally {
            client.destroy();
        }
    }

    _ensureDevice(deviceInfo) {
        if (this._devices.has(deviceInfo.id)) {
            this._clearDiscoveryTimeout();
            this._setDeviceCountStatus();
            return;
        }

        const client = new ElgatoClient(deviceInfo.address, deviceInfo.port);
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'keylight-device-card',
            x_expand: true,
        });
        item.add_child(card);

        const topRow = new St.BoxLayout({
            style_class: 'keylight-top-row',
            x_expand: true,
        });
        const title = new St.Label({
            text: deviceInfo.name,
            style_class: 'keylight-device-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const detailsButtonLabel = new St.Label({
            text: 'Details',
        });
        const detailsButton = new St.Button({
            child: detailsButtonLabel,
            style_class: 'keylight-details-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const powerSwitch = new PopupMenu.Switch(false);
        const powerButton = new St.Button({
            child: powerSwitch,
            style_class: 'keylight-power-button',
            toggle_mode: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(powerButton);
        topRow.add_child(title);
        topRow.add_child(detailsButton);
        card.add_child(topRow);

        const detailsBox = new St.BoxLayout({
            vertical: true,
            visible: false,
            style_class: 'keylight-details-box',
            x_expand: true,
        });
        const detailsLabel = new St.Label({
            text: 'No details loaded yet.',
            style_class: 'keylight-details-label',
            x_expand: true,
        });
        detailsLabel.clutter_text.line_wrap = true;
        detailsBox.add_child(detailsLabel);
        card.add_child(detailsBox);

        const brightnessLabel = new St.Label({
            text: 'Brightness 0%',
            style_class: 'keylight-label',
        });
        card.add_child(brightnessLabel);
        const brightnessSlider = new Slider.Slider(0);
        brightnessSlider.add_style_class_name('keylight-slider');
        brightnessSlider.x_expand = true;
        const brightnessRow = new St.BoxLayout({
            style_class: 'keylight-slider-row',
            x_expand: true,
        });
        const brightnessIcon = new St.Label({
            text: '💡',
            style_class: 'keylight-slider-emoji',
            y_align: Clutter.ActorAlign.CENTER,
        });
        brightnessRow.add_child(brightnessIcon);
        brightnessRow.add_child(brightnessSlider);
        card.add_child(brightnessRow);

        const temperatureLabel = new St.Label({
            text: 'Temperature 2900K',
            style_class: 'keylight-label',
        });
        card.add_child(temperatureLabel);
        const temperatureSlider = new Slider.Slider(0);
        temperatureSlider.add_style_class_name('keylight-slider');
        temperatureSlider.x_expand = true;
        const temperatureRow = new St.BoxLayout({
            style_class: 'keylight-slider-row',
            x_expand: true,
        });
        const temperatureIcon = new St.Label({
            text: '🌡️',
            style_class: 'keylight-slider-emoji',
            y_align: Clutter.ActorAlign.CENTER,
        });
        temperatureRow.add_child(temperatureIcon);
        temperatureRow.add_child(temperatureSlider);
        card.add_child(temperatureRow);

        this._devicesSection.addMenuItem(item);

        const device = {
            ...deviceInfo,
            client,
            item,
            title,
            powerSwitch,
            powerButton,
            detailsButton,
            detailsButtonLabel,
            detailsBox,
            detailsLabel,
            brightnessLabel,
            brightnessSlider,
            brightnessIcon,
            temperatureLabel,
            temperatureSlider,
            temperatureIcon,
            brightnessTimeoutId: 0,
            temperatureTimeoutId: 0,
            suppressUiEvents: false,
            brightnessMax: DEFAULT_DEVICE_BRIGHTNESS_MAX,
            temperatureUnit: 'mired',
            accessoryInfo: null,
            state: null,
        };

        powerButton.connect('clicked', () => this._setPower(device.id, !device.powerSwitch.state));
        detailsButton.connect('clicked', () => this._toggleDeviceDetails(device.id));

        brightnessSlider.connect('notify::value', () => {
            if (device.suppressUiEvents)
                return;
            const brightnessStep = device.brightnessMax <= 50 ? 1 : BRIGHTNESS_STEP;
            const brightness = snapToStep(
                Math.round(clamp(device.brightnessSlider.value, 0, 1) * device.brightnessMax),
                brightnessStep,
                BRIGHTNESS_MIN,
                device.brightnessMax
            );
            this._applyBrightnessVisuals(device, brightness);
            const normalizedBrightness = Math.round((brightness / Math.max(1, device.brightnessMax)) * 100);
            device.brightnessLabel.text = `Brightness ${normalizedBrightness}%`;
            this._debounceDeviceUpdate(device.id, 'brightness', brightness);
        });

        temperatureSlider.connect('notify::value', () => {
            if (device.suppressUiEvents)
                return;
            const kelvin = Math.round(
                KELVIN_MIN + clamp(device.temperatureSlider.value, 0, 1) * (KELVIN_MAX - KELVIN_MIN)
            );
            const temperatureValue = device.temperatureUnit === 'kelvin'
                ? kelvin
                : kelvinToMired(kelvin);
            this._applyTemperatureVisuals(device, kelvin);
            device.temperatureLabel.text = `Temperature ${kelvin}K`;
            this._debounceDeviceUpdate(device.id, 'temperature', temperatureValue);
        });

        this._devices.set(device.id, device);
        this._clearDiscoveryTimeout();
        this._setDeviceCountStatus();
        this._refreshDevice(device.id);
    }

    _removeDevice(deviceId) {
        const device = this._devices.get(deviceId);
        if (!device)
            return;

        this._clearPendingTimeouts(device);
        device.client?.destroy?.();
        device.item.destroy();
        this._devices.delete(deviceId);

        if (this._devices.size === 0)
            this._setStatus('No Key Light devices found');
        else
            this._setDeviceCountStatus();
    }

    _clearPendingTimeouts(device) {
        if (device.brightnessTimeoutId) {
            GLib.source_remove(device.brightnessTimeoutId);
            device.brightnessTimeoutId = 0;
        }

        if (device.temperatureTimeoutId) {
            GLib.source_remove(device.temperatureTimeoutId);
            device.temperatureTimeoutId = 0;
        }
    }

    _debounceDeviceUpdate(deviceId, field, value) {
        const device = this._devices.get(deviceId);
        if (!device)
            return;

        const timeoutKey = field === 'brightness' ? 'brightnessTimeoutId' : 'temperatureTimeoutId';
        if (device[timeoutKey]) {
            GLib.source_remove(device[timeoutKey]);
            device[timeoutKey] = 0;
        }

        device[timeoutKey] = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            UPDATE_DEBOUNCE_MS,
            () => {
                device[timeoutKey] = 0;
                this._updateLightState(deviceId, {[field]: value});
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _setPower(deviceId, on) {
        this._updateLightState(deviceId, {on: on ? 1 : 0});
    }

    _toggleDeviceDetails(deviceId) {
        const device = this._devices.get(deviceId);
        if (!device)
            return;

        const nextVisible = !device.detailsBox.visible;
        device.detailsBox.visible = nextVisible;
        device.detailsButtonLabel.text = nextVisible ? 'Hide' : 'Details';
    }

    _formatAccessoryDetails(device, info) {
        const display = value => {
            if (value === undefined || value === null)
                return 'Unknown';
            const text = `${value}`.trim();
            return text.length > 0 ? text : 'Unknown';
        };

        const firmware = info?.firmwareVersion
            ? `${info.firmwareVersion}${info?.firmwareBuildNumber ? ` (build ${info.firmwareBuildNumber})` : ''}`
            : 'Unknown';

        return [
            `IP: ${display(device.address)}`,
            `MAC: ${display(info?.macAddress)}`,
            `Serial: ${display(info?.serialNumber)}`,
            `Firmware: ${display(firmware)}`,
            `Hardware Revision: ${display(info?.hardwareRevision)}`,
            `Board Type: ${display(info?.hardwareBoardType)}`,
        ].join('\n');
    }

    _setAccessoryDetails(device, info) {
        device.accessoryInfo = info;
        device.detailsLabel.text = this._formatAccessoryDetails(device, info);
    }

    async _updateLightState(deviceId, patch) {
        const device = this._devices.get(deviceId);
        if (!device)
            return;

        try {
            const response = await device.client.setLights(patch);
            const state = response?.lights?.[0];
            if (state)
                this._renderDeviceState(device, state);
        } catch (error) {
            if (Object.prototype.hasOwnProperty.call(patch, 'brightness') && `${error.message}`.includes('HTTP 404')) {
                try {
                    const brightnessStep = device.brightnessMax <= 50 ? 1 : 10;
                    const fallbackBrightness = snapToStep(
                        Number(patch.brightness),
                        brightnessStep,
                        BRIGHTNESS_MIN,
                        device.brightnessMax
                    );
                    const fullPayload = {
                        on: device.state?.on ?? 1,
                        brightness: fallbackBrightness,
                        temperature: device.state?.temperature ?? (
                            device.temperatureUnit === 'kelvin' ? 4000 : kelvinToMired(4000)
                        ),
                    };
                    const retry = await device.client.setLights(fullPayload);
                    const retryState = retry?.lights?.[0];
                    if (retryState) {
                        this._renderDeviceState(device, retryState);
                        return;
                    }
                } catch (_retryError) {
                    // Fall through to status below.
                }
            }
            this._setStatus(`Failed to update ${device.name}: ${error.message}`);
        }
    }

    async _refreshDevice(deviceId) {
        const device = this._devices.get(deviceId);
        if (!device)
            return;

        try {
            let displayName = device.name;
            let accessoryInfo = null;
            try {
                accessoryInfo = await device.client.getAccessoryInfo();
                const preferredDisplayName = `${accessoryInfo?.displayName ?? ''}`.trim();
                const productName = `${accessoryInfo?.productName ?? ''}`.trim();
                const maxBrightness = Number(accessoryInfo?.['power-info']?.maximumBrightness);
                if (Number.isFinite(maxBrightness) && maxBrightness > 0)
                    device.brightnessMax = clamp(Math.round(maxBrightness), 1, BRIGHTNESS_MAX);

                if (preferredDisplayName.length > 0)
                    displayName = preferredDisplayName;
                else if (productName.length > 0)
                    displayName = productName;
            } catch (_error) {
                // Accessory-info may not be available on all firmware; keep discovered name.
            }

            device.name = displayName;
            device.title.text = displayName;
            if (accessoryInfo)
                this._setAccessoryDetails(device, accessoryInfo);
            const lights = await device.client.getLights();
            const state = lights?.lights?.[0];
            if (state)
                this._renderDeviceState(device, state);
        } catch (error) {
            this._setStatus(`Failed to query ${device.name}: ${error.message}`);
        }
    }

    _renderDeviceState(device, state) {
        const on = state.on === 1;
        const brightnessMax = clamp(device.brightnessMax ?? DEFAULT_DEVICE_BRIGHTNESS_MAX, 1, BRIGHTNESS_MAX);
        const brightness = clamp(Number(state.brightness ?? 0), BRIGHTNESS_MIN, brightnessMax);
        const rawTemperature = Number(state.temperature ?? MIRED_MAX);
        let mired = MIRED_MAX;
        let temperatureUnit = 'mired';
        if (Number.isFinite(rawTemperature) && rawTemperature > 1000) {
            // Some firmwares expose Kelvin directly instead of mired.
            temperatureUnit = 'kelvin';
            mired = kelvinToMired(rawTemperature);
        } else {
            mired = clamp(rawTemperature, MIRED_MIN, MIRED_MAX);
        }
        const kelvin = miredToKelvin(mired);

        device.temperatureUnit = temperatureUnit;
        device.state = {
            on: on ? 1 : 0,
            brightness,
            temperature: temperatureUnit === 'kelvin' ? kelvin : mired,
        };

        device.suppressUiEvents = true;
        this._setPowerSwitchState(device.powerSwitch, on);
        device.powerButton.checked = on;
        device.brightnessSlider.value = brightness / brightnessMax;
        device.temperatureSlider.value = (kelvin - KELVIN_MIN) / (KELVIN_MAX - KELVIN_MIN);
        device.suppressUiEvents = false;

        const normalizedBrightness = Math.round((brightness / brightnessMax) * 100);
        device.brightnessLabel.text = `Brightness ${normalizedBrightness}%`;
        device.temperatureLabel.text = `Temperature ${kelvin}K`;
        this._applyBrightnessVisuals(device, brightness);
        this._applyTemperatureVisuals(device, kelvin);
        this._setDeviceCountStatus();
    }

    _applyBrightnessVisuals(device, brightness) {
        const max = Math.max(1, device.brightnessMax ?? DEFAULT_DEVICE_BRIGHTNESS_MAX);
        const ratio = clamp(brightness / max, 0, 1);
        const color = rgbToCss(mixRgb(BRIGHTNESS_COLOR_LOW, BRIGHTNESS_COLOR_HIGH, ratio));
        this._setSliderAccent(device.brightnessSlider, color);
        device.brightnessIcon.set_style(`color: ${color};`);
    }

    _applyTemperatureVisuals(device, kelvin) {
        const ratio = clamp((kelvin - KELVIN_MIN) / (KELVIN_MAX - KELVIN_MIN), 0, 1);
        const color = rgbToCss(mixRgb(TEMPERATURE_COLOR_WARM, TEMPERATURE_COLOR_COOL, ratio));
        this._setSliderAccent(device.temperatureSlider, color);
        device.temperatureIcon.set_style(`color: ${color};`);
    }

    _setSliderAccent(slider, colorCss) {
        // BarLevel/Slider theme key; supported on modern GNOME Shell versions.
        slider.set_style(`-barlevel-active-background-color: ${colorCss};`);
    }

    _setPowerSwitchState(powerSwitch, on) {
        // PopupMenu.Switch API differs slightly between GNOME Shell versions.
        if (typeof powerSwitch.setToggleState === 'function') {
            powerSwitch.setToggleState(on);
            return;
        }

        if (typeof powerSwitch.set_state === 'function') {
            powerSwitch.set_state(on);
            return;
        }

        if ('state' in powerSwitch) {
            powerSwitch.state = on;
            return;
        }

        log(`[${this.constructor.name}] Unable to set switch state via known API`);
    }

    _pollAllDevices() {
        for (const deviceId of this._devices.keys())
            this._refreshDevice(deviceId);

        return GLib.SOURCE_CONTINUE;
    }
});
