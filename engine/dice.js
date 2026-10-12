"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.secureDice = secureDice;
const node_crypto_1 = require("node:crypto");
/** Server-side secure dice. Call this only on the server, once per accepted ROLL. */
function secureDice() {
    return (0, node_crypto_1.randomInt)(1, 7);
}
