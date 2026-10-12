"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGame = createGame;
exports.applyCommand = applyCommand;
exports.leaveGame = leaveGame;
exports.timeoutTurn = timeoutTurn;
exports.publicState = publicState;
const board_1 = require("./board");
const types_1 = require("./types");
const MAX_PROCESSED = 200;
class Draft {
    s;
    events = [];
    constructor(state) {
        this.s = JSON.parse(JSON.stringify(state)); // never mutate the caller's state
    }
    emit(e) {
        this.s.seq += 1;
        this.events.push({ ...e, seq: this.s.seq });
    }
    seatByColor(color) {
        return this.s.seats.find((x) => x.color === color);
    }
}
function createGame(players, config = {}, firstColor) {
    if (players.length < 2 || players.length > 4)
        throw new Error('A game needs 2 to 4 players');
    if (new Set(players.map((p) => p.playerId)).size !== players.length)
        throw new Error('Duplicate player');
    if (new Set(players.map((p) => p.color)).size !== players.length)
        throw new Error('Duplicate colour');
    const seats = [...players]
        .sort((a, b) => a.color - b.color)
        .map((p) => ({ playerId: p.playerId, color: p.color, left: false, timeouts: 0 }));
    const turn = firstColor === undefined ? 0 : seats.findIndex((x) => x.color === firstColor);
    if (turn < 0)
        throw new Error('firstColor is not a seated colour');
    return {
        version: 0, seq: 0, status: 'IN_PROGRESS', config: { ...types_1.DEFAULT_CONFIG, ...config }, seats,
        tokens: [0, 1, 2, 3].map(() => [board_1.YARD, board_1.YARD, board_1.YARD, board_1.YARD]),
        turn, phase: 'ROLL', dice: null, sixStreak: 0, winner: null, processed: [],
    };
}
function nextActiveIndex(s, from) {
    for (let step = 1; step <= s.seats.length; step++) {
        const i = (from + step) % s.seats.length;
        if (!s.seats[i].left)
            return i;
    }
    return from;
}
function advanceTurn(d) {
    d.s.turn = nextActiveIndex(d.s, d.s.turn);
    d.s.phase = 'ROLL';
    d.s.dice = null;
    d.s.sixStreak = 0;
    const seat = (0, board_1.currentSeat)(d.s);
    d.emit({ type: 'TURN_CHANGED', color: seat.color, playerId: seat.playerId });
}
function finish(d, color, reason) {
    const seat = d.seatByColor(color);
    d.s.status = 'FINISHED';
    d.s.winner = { color, playerId: seat.playerId, reason };
    d.s.phase = 'ROLL';
    d.s.dice = null;
    d.emit({ type: 'GAME_FINISHED', winnerColor: color, winnerPlayerId: seat.playerId, reason });
}
function fail(error) {
    return { ok: false, error };
}
/**
 * Deterministic transition: state + authenticated command (+ server dice) -> next state + events.
 * `serverDice` must come from the server's own secure RNG. It is the only dice source;
 * commands cannot carry a dice value.
 */
function applyCommand(state, cmd, serverDice) {
    if (state.status !== 'IN_PROGRESS')
        return fail('GAME_FINISHED');
    const seat = state.seats.find((x) => x.playerId === cmd.playerId && !x.left);
    if (!seat)
        return fail('NOT_A_PLAYER');
    if (typeof cmd.actionId !== 'string' || cmd.actionId.length === 0 || cmd.actionId.length > 64) {
        return fail('INVALID_ACTION_ID');
    }
    const key = `${cmd.playerId}:${cmd.actionId}`;
    if (state.processed.includes(key))
        return { ok: true, duplicate: true, state, events: [] };
    if (cmd.expectedVersion !== state.version)
        return fail('STALE_VERSION');
    if ((0, board_1.currentSeat)(state).playerId !== cmd.playerId)
        return fail('NOT_YOUR_TURN');
    const d = new Draft(state);
    const color = seat.color;
    const cfg = d.s.config;
    if (cmd.type === 'ROLL') {
        if (state.phase !== 'ROLL')
            return fail('WRONG_PHASE');
        if (serverDice === undefined)
            return fail('DICE_REQUIRED');
        if (!Number.isInteger(serverDice) || serverDice < 1 || serverDice > 6)
            return fail('INVALID_DICE');
        d.emit({ type: 'DICE_ROLLED', color, playerId: cmd.playerId, value: serverDice });
        d.s.sixStreak = serverDice === 6 ? d.s.sixStreak + 1 : 0;
        if (cfg.maxConsecutiveSixes > 0 && d.s.sixStreak >= cfg.maxConsecutiveSixes) {
            d.emit({ type: 'TURN_SKIPPED', color, reason: 'THREE_SIXES' });
            advanceTurn(d);
        }
        else if ((0, board_1.legalMoves)(d.s, color, serverDice).length === 0) {
            d.emit({ type: 'TURN_SKIPPED', color, reason: 'NO_LEGAL_MOVE' });
            advanceTurn(d);
        }
        else {
            d.s.dice = serverDice;
            d.s.phase = 'MOVE';
        }
    }
    else if (cmd.type === 'MOVE') {
        if (state.phase !== 'MOVE' || state.dice === null)
            return fail('WRONG_PHASE');
        if (!Number.isInteger(cmd.tokenIndex) || cmd.tokenIndex < 0 || cmd.tokenIndex > 3)
            return fail('INVALID_TOKEN');
        const dice = state.dice;
        if (!(0, board_1.legalMoves)(d.s, color, dice).includes(cmd.tokenIndex))
            return fail('ILLEGAL_MOVE');
        const toks = d.s.tokens[color];
        const from = toks[cmd.tokenIndex];
        const to = from === board_1.YARD ? 0 : from + dice;
        toks[cmd.tokenIndex] = to;
        d.emit({ type: 'TOKEN_MOVED', color, tokenIndex: cmd.tokenIndex, from, to });
        let captured = false;
        if ((0, board_1.onLoop)(to) && !board_1.SAFE_SQUARES.has((0, board_1.absIndex)(color, to))) {
            for (const other of d.s.seats) {
                if (other.color === color || other.left)
                    continue;
                const otherToks = d.s.tokens[other.color];
                for (let j = 0; j < 4; j++) {
                    const q = otherToks[j];
                    if ((0, board_1.onLoop)(q) && (0, board_1.absIndex)(other.color, q) === (0, board_1.absIndex)(color, to)) {
                        otherToks[j] = board_1.YARD;
                        captured = true;
                        d.emit({ type: 'TOKEN_CAPTURED', byColor: color, victimColor: other.color, tokenIndex: j });
                    }
                }
            }
        }
        if (toks.every((p) => p === board_1.HOME)) {
            finish(d, color, 'ALL_HOME');
        }
        else {
            const reason = dice === 6 && cfg.extraTurnOnSix ? 'SIX'
                : captured && cfg.extraTurnOnCapture ? 'CAPTURE'
                    : to === board_1.HOME && cfg.extraTurnOnFinish ? 'FINISH'
                        : null;
            if (reason) {
                d.emit({ type: 'EXTRA_TURN', color, reason });
                d.s.phase = 'ROLL';
                d.s.dice = null;
            }
            else {
                advanceTurn(d);
            }
        }
    }
    else {
        return fail('WRONG_PHASE');
    }
    d.seatByColor(color).timeouts = 0;
    d.s.version += 1;
    d.s.processed.push(key);
    if (d.s.processed.length > MAX_PROCESSED)
        d.s.processed.splice(0, d.s.processed.length - MAX_PROCESSED);
    return { ok: true, duplicate: false, state: d.s, events: d.events };
}
function removeSeat(d, seat, reason) {
    const wasCurrent = (0, board_1.currentSeat)(d.s).playerId === seat.playerId;
    seat.left = true;
    d.s.tokens[seat.color] = [board_1.YARD, board_1.YARD, board_1.YARD, board_1.YARD];
    d.emit({ type: 'PLAYER_LEFT', color: seat.color, playerId: seat.playerId, reason });
    const remaining = d.s.seats.filter((x) => !x.left);
    if (remaining.length <= 1) {
        const last = remaining[0];
        if (last)
            finish(d, last.color, 'LAST_PLAYER_STANDING');
        else
            d.s.status = 'FINISHED';
    }
    else if (wasCurrent) {
        advanceTurn(d);
    }
}
/** A player leaves or disconnects past the grace period (server-initiated, not a client command). */
function leaveGame(state, playerId) {
    if (state.status !== 'IN_PROGRESS')
        return fail('GAME_FINISHED');
    const seat = state.seats.find((x) => x.playerId === playerId && !x.left);
    if (!seat)
        return fail('NOT_A_PLAYER');
    const d = new Draft(state);
    removeSeat(d, d.seatByColor(seat.color), 'LEFT');
    d.s.version += 1;
    return { ok: true, duplicate: false, state: d.s, events: d.events };
}
/**
 * The turn deadline passed (server timer). Forfeits the current turn; after
 * `forfeitAfterTimeouts` consecutive timeouts the seat is removed.
 */
function timeoutTurn(state, expectedVersion) {
    if (state.status !== 'IN_PROGRESS')
        return fail('GAME_FINISHED');
    if (expectedVersion !== state.version)
        return fail('STALE_VERSION');
    const d = new Draft(state);
    const seat = d.seatByColor((0, board_1.currentSeat)(d.s).color);
    seat.timeouts += 1;
    d.emit({ type: 'TURN_SKIPPED', color: seat.color, reason: 'TIMEOUT' });
    if (seat.timeouts >= d.s.config.forfeitAfterTimeouts)
        removeSeat(d, seat, 'TIMEOUTS');
    else
        advanceTurn(d);
    d.s.version += 1;
    return { ok: true, duplicate: false, state: d.s, events: d.events };
}
/** Snapshot that is safe to send to clients (hides the idempotency log). Used for reconnect/resync. */
function publicState(state) {
    const { processed: _processed, ...rest } = state;
    return JSON.parse(JSON.stringify(rest));
}
