"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.secureDice = exports.publicState = exports.timeoutTurn = exports.leaveGame = exports.applyCommand = exports.createGame = void 0;
__exportStar(require("./types"), exports);
__exportStar(require("./board"), exports);
var engine_1 = require("./engine");
Object.defineProperty(exports, "createGame", { enumerable: true, get: function () { return engine_1.createGame; } });
Object.defineProperty(exports, "applyCommand", { enumerable: true, get: function () { return engine_1.applyCommand; } });
Object.defineProperty(exports, "leaveGame", { enumerable: true, get: function () { return engine_1.leaveGame; } });
Object.defineProperty(exports, "timeoutTurn", { enumerable: true, get: function () { return engine_1.timeoutTurn; } });
Object.defineProperty(exports, "publicState", { enumerable: true, get: function () { return engine_1.publicState; } });
var dice_1 = require("./dice");
Object.defineProperty(exports, "secureDice", { enumerable: true, get: function () { return dice_1.secureDice; } });
