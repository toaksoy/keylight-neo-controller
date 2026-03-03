import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {KeyLightIndicator} from './keyLightIndicator.js';

export default class KeyLightControllerExtension {
    constructor(metadata) {
        this.uuid = metadata.uuid;
    }

    enable() {
        this._indicator = new KeyLightIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
