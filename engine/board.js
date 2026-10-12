"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAFE_SQUARES = exports.START = exports.HOME = exports.HOME_LANE_START = exports.LAST_LOOP_POS = exports.YARD = exports.LOOP_LENGTH = void 0;
exports.absIndex = absIndex;
exports.onLoop = onLoop;
exports.currentSeat = currentSeat;
exports.legalMoves = legalMoves;
exports.LOOP_LENGTH = 52;
exports.YARD = -1;
exports.LAST_LOOP_POS = 50; // relative positions 0..50 are on the shared loop
exports.HOME_LANE_START = 51; // 51..55 is the private home lane
exports.HOME = 56;
/** Absolute loop index of each colour's start square. */
exports.START = [0, 13, 26, 39];
/** Start squares plus the four star squares. Tokens here cannot be captured. */
exports.SAFE_SQUARES = new Set([0, 13, 26, 39, 8, 21, 34, 47]);
function absIndex(color, relPos) {
    return (exports.START[color] + relPos) % exports.LOOP_LENGTH;
}
function onLoop(relPos) {
    return relPos >= 0 && relPos <= exports.LAST_LOOP_POS;
}
function currentSeat(state) {
    return state.seats[state.turn];
}
/** Token indices the given colour may move with this dice value. */
function legalMoves(state, color, dice) {
    const out = [];
    const toks = state.tokens[color];
    for (let i = 0; i < 4; i++) {
        const p = toks[i];
        if (p === exports.YARD) {
            if (!state.config.sixToEnter || dice === 6)
                out.push(i);
        }
        else if (p + dice <= exports.HOME) {
            out.push(i);
        }
    }
    return out;
}
